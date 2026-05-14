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
import { SchedulerClient, CreateScheduleCommand } from "@aws-sdk/client-scheduler";
import { sendFcmNotification } from "./fcmHelper.js";
import pg from "pg";

const { Pool } = pg;
const secretsClient = new SecretsManagerClient({ region: "ap-south-1" });
const dynamoClient = DynamoDBDocumentClient.from(new DynamoDBClient({ region: "ap-south-1" }));
const schedulerClient = new SchedulerClient({ region: "ap-south-1" });

const WS_ENDPOINT = process.env.WS_ENDPOINT;
const REQUEST_TIMEOUT_LAMBDA_ARN = process.env.REQUEST_TIMEOUT_LAMBDA_ARN;
const SCHEDULER_ROLE_ARN = process.env.SCHEDULER_ROLE_ARN;
const SESSION_REQUEST_TIMEOUT_SECONDS = 60;

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
    `SELECT id, mentor_id, mentee_id, status, billing_type
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

  // Auto-cancel the session; mark as missed call for paid / intro_rate
  const isPaidOrIntro = session.billing_type === "paid" || session.billing_type === "intro_rate";
  await db.query(
    `UPDATE session SET status = 'timed_out', ended_at = NOW(), request_timeout_schedule = NULL,
       missed_call_reason = $2
     WHERE id = $1`,
    [sessionId, isPaidOrIntro ? "timeout" : null]
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

  // Promote next pending session in the mentor's queue (if any).
  // Only promote if the mentor is NOT currently in an active session —
  // guards against the edge case where a race condition let a "requested"
  // session slip through while the mentor was still in a call.
  const stillBusy = await db.query(
    `SELECT id FROM session WHERE mentor_id = $1 AND status = 'active' LIMIT 1`,
    [session.mentor_id]
  );
  if (stillBusy.rows.length === 0) {
    await promoteNextPendingSession(db, session.mentor_id);
  }

  console.log(`Session ${sessionId} auto-cancelled (request timeout)`);
  return { cancelled: true, reason: "Request timed out" };
};

// ─── Queue Promotion ─────────────────────────────────────────

async function promoteNextPendingSession(db, mentorId) {
  const pendingResult = await db.query(
    `UPDATE session
     SET status = 'requested', started_at = NOW()
     WHERE id = (
       SELECT id FROM session
       WHERE mentor_id = $1 AND status = 'pending'
       ORDER BY started_at ASC
       LIMIT 1
     )
     RETURNING id, mentee_id, requested_session_type`,
    [mentorId]
  );

  if (pendingResult.rows.length === 0) return;

  const promoted = pendingResult.rows[0];

  // Check mentor is still available before pushing
  const mentorAvail = await db.query(
    `SELECT is_available FROM mentor_profile WHERE user_id = $1`,
    [mentorId]
  );
  if (!mentorAvail.rows[0]?.is_available) {
    console.log(`Mentor ${mentorId} is not available — skipping promotion of session ${promoted.id}`);
    // Revert the promotion — keep it pending so it can be picked up when mentor becomes available
    await db.query(
      `UPDATE session SET status = 'pending' WHERE id = $1`,
      [promoted.id]
    );
    return;
  }

  // Create timeout schedule for promoted session
  if (REQUEST_TIMEOUT_LAMBDA_ARN && SCHEDULER_ROLE_ARN) {
    const scheduleName = `rt-${promoted.id}-${String(Date.now()).slice(-6)}`;
    const fireAt = new Date(Date.now() + SESSION_REQUEST_TIMEOUT_SECONDS * 1000);

    try {
      await schedulerClient.send(new CreateScheduleCommand({
        Name: scheduleName,
        ScheduleExpression: `at(${fireAt.toISOString().replace(/\.\d{3}Z$/, '')})`,
        ScheduleExpressionTimezone: "UTC",
        FlexibleTimeWindow: { Mode: "OFF" },
        Target: {
          Arn: REQUEST_TIMEOUT_LAMBDA_ARN,
          RoleArn: SCHEDULER_ROLE_ARN,
          Input: JSON.stringify({ sessionId: promoted.id }),
        },
        ActionAfterCompletion: "DELETE",
      }));

      await db.query(
        `UPDATE session SET request_timeout_schedule = $2 WHERE id = $1`,
        [promoted.id, scheduleName]
      );
    } catch (err) {
      console.error("Failed to create request timeout schedule:", err.message);
    }
  }

  // Fetch mentee name + avatar
  const menteeResult = await db.query(
    `SELECT first_name, last_name, profile_photo_url FROM mentee_profile WHERE user_id = $1`,
    [promoted.mentee_id]
  );
  const menteeRow = menteeResult.rows[0];
  const menteeName = [menteeRow?.first_name, menteeRow?.last_name].filter(Boolean).join(' ') || 'Mentee';

  function toFullUrl(path) {
    if (!path || path.startsWith('http')) return path;
    const cdnBase = process.env.CDN_BASE_URL;
    if (cdnBase) return `${cdnBase}/${path}`;
    return null;
  }
  const menteeAvatar = toFullUrl(menteeRow?.profile_photo_url);

  // Fetch rate + billing info for push payload
  const mentorProfile = await db.query(
    `SELECT rate_per_minute, chat_discount_percent FROM mentor_profile WHERE user_id = $1`,
    [mentorId]
  );
  const baseRate = parseFloat(mentorProfile.rows[0]?.rate_per_minute) || 0;
  const chatDiscountPercent = mentorProfile.rows[0]?.chat_discount_percent;

  const promotedType = promoted.requested_session_type || "chat";
  let ratePerMinute = baseRate;
  if (promotedType === 'video') {
    ratePerMinute = baseRate * 1.5;
  } else if (promotedType === 'chat' && chatDiscountPercent != null) {
    ratePerMinute = baseRate * (1 - chatDiscountPercent / 100);
  }

  // Get billing type for promoted session
  const promotedSession = await db.query(
    `SELECT billing_type FROM session WHERE id = $1`,
    [promoted.id]
  );
  const promotedBillingType = promotedSession.rows[0]?.billing_type || 'paid';
  let promotedEffectiveRate = ratePerMinute;
  let promotedNormalRate;

  if (promotedBillingType === 'intro_rate') {
    const cfgRow = await db.query(
      `SELECT intro_rate_per_minute FROM promo_config WHERE id = 1`
    );
    promotedEffectiveRate = parseFloat(cfgRow.rows[0]?.intro_rate_per_minute) || 0;
    promotedNormalRate = ratePerMinute;
  }

  // Push to mentor (WebSocket + FCM)
  await pushToUser(
    mentorId,
    {
      type: "session_request",
      session_id: promoted.id,
      mentee_id: promoted.mentee_id,
      mentee_name: menteeName,
      mentee_avatar: menteeAvatar,
      session_type: promotedType,
      billing_type: promotedBillingType,
      rate_per_minute: promotedEffectiveRate,
      normal_rate_per_minute: promotedNormalRate,
      timeout_seconds: SESSION_REQUEST_TIMEOUT_SECONDS,
    },
    {
      title: "New Session Request",
      body: `${menteeName} wants to start a ${promotedType} session`,
      data: {
        type: "session_request",
        session_id: promoted.id,
        mentee_name: menteeName,
        session_type: promotedType,
      },
    }
  );

  // Push to mentee
  await pushToUser(promoted.mentee_id, {
    type: "session_promoted",
    session_id: promoted.id,
    message: "Your session request has been sent to the mentor",
    session_type: promotedType,
    rate_per_minute: promotedEffectiveRate,
    normal_rate_per_minute: promotedNormalRate,
    billing_type: promotedBillingType,
    timeout_seconds: SESSION_REQUEST_TIMEOUT_SECONDS,
  });

  console.log(`Promoted session ${promoted.id} from pending to requested`);
}
