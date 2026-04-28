import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
} from "@aws-sdk/client-apigatewaymanagementapi";
import { sendFcmNotification } from "./fcmHelper.js";
import pg from "pg";
import jwt from "jsonwebtoken";

const { Pool } = pg;
const secretsClient = new SecretsManagerClient({ region: "ap-south-1" });
const dynamoClient = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: "ap-south-1" }),
);

const WS_ENDPOINT = process.env.WS_ENDPOINT;

let pool = null;
let jwtSecret = null;

// ─── Shared Setup ────────────────────────────────────────────

const getDbCredentials = async () => {
  const response = await secretsClient.send(
    new GetSecretValueCommand({ SecretId: "mentortalk/db-app-credentials" }),
  );
  return JSON.parse(response.SecretString);
};

const getJwtSecret = async () => {
  if (jwtSecret) return jwtSecret;
  const response = await secretsClient.send(
    new GetSecretValueCommand({ SecretId: "mentortalk/jwt-secret" }),
  );
  jwtSecret = JSON.parse(response.SecretString).secret;
  return jwtSecret;
};

const getPool = async () => {
  if (pool) return pool;
  const creds = await getDbCredentials();
  pool = new Pool({
    host: creds.host,
    port: creds.port,
    database: creds.database,
    user: creds.username,
    password: creds.password,
    ssl: { rejectUnauthorized: false },
    max: 5,
  });
  return pool;
};

const verifyToken = async (authHeader) => {
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    throw new Error("Missing or invalid authorization header");
  }
  const token = authHeader.split(" ")[1];
  const secret = await getJwtSecret();
  return jwt.verify(token, secret);
};

