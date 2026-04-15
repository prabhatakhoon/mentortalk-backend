/**
 * mentortalk-request-timeout
 *
 * Invoked by EventBridge Scheduler 60s after a session is requested.
 * If the session is still in 'requested' state, auto-cancels it
 * and notifies both mentor and mentee.
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { ApiGatewayManagementApiClient, PostToConnectionCommand } from "@aws-sdk/client-apigatewaymanagementapi";
import { sendFcmNotification } from "./fcmHelper.js";
import pg from "pg";

const { Pool } = pg;
const secretsClient = new SecretsManagerClient({ region: "ap-south-1" });
const dynamoClient = DynamoDBDocumentClient.from(new DynamoDBClient({ region: "ap-south-1" }));

const WS_ENDPOINT = process.env.WS_ENDPOINT;

let pool = null;

const getDbCredentials = async () => {
  const response = await secretsClient.send(
    new GetSecretValueCommand({ SecretId: "mentortalk/db-app-credentials" })
  );
  return JSON.parse(response.SecretString);
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
    max: 3,
  });
  return pool;
};
// ─── REPLACE pushToUser in all three files: ───
// sessionHandler.js, sessionTimeout.js, requestTimeout.js

async function pushToUser(userId, payload, fcmOptions = null) {
  // Always attempt WebSocket delivery
  const conn = await dynamoClient.send(new GetCommand({
    TableName: "mentortalk-connections",
    Key: { user_id: userId },
  }));

  if (conn.Item) {
    const apiClient = new ApiGatewayManagementApiClient({ endpoint: WS_ENDPOINT });

    try {
      await apiClient.send(new PostToConnectionCommand({
        ConnectionId: conn.Item.connection_id,
        Data: Buffer.from(JSON.stringify(payload)),
      }));
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

  // Always send FCM for critical events (when fcmOptions provided).
  // App deduplicates if it already processed via WebSocket.
  if (fcmOptions) {
    await sendFcmNotification(userId, fcmOptions);
  }
}

// ─── Handler ─────────────────────────────────────────────────

export const handler = async (event) => {
  console.log("Request timeout event:", JSON.stringify(event));

  const sessionId = event.sessionId;

  if (!sessionId) {
    console.log("No sessionId provided");
    return { cancelled: false, reason: "No sessionId" };
  }

  const db = await getPool();

  const result = await db.query(
    `SELECT id, mentor_id, mentee_id, status
     FROM session
     WHERE id = $1`,
    [sessionId]
  );

  if (result.rows.length === 0) {
    console.log(`Session ${sessionId} not found`);
    return { cancelled: false, reason: "Session not found" };
  }

  const session = result.rows[0];

  if (session.status !== "requested") {
    console.log(`Session ${sessionId} is '${session.status}', not 'requested' — no-op`);
    return { cancelled: false, reason: `Already ${session.status}` };
  }

  // Auto-cancel the session
  await db.query(
    `UPDATE session SET status = 'timed_out', ended_at = NOW(), request_timeout_schedule = NULL
     WHERE id = $1`,
    [sessionId]
  );

  // Notify mentee
  await pushToUser(
    session.mentee_id,
    {
      type: "session_timed_out",
      session_id: sessionId,
      message: "Mentor did not respond in time",
    },
    {
      title: "Request Timed Out",
      body: "The mentor did not respond to your session request",
      data: { type: "session_timed_out", session_id: sessionId },
    }
  );

  // Notify mentor
  await pushToUser(
    session.mentor_id,
    {
      type: "session_timed_out",
      session_id: sessionId,
      message: "Session request timed out",
    },
    {
      title: "Missed Session Request",
      body: "A session request expired because you didn't respond",
      data: { type: "session_timed_out", session_id: sessionId },
    }
  );

  console.log(`Session ${sessionId} auto-cancelled (request timeout)`);
  return { cancelled: true, reason: "Request timed out" };
};
