/**
 * mentortalk-free-chat-timeout
 *
 * Invoked by EventBridge Scheduler 10s after a free chat request is sent to a mentor.
 * If the session is still in 'requested' state:
 *   - Notifies the current mentor that the request expired
 *   - Pulls the next candidate from the DynamoDB forwarding queue
 *   - Reassigns the session to the next mentor
 *   - Creates a new 10s timeout schedule (pointing back to this Lambda)
 *   - If no candidates remain, marks session as timed_out
 *
 * Input: { sessionId: "uuid" }
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  DeleteCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";
import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
} from "@aws-sdk/client-apigatewaymanagementapi";
import {
  SchedulerClient,
  CreateScheduleCommand,
} from "@aws-sdk/client-scheduler";
import { sendFcmNotification } from "./fcmHelper.js";
import pg from "pg";

const { Pool } = pg;
const secretsClient = new SecretsManagerClient({ region: "ap-south-1" });
const dynamoClient = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: "ap-south-1" }),
);
const schedulerClient = new SchedulerClient({ region: "ap-south-1" });

const WS_ENDPOINT = process.env.WS_ENDPOINT;
const SCHEDULER_ROLE_ARN = process.env.SCHEDULER_ROLE_ARN;
const FREE_CHAT_TIMEOUT_LAMBDA_ARN = process.env.FREE_CHAT_TIMEOUT_LAMBDA_ARN;

let pool = null;

const getDbCredentials = async () => {
  const response = await secretsClient.send(
    new GetSecretValueCommand({ SecretId: "mentortalk/db-app-credentials" }),
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

function toFullUrl(path) {
  if (!path || path.startsWith("http")) return path;
  const cdnBase = process.env.CDN_BASE_URL;
  if (cdnBase) return `${cdnBase}/${path}`;
  return null;
}

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

// ─── Handler ─────────────────────────────────────────────────

export const handler = async (event) => {
  console.log("Free chat timeout event:", JSON.stringify(event));

  const { sessionId } = event;

  if (!sessionId) {
    console.log("No sessionId provided");
    return { forwarded: false, reason: "No sessionId" };
  }

  const db = await getPool();

  // 1. Check session is still in 'requested' state and is a free chat
  const sessionResult = await db.query(
    `SELECT id, mentor_id, mentee_id, status, billing_type
     FROM session WHERE id = $1`,
    [sessionId],
  );

  if (sessionResult.rows.length === 0) {
    console.log(`Session ${sessionId} not found`);
    return { forwarded: false, reason: "Session not found" };
  }

  const session = sessionResult.rows[0];

  if (session.status !== "requested") {
    console.log(
      `Session ${sessionId} is '${session.status}', not 'requested' — no-op`,
    );
    return { forwarded: false, reason: `Already ${session.status}` };
  }

  if (session.billing_type !== "free_intro") {
    console.log(`Session ${sessionId} is not a free chat — no-op`);
    return { forwarded: false, reason: "Not a free chat session" };
  }

  // 2. Notify current mentor: request expired
  await pushToUser(session.mentor_id, {
    type: "session_expired",
    session_id: sessionId,
  });

  // 3. Get forwarding queue from DynamoDB
  let queue;
  try {
    const queueResult = await dynamoClient.send(
      new GetCommand({
        TableName: "mentortalk-free-chat-queue",
        Key: { session_id: sessionId },
      }),
    );
    queue = queueResult.Item;
  } catch (err) {
    console.error("Failed to fetch forwarding queue:", err.message);
  }

  const remainingMentors = queue?.remaining_mentors || [];

  // 4. Find next eligible online mentor
  let nextMentor = null;
  const stillRemaining = [];

  for (let i = 0; i < remainingMentors.length; i++) {
    const mentorId = remainingMentors[i];

    if (nextMentor) {
      // Already found one — keep the rest for future forwards
      stillRemaining.push(mentorId);
      continue;
    }

    // Check presence
    const presence = await dynamoClient.send(
      new GetCommand({
        TableName: "mentortalk-presence",
        Key: { user_id: mentorId },
      }),
    );
    if (mentorId === session.mentee_id) {
      continue; // skip self — user is both mentor and mentee
    }

    if (presence.Item?.status !== "online") {
      continue; // skip offline mentors entirely
    }

    // Check not in active session
    const activeCheck = await db.query(
      `SELECT id FROM session WHERE mentor_id = $1 AND status = 'active'`,
      [mentorId],
    );
    if (activeCheck.rows.length > 0) {
      continue; // skip busy mentors
    }

    // Check daily quota
    const quotaCheck = await db.query(
      `SELECT count, max_count FROM mentor_free_chat_quota
       WHERE mentor_id = $1 AND date = CURRENT_DATE`,
      [mentorId],
    );
    const count = parseInt(quotaCheck.rows[0]?.count) || 0;
    const maxCount = parseInt(quotaCheck.rows[0]?.max_count) || 5;

    if (count >= maxCount) {
      continue; // skip mentors who hit their daily cap
    }

    // This mentor is eligible
    nextMentor = mentorId;
    // Don't break — continue collecting stillRemaining
  }

  // 5. No eligible mentor found — time out the session
  if (!nextMentor) {
    console.log(
      `No more eligible candidates for session ${sessionId} — timing out`,
    );

    await db.query(
      `UPDATE session SET status = 'timed_out', ended_at = NOW(), request_timeout_schedule = NULL
       WHERE id = $1`,
      [sessionId],
    );

    // Clean up DynamoDB queue
    try {
      await dynamoClient.send(
        new DeleteCommand({
          TableName: "mentortalk-free-chat-queue",
          Key: { session_id: sessionId },
        }),
      );
    } catch (err) {
      console.log(`Queue cleanup note: ${err.message}`);
    }

    await pushToUser(
      session.mentee_id,
      {
        type: "free_chat_unavailable",
        session_id: sessionId,
        message: "No mentors available right now. Please try again later.",
      },
      {
        title: "Free Chat Unavailable",
        body: "No mentors are available right now. Please try again later.",
        data: { type: "free_chat_unavailable", session_id: sessionId },
      },
    );

    return { forwarded: false, reason: "No candidates remaining" };
  }

  // 6. Reassign session to next mentor
  await db.query(
    `UPDATE session SET mentor_id = $2, request_timeout_schedule = NULL WHERE id = $1`,
    [sessionId, nextMentor],
  );

  // 7. Update DynamoDB queue with reduced list
  await dynamoClient.send(
    new PutCommand({
      TableName: "mentortalk-free-chat-queue",
      Item: {
        session_id: sessionId,
        remaining_mentors: stillRemaining,
        current_mentor_index: (queue?.current_mentor_index || 0) + 1,
        created_at: queue?.created_at || new Date().toISOString(),
        ttl: Math.floor(Date.now() / 1000) + 300,
      },
    }),
  );

  // 8. Load promo config for timeout duration
  const cfgResult = await db.query(
    `SELECT free_chat_timeout_secs FROM promo_config WHERE id = 1`,
  );
  const timeoutSecs = cfgResult.rows[0]?.free_chat_timeout_secs || 10;

  // 9. Create new timeout schedule for this mentor
  const scheduleName = `free-chat-${sessionId}-${Date.now()}`;
  const fireAt = new Date(Date.now() + timeoutSecs * 1000);

  try {
    await schedulerClient.send(
      new CreateScheduleCommand({
        Name: scheduleName,
        ScheduleExpression: `at(${fireAt
          .toISOString()
          .replace(/\.\d{3}Z$/, "")})`,
        ScheduleExpressionTimezone: "UTC",
        FlexibleTimeWindow: { Mode: "OFF" },
        Target: {
          Arn: FREE_CHAT_TIMEOUT_LAMBDA_ARN,
          RoleArn: SCHEDULER_ROLE_ARN,
          Input: JSON.stringify({ sessionId }),
        },
        ActionAfterCompletion: "DELETE",
      }),
    );

    await db.query(
      `UPDATE session SET request_timeout_schedule = $2 WHERE id = $1`,
      [sessionId, scheduleName],
    );

    console.log(
      `Created new timeout schedule: ${scheduleName} (${timeoutSecs}s)`,
    );
  } catch (err) {
    console.error("Failed to create forward timeout schedule:", err.message);
  }

  // 10. Get mentee info for push payload
  const menteeResult = await db.query(
    `SELECT first_name, last_name, profile_photo_url FROM mentee_profile WHERE user_id = $1`,
    [session.mentee_id],
  );
  const menteeRow = menteeResult.rows[0];
  const menteeName =
    [menteeRow?.first_name, menteeRow?.last_name].filter(Boolean).join(" ") ||
    "Mentee";
  const menteeAvatar = toFullUrl(menteeRow?.profile_photo_url);

  // 11. Push free chat request to new mentor
  await pushToUser(
    nextMentor,
    {
      type: "session_request",
      session_id: sessionId,
      mentee_id: session.mentee_id,
      mentee_name: menteeName,
      mentee_avatar: menteeAvatar,
      session_type: "chat",
      is_free_chat: true,
      rate_per_minute: 0,
      timeout_seconds: timeoutSecs,
    },
    {
      title: "Free Chat Request",
      body: `${menteeName} wants a free intro chat`,
      data: {
        type: "session_request",
        session_id: sessionId,
        is_free_chat: "true",
      },
    },
  );

  console.log(
    `Forwarded session ${sessionId} from ${session.mentor_id} to ${nextMentor}`,
  );

  return {
    forwarded: true,
    from_mentor: session.mentor_id,
    to_mentor: nextMentor,
    remaining_candidates: stillRemaining.length,
  };
};