const respond = (statusCode, body) => ({
  statusCode,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

// ─── WebSocket Push Helper (with FCM fallback) ──────────────

async function pushToUser(userId, payload, fcmOptions = null) {
  const conn = await dynamoClient.send(
    new GetCommand({
      TableName: "mentortalk-connections",
      Key: { user_id: userId },
    }),
  );

  if (conn.Item) {
    const apiClient = new ApiGatewayManagementApiClient({
      endpoint: WS_ENDPOINT,
    });
    try {
      await apiClient.send(
        new PostToConnectionCommand({
          ConnectionId: conn.Item.connection_id,
          Data: Buffer.from(JSON.stringify(payload)),
        }),
      );
      console.log(`Pushed to user ${userId} via WebSocket`);
    } catch (err) {
      if (err.statusCode === 410) {
        console.log(`Stale connection for user ${userId}, cleaning up`);
      }
      console.error(`Failed to push to user ${userId}:`, err.message);
    }
  } else {
    console.log(`User ${userId} is not connected via WebSocket`);
  }

  if (fcmOptions) {
    await sendFcmNotification(userId, fcmOptions);
  }
}

// ─── Welcome Message ─────────────────────────────────────────

const WELCOME_MESSAGE = "Hi! How can we help you today?";

// ─── Route Handler ───────────────────────────────────────────

export const handler = async (event) => {
  console.log("Support event:", JSON.stringify(event));

  try {
    const authHeader =
      event.headers?.Authorization || event.headers?.authorization;
    const decoded = await verifyToken(authHeader);
    const userId = decoded.sub;
    const app = decoded.app || "mentee";

    const method = event.httpMethod;
    const path = event.resource || event.path;

    if (method === "GET" && path === "/support/messages") {
      return await handleGetMessages(userId, app, event);
    }

    if (method === "POST" && path === "/support/messages") {
      return await handleSendMessage(userId, app, event);
    }

    return respond(404, { error: "Not found" });
  } catch (err) {
    if (
      err.name === "JsonWebTokenError" ||
      err.name === "TokenExpiredError" ||
      err.message.includes("authorization header")
    ) {
      return respond(401, { error: "Unauthorized" });
    }
    console.error("Unhandled error:", err);
    return respond(500, { error: "Internal server error" });
  }
};

// ─── GET /support/messages ───────────────────────────────────

async function handleGetMessages(userId, app, event) {
  const db = await getPool();
  const params = event.queryStringParameters || {};
  const limit = Math.min(parseInt(params.limit) || 30, 50);
  const before = params.before || null;

  // Auto-create ticket + welcome on first open (or after resolve)
  if (!before) {
    const openTicket = await db.query(
      `SELECT id FROM support_ticket WHERE user_id = $1 AND app = $2 AND status = 'open' LIMIT 1`,
      [userId, app],
    );

    if (openTicket.rows.length === 0) {
      const ticketCount = await db.query(
        `SELECT COUNT(*)::int AS total FROM support_ticket WHERE user_id = $1 AND app = $2`,
        [userId, app],
      );
      const isFirstTicket = ticketCount.rows[0].total === 0;

      const client = await db.connect();
      try {
        await client.query("BEGIN");

        const newTicket = await client.query(
          `INSERT INTO support_ticket (user_id, app) VALUES ($1, $2) RETURNING id, ticket_number`,
          [userId, app],
        );
        const ticketId = newTicket.rows[0].id;
        const ticketNumber = newTicket.rows[0].ticket_number;

        await client.query(
          `INSERT INTO support_message (user_id, ticket_id, sender_type, content, type, created_at)
           VALUES ($1, $2, 'system', $3, 'system', NOW())`,
          [userId, ticketId, `Ticket opened · #${ticketNumber}`],
        );

        if (isFirstTicket) {
          await client.query(
            `INSERT INTO support_message (user_id, ticket_id, sender_type, content, type, created_at)
             VALUES ($1, $2, 'admin', $3, 'text', NOW() + INTERVAL '1 millisecond')`,
            [userId, ticketId, WELCOME_MESSAGE],
          );
        }

        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        if (err.code !== "23505") throw err;
      } finally {
        client.release();
      }
    }
  }

  let query;
  let queryParams;

  if (before) {
    query = `
    SELECT m.id, m.sender_type, m.sender_id, m.content, m.type, m.created_at
    FROM support_message m
    JOIN support_ticket t ON t.id = m.ticket_id
    WHERE m.user_id = $1 AND t.app = $2 AND m.created_at < $3
    ORDER BY m.created_at DESC
    LIMIT $4`;
    queryParams = [userId, app, before, limit];
  } else {
    query = `
    SELECT m.id, m.sender_type, m.sender_id, m.content, m.type, m.created_at
    FROM support_message m
    JOIN support_ticket t ON t.id = m.ticket_id
    WHERE m.user_id = $1 AND t.app = $2
    ORDER BY m.created_at DESC
    LIMIT $3`;
    queryParams = [userId, app, limit];
  }

  const result = await db.query(query, queryParams);

  const messages = result.rows.map((row) => ({
    message_id: row.id,
    sender_id: row.sender_type === "system" ? "system" : row.sender_id,
    sender_type: row.sender_type,
    content: row.content,
    type: row.type,
    created_at: row.created_at.toISOString(),
  }));

  const response = {
    messages,
    count: messages.length,
    has_more: messages.length === limit,
  };

  // Cursor for next page
  if (messages.length > 0) {
    response.next_before = messages[messages.length - 1].created_at;
  }

  return respond(200, response);
}

// ─── POST /support/messages ──────────────────────────────────

async function handleSendMessage(userId, app, event) {
  const body = JSON.parse(event.body || "{}");
  const { content } = body;

  if (!content || !content.trim()) {
    return respond(400, { error: "content is required" });
  }

  const db = await getPool();
  const client = await db.connect();

  try {
    await client.query("BEGIN");

    // 1. Check for open ticket
    const ticketResult = await client.query(
      `SELECT id FROM support_ticket
       WHERE user_id = $1 AND app = $2 AND status = 'open'
       LIMIT 1`,
      [userId, app],
    );

    let ticketId;
    const newMessages = [];

    if (ticketResult.rows.length === 0) {
      // 2a. No open ticket — create one + system message + welcome message

      const newTicket = await client.query(
        `INSERT INTO support_ticket (user_id, app)
         VALUES ($1, $2)
         RETURNING id, ticket_number`,
        [userId, app],
      );
      ticketId = newTicket.rows[0].id;
      const ticketNumber = newTicket.rows[0].ticket_number;

      // "Ticket opened" system message
      const ticketOpenedMsg = await client.query(
        `INSERT INTO support_message (user_id, ticket_id, sender_type, content, type, created_at)
         VALUES ($1, $2, 'system', $3, 'system', NOW())
         RETURNING id, sender_type, content, type, created_at`,
        [userId, ticketId, `Ticket opened · #${ticketNumber}`],
      );
      newMessages.push(ticketOpenedMsg.rows[0]);

      // Welcome only on first ever ticket
      const prevTickets = await client.query(
        `SELECT COUNT(*)::int AS total FROM support_ticket WHERE user_id = $1 AND app = $2 AND id != $3`,
        [userId, app, ticketId],
      );
      if (prevTickets.rows[0].total === 0) {
        const welcomeMsg = await client.query(
          `INSERT INTO support_message (user_id, ticket_id, sender_type, content, type)
         VALUES ($1, $2, 'admin', $3, 'text')
         RETURNING id, sender_type, content, type, created_at`,
          [userId, ticketId, WELCOME_MESSAGE],
        );
        newMessages.push(welcomeMsg.rows[0]);
      }
    } else {
      // 2b. Open ticket exists — use it
      ticketId = ticketResult.rows[0].id;
    }

    // 3. Insert the user's message (offset to ensure ordering after system + welcome messages)
    const userMsg = await client.query(
      `INSERT INTO support_message (user_id, ticket_id, sender_type, sender_id, content, type, created_at)
       VALUES ($1, $2, 'user', $1, $3, 'text', NOW() + INTERVAL '2 milliseconds')
       RETURNING id, sender_type, sender_id, content, type, created_at`,
      [userId, ticketId, content.trim()],
    );
    newMessages.push(userMsg.rows[0]);

    await client.query("COMMIT");

    // 4. Format response
    const responseMessages = newMessages.map((row) => ({
      message_id: row.id,
      sender_id:
        row.sender_type === "system" ? "system" : row.sender_id || "support",
      sender_type: row.sender_type,
      content: row.content,
      type: row.type,
      created_at: row.created_at.toISOString(),
    }));

    return respond(201, {
      ticket_id: ticketId,
      messages: responseMessages,
    });
  } catch (err) {
    await client.query("ROLLBACK");

    // Partial unique index violation — race condition, ticket already exists
    if (err.code === "23505" && err.constraint?.includes("one_open_per_user")) {
      console.log(
        `Race condition: open ticket already exists for user ${userId}, retrying...`,
      );
      // Retry without creating a new ticket
      const existingTicket = await db.query(
        `SELECT id FROM support_ticket WHERE user_id = $1 AND app = $2 AND status = 'open' LIMIT 1`,
        [userId, app],
      );
      if (existingTicket.rows.length > 0) {
        const ticketId = existingTicket.rows[0].id;
        const userMsg = await db.query(
          `INSERT INTO support_message (user_id, ticket_id, sender_type, sender_id, content, type)
           VALUES ($1, $2, 'user', $1, $3, 'text')
           RETURNING id, sender_type, sender_id, content, type, created_at`,
          [userId, ticketId, content.trim()],
        );
        return respond(201, {
          ticket_id: ticketId,
          messages: [
            {
              message_id: userMsg.rows[0].id,
              sender_id: userId,
              sender_type: "user",
              content: userMsg.rows[0].content,
              type: "text",
              created_at: userMsg.rows[0].created_at.toISOString(),
            },
          ],
        });
      }
    }

    throw err;
  } finally {
    client.release();
  }
}
