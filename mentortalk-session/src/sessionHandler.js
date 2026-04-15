import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { ApiGatewayManagementApiClient, PostToConnectionCommand } from "@aws-sdk/client-apigatewaymanagementapi";
import { SFNClient, StartExecutionCommand, StopExecutionCommand } from "@aws-sdk/client-sfn";
import { SchedulerClient, CreateScheduleCommand, DeleteScheduleCommand } from "@aws-sdk/client-scheduler";
import { sendFcmNotification } from "./fcmHelper.js";
import { generateAgoraToken } from "./agoraHelper.js";
import pg from "pg";
import jwt from "jsonwebtoken";
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const s3Client = new S3Client({ region: "ap-south-1" });
const BUCKET_NAME = "mentortalk-storage-prod";

const { Pool } = pg;
const secretsClient = new SecretsManagerClient({ region: "ap-south-1" });
const dynamoClient = DynamoDBDocumentClient.from(new DynamoDBClient({ region: "ap-south-1" }));
const sfnClient = new SFNClient({ region: "ap-south-1" });
const schedulerClient = new SchedulerClient({ region: "ap-south-1" });

// Environment variables
const WS_ENDPOINT = process.env.WS_ENDPOINT;
const SFN_ARN = process.env.SFN_ARN;
const REQUEST_TIMEOUT_LAMBDA_ARN = process.env.REQUEST_TIMEOUT_LAMBDA_ARN;
const SCHEDULER_ROLE_ARN = process.env.SCHEDULER_ROLE_ARN;

let pool = null;
let jwtSecret = null;

// ─── Shared Setup ────────────────────────────────────────────

const getDbCredentials = async () => {
  const response = await secretsClient.send(
    new GetSecretValueCommand({ SecretId: "mentortalk/db-app-credentials" })
  );
  return JSON.parse(response.SecretString);
};

const getJwtSecret = async () => {
  if (jwtSecret) return jwtSecret;
  const response = await secretsClient.send(
    new GetSecretValueCommand({ SecretId: "mentortalk/jwt-secret" })
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


function toFullUrl(path) {
  if (!path || path.startsWith('http')) return path;
  const cdnBase = process.env.CDN_BASE_URL;
  if (cdnBase) return `${cdnBase}/${path}`;
  return null;
}
// ─── WebSocket Push Helper (with FCM fallback) ──────────────

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
// ─── Presence Update Helper ──────────────────────────────────

async function updatePresence(userId, status) {
  await dynamoClient.send(new PutCommand({
    TableName: "mentortalk-presence",
    Item: {
      user_id: userId,
      status,
      last_seen: new Date().toISOString(),
    },
  }));
  console.log(`Updated presence for ${userId} → ${status}`);
}

async function broadcastPresenceUpdate(userId, status) {
  await updatePresence(userId, status);

  try {
    const subs = await dynamoClient.send(new QueryCommand({
      TableName: "mentortalk-presence-subscriptions",
      KeyConditionExpression: "target_user_id = :uid",
      ExpressionAttributeValues: { ":uid": userId },
    }));

    if (!subs.Items || subs.Items.length === 0) return;

    const db = await getPool();
    const availResult = await db.query(
      `SELECT is_available FROM mentor_profile WHERE user_id = $1`,
      [userId]
    );
    const isAvailable = availResult.rows[0]?.is_available ?? true;

    const payload = {
      type: "presence_update",
      user_id: userId,
      presence: status,
      is_available: isAvailable,
      last_seen: new Date().toISOString(),
    };

    await Promise.all(
      subs.Items.map(sub => pushToUser(sub.subscriber_id, payload))
    );
    console.log(`Presence broadcast: ${userId} → ${status}, is_available=${isAvailable}, subscribers=${subs.Items.length}`);
  } catch (err) {
    console.error(`Presence broadcast failed for ${userId}:`, err.message);
  }
}

// ─── Request Timeout Schedule Helpers ────────────────────────

async function createRequestTimeoutSchedule(sessionId) {
  const scheduleName = `session-request-${sessionId}`;
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
        Input: JSON.stringify({ sessionId }),
      },
      ActionAfterCompletion: "DELETE",
    }));
    console.log(`Created request timeout schedule: ${scheduleName}`);
    return scheduleName;
  } catch (err) {
    console.error("Failed to create request timeout schedule:", err.message);
    return null;
  }
}

async function deleteRequestTimeoutSchedule(scheduleName) {
  if (!scheduleName) return;
  try {
    await schedulerClient.send(new DeleteScheduleCommand({
      Name: scheduleName,
    }));
    console.log(`Deleted request timeout schedule: ${scheduleName}`);
  } catch (err) {
    console.log(`Schedule delete note: ${err.message}`);
  }
}

// ─── Constants ───────────────────────────────────────────────

const MINIMUM_SESSION_MINUTES = 5;
const SESSION_REQUEST_TIMEOUT_SECONDS = 60;
const FREE_CHAT_TIMEOUT_LAMBDA_ARN = process.env.FREE_CHAT_TIMEOUT_LAMBDA_ARN;

// ─── Route Handler ───────────────────────────────────────────

export const handler = async (event) => {
  console.log("Session event:", JSON.stringify(event));

  try {
    const authHeader = event.headers?.Authorization || event.headers?.authorization;
    const decoded = await verifyToken(authHeader);
    const userId = decoded.sub;

    const method = event.httpMethod;
    const path = event.resource || event.path;

    if (method === "POST" && path === "/session/request") {
      return await handleSessionRequest(userId, event);
    }

    if (method === "POST" && path.match(/\/session\/[^/]+\/accept/)) {
      return await handleSessionAccept(userId, event);
    }

    if (method === "POST" && path.match(/\/session\/[^/]+\/reject/)) {
      return await handleSessionReject(userId, event);
    }

    if (method === "POST" && path.match(/\/session\/[^/]+\/end/)) {
      return await handleSessionEnd(userId, event);
    }

    if (method === "POST" && path.match(/\/session\/[^/]+\/cancel/)) {
      return await handleSessionCancel(userId, event);
    }

    if (method === "GET" && path.match(/\/session\/[^/]+\/messages/)) {
      return await handleGetMessages(userId, event);
    }

    if (method === "POST" && path.match(/\/session\/[^/]+\/presign-upload/)) {
      return await handlePresignUpload(userId, event);
    }
    
    
    // Mode switch: request
    if (method === "POST" && path.match(/\/session\/[^/]+\/switch$/) && !path.includes("accept") && !path.includes("decline")) {
      return await handleModeSwitchRequest(userId, event);
    }

    // Mode switch: accept
    if (method === "POST" && path.match(/\/session\/[^/]+\/switch\/accept/)) {
      return await handleModeSwitchAccept(userId, event);
    }

    // Mode switch: decline
    if (method === "POST" && path.match(/\/session\/[^/]+\/switch\/decline/)) {
      return await handleModeSwitchDecline(userId, event);
    }

    // End call (not session)
    if (method === "POST" && path.match(/\/session\/[^/]+\/call\/end/)) {
      return await handleCallEnd(userId, event);
    }

    if (method === "POST" && path.match(/\/session\/[^/]+\/review/)) {
      return await handleSubmitReview(userId, event);
    }

    if (method === "POST" && path.match(/\/session\/[^/]+\/refresh-duration/)) {
      return await handleRefreshDuration(userId, event);
    }

    if (method === "GET" && (path === "/session/active" || event.path === "/session/active")) {
      return await handleGetActiveSession(userId, event);
    }

    if (method === "POST" && (path === "/session/free-chat" || event.path === "/session/free-chat")) {
      return await handleFreeChat(userId, event);
    }

    if (method === "GET" && (path === "/session/free-chat/availability" || event.path === "/session/free-chat/availability")) {
      return await handleFreeChatAvailability(userId, event);
    }

    return respond(404, { error: "Not found" });
  } catch (err) {
    if (err.name === "JsonWebTokenError" || err.name === "TokenExpiredError" || err.message.includes("authorization header")) {
      return respond(401, { error: "Unauthorized" });
    }
    console.error("Unhandled error:", err);
    return respond(500, { error: "Internal server error" });
  }
};

// ─── GET /session/:id/messages ───────────────────────────────

async function handleGetMessages(userId, event) {
  const sessionId = extractSessionId(event);
  const db = await getPool();

  // Verify user belongs to this session
  const sessionResult = await db.query(
    `SELECT id FROM session
     WHERE id = $1 AND (mentee_id = $2 OR mentor_id = $2)`,
    [sessionId, userId]
  );

  if (sessionResult.rows.length === 0) {
    return respond(404, { error: "Session not found" });
  }

  // Parse query params
  const params = event.queryStringParameters || {};
  const limit = Math.min(parseInt(params.limit) || 50, 100);
  const lastKey = params.last_key ? JSON.parse(decodeURIComponent(params.last_key)) : undefined;
  const order = params.order === "asc" ? "asc" : "desc"; // default newest first

  // Query DynamoDB
  const queryParams = {
    TableName: "mentortalk-messages",
    KeyConditionExpression: "session_id = :sid",
    ExpressionAttributeValues: { ":sid": sessionId },
    ScanIndexForward: order === "asc", // true = oldest first, false = newest first
    Limit: limit,
  };

  if (lastKey) {
    queryParams.ExclusiveStartKey = lastKey;
  }

  const result = await dynamoClient.send(new QueryCommand(queryParams));

  const messages = await Promise.all((result.Items || [])).map(async (item) => {
    const msg = {
      message_id: item.message_id,
      sender_id: item.sender_id,
      content: item.content,
      type: item.type || "text",
      created_at: item.created_at,
      client_message_id: item.client_message_id || null,
    };

    if (item.media_url) {
      msg.media_url = await getSignedUrl(s3Client, new GetObjectCommand({
        Bucket: BUCKET_NAME,
        Key: item.media_url,
      }), { expiresIn: 3600 });
    }
    if (item.media_metadata) {
      try {
        msg.media_metadata = typeof item.media_metadata === 'string'
          ? JSON.parse(item.media_metadata)
          : item.media_metadata;
      } catch {
        msg.media_metadata = item.media_metadata;
      }
    }

    return msg;
  });

  const response = {
    messages,
    count: messages.length,
  };

  // Pagination cursor
  if (result.LastEvaluatedKey) {
    response.last_key = encodeURIComponent(JSON.stringify(result.LastEvaluatedKey));
  }

  return respond(200, response);
}

// ─── POST /session/request ───────────────────────────────────

async function handleSessionRequest(menteeId, event) {
  const body = JSON.parse(event.body || "{}");
  const { mentor_id, session_type } = body;

  if (!mentor_id || !session_type) {
    return respond(400, { error: "mentor_id and session_type required" });
  }

  if (!["chat", "audio", "video"].includes(session_type)) {
    return respond(400, { error: "session_type must be chat, audio, or video" });
  }

  // Prevent self-sessions
  if (menteeId === mentor_id) {
    return respond(400, { error: "You cannot start a session with yourself" });
  }

  const db = await getPool();

  // 1. Check mentor exists, is approved, and is active
  const mentorResult = await db.query(
    `SELECT u.id, mp.first_name, mp.last_name,
            mp.rate_per_minute, mp.profile_photo_url,
            mp.is_available, mp.pref_audio, mp.pref_video,
            mp.intro_rate_enabled
     FROM "user" u
     JOIN mentor_profile mp ON mp.user_id = u.id
     JOIN mentorship_application ma ON ma.user_id = u.id
     WHERE u.id = $1
       AND u.role = 'mentor'
       AND u.account_status = 'active'
       AND ma.submission_status = 'approved'`,
    [mentor_id]
  );

  if (mentorResult.rows.length === 0) {
    return respond(404, { error: "Mentor not found or not available" });
  }

  const mentor = mentorResult.rows[0];

  // 1b. Check mentor availability and preferences
  if (!mentor.is_available) {
    return respond(400, { error: "Mentor is currently unavailable" });
  }

  if (session_type === 'audio' && !mentor.pref_audio) {
    return respond(400, { error: "This mentor doesn't accept audio sessions" });
  }

  if (session_type === 'video' && !mentor.pref_video) {
    return respond(400, { error: "This mentor doesn't accept video sessions" });
  }

  // 2. Determine rate based on session type
  const baseRate = parseFloat(mentor.rate_per_minute);
  let ratePerMinute = session_type === "video" ? baseRate * 1.5 : baseRate;

  // 2b. Check intro rate eligibility
  let billingType = 'paid';
  let introRatePerMinute = null;

  if (session_type === 'chat') {
    const promoResult = await db.query(
      `SELECT intro_session_used FROM mentee_promo_status WHERE user_id = $1`,
      [menteeId]
    );

    if (promoResult.rows.length > 0 && !promoResult.rows[0].intro_session_used && mentor.intro_rate_enabled !== false) {
      const cfgResult = await db.query(
        `SELECT intro_rate_enabled, intro_rate_per_minute FROM promo_config WHERE id = 1`
      );
      const cfg = cfgResult.rows[0];
      if (cfg?.intro_rate_enabled) {
        billingType = 'intro_rate';
        introRatePerMinute = parseFloat(cfg.intro_rate_per_minute);
      }
    }
  }

  // 3. Check mentee wallet balance
  const balanceResult = await db.query(
    `SELECT balance FROM wallet WHERE user_id = $1 AND type = 'mentee'`,
    [menteeId]
  );

  if (balanceResult.rows.length === 0) {
    return respond(402, { error: "Wallet not found" });
  }

  const balance = parseFloat(balanceResult.rows[0].balance);
  const effectiveRate = billingType === 'intro_rate' ? introRatePerMinute : ratePerMinute;
  const minimumRequired = effectiveRate * MINIMUM_SESSION_MINUTES;

  if (balance < minimumRequired) {
    return respond(402, {
      error: "Insufficient balance",
      balance,
      minimum_required: minimumRequired,
      rate_per_minute: effectiveRate,
    });
  }

  // 4. Check mentee doesn't already have an active/requested session
  const menteeActiveSession = await db.query(
    `SELECT id FROM session
     WHERE mentee_id = $1
       AND status IN ('requested', 'active', 'pending')`,
    [menteeId]
  );

  if (menteeActiveSession.rows.length > 0) {
    return respond(409, {
      error: "You already have an active or pending session",
      session_id: menteeActiveSession.rows[0].id,
    });
  }

  // 5. Check if mentor is in an active session
  const mentorActiveSession = await db.query(
    `SELECT id FROM session
     WHERE mentor_id = $1
       AND status = 'active'`,
    [mentor_id]
  );

  const mentorIsBusy = mentorActiveSession.rows.length > 0;

  // 6. Check if mentor is online
  const presence = await dynamoClient.send(new GetCommand({
    TableName: "mentortalk-presence",
    Key: { user_id: mentor_id },
  }));

  const mentorIsOnline = presence.Item?.status === "online";

  // 7. Get mentee info
  const menteeResult = await db.query(
    `SELECT first_name, last_name FROM mentee_profile WHERE user_id = $1`,
    [menteeId]
  );
  const mentee = menteeResult.rows[0];
  const menteeName = [mentee?.first_name, mentee?.last_name].filter(Boolean).join(' ') || 'Mentee';

  // 8. Create session
  let sessionStatus;
  if (mentorIsBusy) {
    sessionStatus = "pending";
  } else {
    sessionStatus = "requested";
  }

  const sessionResult = await db.query(
    `INSERT INTO session (mentee_id, mentor_id, status, requested_session_type, billing_type, started_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     RETURNING id, status, started_at`,
    [menteeId, mentor_id, sessionStatus, session_type, billingType]
  );

  const session = sessionResult.rows[0];

  // 9. Create request timeout schedule (60s auto-cancel)
  if (sessionStatus === "requested") {
    const scheduleName = await createRequestTimeoutSchedule(session.id);
    if (scheduleName) {
      await db.query(
        `UPDATE session SET request_timeout_schedule = $2 WHERE id = $1`,
        [session.id, scheduleName]
      );
    }
  }

  // 10. Push to mentor (WebSocket primary, FCM fallback)
  // Get mentee avatar for push payload
  const menteeProfileResult = await db.query(
    `SELECT profile_photo_url FROM mentee_profile WHERE user_id = $1`,
    [menteeId]
  );
  const menteeAvatar = toFullUrl(menteeProfileResult.rows[0]?.profile_photo_url);

  if (sessionStatus === "requested") {
    await pushToUser(
      mentor_id,
      {
        type: "session_request",
        session_id: session.id,
        mentee_id: menteeId,
        mentee_name: menteeName,
        mentee_avatar: menteeAvatar,
        session_type,
        billing_type: billingType,
        rate_per_minute: billingType === 'intro_rate' ? introRatePerMinute : ratePerMinute,
        normal_rate_per_minute: billingType === 'intro_rate' ? ratePerMinute : undefined,
        timeout_seconds: SESSION_REQUEST_TIMEOUT_SECONDS,
      },
      {
        title: "New Session Request",
        body: `${menteeName} wants to start a ${session_type} session`,
        data: {
          type: "session_request",
          session_id: session.id,
          mentee_name: menteeName,
          session_type,
        },
      }
    );
  }

  // 11. Return session info with balance for client timer
  return respond(201, {
    session_id: session.id,
    status: session.status,
    mentor_name: `${mentor.first_name} ${mentor.last_name}`.trim(),
    mentor_avatar: toFullUrl(mentor.profile_photo_url),
    session_type,
    billing_type: billingType,
    rate_per_minute: billingType === 'intro_rate' ? introRatePerMinute : ratePerMinute,
    normal_rate_per_minute: billingType === 'intro_rate' ? ratePerMinute : undefined,
    timeout_seconds:
      sessionStatus === "requested" ? SESSION_REQUEST_TIMEOUT_SECONDS : null,
    queue_position:
      sessionStatus === "pending"
        ? await getQueuePosition(db, mentor_id, session.id)
        : null,
    mentee_balance: balance,
  });
}

// ─── Helper: Queue Position ──────────────────────────────────

async function getQueuePosition(db, mentorId, sessionId) {
  const result = await db.query(
    `SELECT id FROM session
     WHERE mentor_id = $1 AND status = 'pending'
     ORDER BY started_at ASC`,
    [mentorId]
  );

  const position = result.rows.findIndex((r) => r.id === sessionId) + 1;
  return position || 1;
}

// ─── POST /session/:id/accept ────────────────────────────────
async function handleSessionAccept(userId, event) {
  const sessionId = extractSessionId(event);
  const db = await getPool();

  const sessionResult = await db.query(
    `SELECT s.*, mp.rate_per_minute, mp.pref_audio, mp.pref_video
     FROM session s
     JOIN mentor_profile mp ON mp.user_id = s.mentor_id
     WHERE s.id = $1 AND s.mentor_id = $2 AND s.status = 'requested'`,
    [sessionId, userId]
  );

  if (sessionResult.rows.length === 0) {
    return respond(404, { error: "Session not found or not in requested state" });
  }

  const session = sessionResult.rows[0];
  const sessionType = session.requested_session_type || "chat";
  const baseRate = parseFloat(session.rate_per_minute);
  const ratePerMinute = sessionType === "video" ? baseRate * 1.5 : baseRate;
  // Cancel request timeout schedule
  await deleteRequestTimeoutSchedule(session.request_timeout_schedule);

  const client = await db.connect();
  try {
    await client.query("BEGIN");

    await client.query(
      `UPDATE session SET status = 'active', started_at = NOW(), request_timeout_schedule = NULL
       WHERE id = $1`,
      [sessionId]
    );

    // Determine rate based on billing_type
    let effectiveRate = ratePerMinute;
    if (session.billing_type === 'free_intro') {
      effectiveRate = 0;
    } else if (session.billing_type === 'intro_rate') {
      const cfg = (await client.query(`SELECT intro_rate_per_minute FROM promo_config WHERE id = 1`)).rows[0];
      if (cfg) effectiveRate = parseFloat(cfg.intro_rate_per_minute);
    }

    await client.query(
      `INSERT INTO session_segment (session_id, type, rate_per_minute, started_at)
       VALUES ($1, $2, $3, NOW())`,
      [sessionId, sessionType, effectiveRate]
    );

    // Free chat: increment mentor daily quota
    if (session.billing_type === 'free_intro') {
      const cfg = (await client.query(`SELECT mentor_daily_free_cap FROM promo_config WHERE id = 1`)).rows[0];
      await client.query(
        `INSERT INTO mentor_free_chat_quota (mentor_id, date, count, max_count)
         VALUES ($1, CURRENT_DATE, 1, $2)
         ON CONFLICT (mentor_id, date)
         DO UPDATE SET count = mentor_free_chat_quota.count + 1`,
        [userId, cfg?.mentor_daily_free_cap || 5]
      );

      // Mark mentee promo as used
      await client.query(
        `UPDATE mentee_promo_status
         SET free_chat_used = TRUE, free_chat_session_id = $2, free_chat_used_at = NOW()
         WHERE user_id = $1`,
        [session.mentee_id, sessionId]
      );

      // Clean up forwarding queue
      try {
        const { DeleteCommand } = await import("@aws-sdk/lib-dynamodb");
        await dynamoClient.send(new DeleteCommand({
          TableName: "mentortalk-free-chat-queue",
          Key: { session_id: sessionId },
        }));
      } catch (err) {
        console.log(`Free chat queue cleanup note: ${err.message}`);
      }
    }

    // Intro rate: mark promo as used
    if (session.billing_type === 'intro_rate') {
      await client.query(
        `UPDATE mentee_promo_status
         SET intro_session_used = TRUE, intro_session_id = $2, intro_session_used_at = NOW()
         WHERE user_id = $1`,
        [session.mentee_id, sessionId]
      );
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  // Generate Agora tokens if session starts as audio/video
  // mentorUid=1, menteeUid=2 — same convention as handleModeSwitchAccept
  let mentorAgoraCredentials = null;
  let menteeAgoraCredentials = null;
  if (sessionType === "audio" || sessionType === "video") {
    mentorAgoraCredentials = await generateAgoraToken(sessionId, 1);
    menteeAgoraCredentials = await generateAgoraToken(sessionId, 2);
  }

  // Persist "Session started" system message in DynamoDB
  // and push it to both users via WebSocket as a chat message.
  // Same message_id in both — cubit dedup prevents duplicates.
  const sessionStartedMsgId = `msg_${Date.now().toString(36)}_sys_start`;
  const sessionStartedAt = new Date().toISOString();

  await dynamoClient.send(new PutCommand({
    TableName: "mentortalk-messages",
    Item: {
      session_id: sessionId,
      message_id: sessionStartedMsgId,
      sender_id: "system",
      type: "system",
      content: sessionType === 'audio' ? "Audio call started" 
      : sessionType === 'video' ? "Video call started" 
      : "Chat started",
system_event: `${sessionType}_started`,
      created_at: sessionStartedAt,
    },
  }));

  // Push "Session started" as new_message to both users
  const sessionStartedPayload = {
    type: "new_message",
    message_id: sessionStartedMsgId,
    session_id: sessionId,
    sender_id: "system",
    content: sessionType === 'audio' ? "Audio call started"
             : sessionType === 'video' ? "Video call started"
             : "Chat started",
    created_at: sessionStartedAt,
  };

  await Promise.all([
    pushToUser(session.mentee_id, sessionStartedPayload),
    pushToUser(userId, sessionStartedPayload),
  ]);

  // Calculate max duration
  let menteeBalance = 0;
  let maxDurationSeconds;

  if (session.billing_type === 'free_intro') {
    // Free chat: fixed duration from config
    const cfgDuration = (await db.query(`SELECT free_chat_duration_secs FROM promo_config WHERE id = 1`)).rows[0];
    maxDurationSeconds = cfgDuration?.free_chat_duration_secs || 180;
    menteeBalance = 0;
  } else if (session.billing_type === 'intro_rate') {
    // Intro rate: fixed duration from config, auto-ends at limit
    const cfgIntro = (await db.query(`SELECT intro_max_minutes FROM promo_config WHERE id = 1`)).rows[0];
    maxDurationSeconds = (cfgIntro?.intro_max_minutes || 5) * 60;
    const balanceResult = await db.query(
      `SELECT balance FROM wallet WHERE user_id = $1 AND type = 'mentee'`,
      [session.mentee_id]
    );
    menteeBalance = parseFloat(balanceResult.rows[0].balance);
  } else {
    const balanceResult = await db.query(
      `SELECT balance FROM wallet WHERE user_id = $1 AND type = 'mentee'`,
      [session.mentee_id]
    );
    menteeBalance = parseFloat(balanceResult.rows[0].balance);
    const maxDurationMinutes = Math.floor(menteeBalance / ratePerMinute);
    maxDurationSeconds = maxDurationMinutes * 60;
  }

  // Start Step Functions session timeout timer
  let sfnExecutionArn = null;
  try {
    const execution = await sfnClient.send(new StartExecutionCommand({
      stateMachineArn: SFN_ARN,
      name: `session-${sessionId}-${Date.now()}`,
      input: JSON.stringify({ sessionId, maxDurationSeconds }),
    }));

    sfnExecutionArn = execution.executionArn;
    await db.query(
      `UPDATE session SET sfn_execution_arn = $2 WHERE id = $1`,
      [sessionId, sfnExecutionArn]
    );

    console.log(`Started SFN timeout for session ${sessionId}: ${maxDurationSeconds}s`);
  } catch (err) {
    console.error("Failed to start SFN timeout:", err.message);
  }

  // Get mentor name for notification (from profile, not user table)
  const mentorResult = await db.query(
    `SELECT first_name, last_name, profile_photo_url FROM mentor_profile WHERE user_id = $1`,
    [userId]
  );
  const row = mentorResult.rows[0];
  const mentorName = [row?.first_name, row?.last_name].filter(Boolean).join(' ') || 'Mentor';
  const mentorAvatar = toFullUrl(row?.profile_photo_url);

  // Push to mentee: session accepted
  const menteeWsPayload = {
    type: "session_accepted",
    session_id: sessionId,
    mentor_id: userId,
    session_type: sessionType,
    billing_type: session.billing_type || 'paid',
    rate_per_minute: session.billing_type === 'free_intro' ? 0 : ratePerMinute,
    mentee_balance: menteeBalance,
    max_duration_seconds: maxDurationSeconds,
    pref_audio: session.pref_audio ?? true,
    pref_video: session.pref_video ?? true,
  };

  // Attach Agora credentials for audio/video sessions
  if (menteeAgoraCredentials) {
    menteeWsPayload.agora_channel = menteeAgoraCredentials.channel;
    menteeWsPayload.agora_token = menteeAgoraCredentials.token;
    menteeWsPayload.agora_uid = menteeAgoraCredentials.uid;
    menteeWsPayload.agora_app_id = menteeAgoraCredentials.app_id;
  }

  menteeWsPayload.mentor_name = mentorName;
  menteeWsPayload.mentor_avatar = mentorAvatar;

  await pushToUser(
    session.mentee_id,
    menteeWsPayload,
    {
      title: "Session Accepted",
      body: `${mentorName} accepted your session request`,
      data: {
        type: "session_accepted",
        session_id: sessionId,
        session_type: sessionType,
      },
    }
  );

  await broadcastPresenceUpdate(userId, "in_session");
  const acceptResponse = {
    session_id: sessionId,
    status: "active",
    session_type: sessionType,
    billing_type: session.billing_type || 'paid',
    rate_per_minute: session.billing_type === 'free_intro' ? 0 : ratePerMinute,
    mentee_balance: menteeBalance,
    max_duration_seconds: maxDurationSeconds,
    pref_audio: session.pref_audio ?? true,
    pref_video: session.pref_video ?? true,
  };

  // Attach Agora credentials for audio/video sessions
  if (mentorAgoraCredentials) {
    acceptResponse.agora_channel = mentorAgoraCredentials.channel;
    acceptResponse.agora_token = mentorAgoraCredentials.token;
    acceptResponse.agora_uid = mentorAgoraCredentials.uid;
    acceptResponse.agora_app_id = mentorAgoraCredentials.app_id;
  }

  return respond(200, acceptResponse);
}

// ─── POST /session/:id/reject ────────────────────────────────

async function handleSessionReject(userId, event) {
  const sessionId = extractSessionId(event);
  const db = await getPool();

  const sessionData = await db.query(
    `SELECT request_timeout_schedule, billing_type, mentee_id FROM session
     WHERE id = $1 AND mentor_id = $2 AND status = 'requested'`,
    [sessionId, userId]
  );

  if (sessionData.rows.length === 0) {
    return respond(404, { error: "Session not found or not in requested state" });
  }

  const session = sessionData.rows[0];
  await deleteRequestTimeoutSchedule(session.request_timeout_schedule);

  // Free chat: forward to next mentor instead of rejecting
  if (session.billing_type === 'free_intro') {
    // Get forwarding queue from DynamoDB
    let queue;
    try {
      const queueResult = await dynamoClient.send(new GetCommand({
        TableName: "mentortalk-free-chat-queue",
        Key: { session_id: sessionId },
      }));
      queue = queueResult.Item;
    } catch (err) {
      console.error("Failed to fetch forwarding queue:", err.message);
    }

    const remainingMentors = queue?.remaining_mentors || [];
    let nextMentor = null;
    const stillRemaining = [];

    for (const mentorId of remainingMentors) {
      if (nextMentor) {
        stillRemaining.push(mentorId);
        continue;
      }

      const presence = await dynamoClient.send(new GetCommand({
        TableName: "mentortalk-presence",
        Key: { user_id: mentorId },
      }));

      if (presence.Item?.status !== "online") continue;

      const activeCheck = await db.query(
        `SELECT id FROM session WHERE mentor_id = $1 AND status = 'active'`,
        [mentorId]
      );
      if (activeCheck.rows.length > 0) continue;

      const quotaCheck = await db.query(
        `SELECT count, max_count FROM mentor_free_chat_quota
         WHERE mentor_id = $1 AND date = CURRENT_DATE`,
        [mentorId]
      );
      const count = parseInt(quotaCheck.rows[0]?.count) || 0;
      const maxCount = parseInt(quotaCheck.rows[0]?.max_count) || 5;
      if (count >= maxCount) continue;

      nextMentor = mentorId;
    }

    if (nextMentor) {
      // Reassign to next mentor
      await db.query(
        `UPDATE session SET mentor_id = $2, request_timeout_schedule = NULL WHERE id = $1`,
        [sessionId, nextMentor]
      );

      // Update DynamoDB queue
      await dynamoClient.send(new PutCommand({
        TableName: "mentortalk-free-chat-queue",
        Item: {
          session_id: sessionId,
          remaining_mentors: stillRemaining,
          current_mentor_index: (queue?.current_mentor_index || 0) + 1,
          created_at: queue?.created_at || new Date().toISOString(),
          ttl: Math.floor(Date.now() / 1000) + 300,
        },
      }));

      // Create new timeout schedule
      const cfgResult = await db.query(
        `SELECT free_chat_timeout_secs FROM promo_config WHERE id = 1`
      );
      const timeoutSecs = cfgResult.rows[0]?.free_chat_timeout_secs || 10;
      const scheduleName = `free-chat-${sessionId}-${Date.now()}`;
      const fireAt = new Date(Date.now() + timeoutSecs * 1000);

      try {
        await schedulerClient.send(new CreateScheduleCommand({
          Name: scheduleName,
          ScheduleExpression: `at(${fireAt.toISOString().replace(/\.\d{3}Z$/, '')})`,
          ScheduleExpressionTimezone: "UTC",
          FlexibleTimeWindow: { Mode: "OFF" },
          Target: {
            Arn: FREE_CHAT_TIMEOUT_LAMBDA_ARN,
            RoleArn: SCHEDULER_ROLE_ARN,
            Input: JSON.stringify({ sessionId }),
          },
          ActionAfterCompletion: "DELETE",
        }));

        await db.query(
          `UPDATE session SET request_timeout_schedule = $2 WHERE id = $1`,
          [sessionId, scheduleName]
        );
      } catch (err) {
        console.error("Failed to create forward timeout schedule:", err.message);
      }

      // Push to new mentor
      const menteeResult = await db.query(
        `SELECT first_name, last_name, profile_photo_url FROM mentee_profile WHERE user_id = $1`,
        [session.mentee_id]
      );
      const menteeRow = menteeResult.rows[0];
      const menteeName = [menteeRow?.first_name, menteeRow?.last_name].filter(Boolean).join(' ') || 'Mentee';
      const menteeAvatar = toFullUrl(menteeRow?.profile_photo_url);

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
        }
      );

      console.log(`Free chat forwarded from ${userId} to ${nextMentor} (rejection)`);
      return respond(200, { session_id: sessionId, status: "forwarded" });
    }

    // No candidates left — fall through to normal rejection
  }

  // Normal rejection (or free chat with no candidates)
  const sessionResult = await db.query(
    `UPDATE session SET status = 'rejected', ended_at = NOW(), request_timeout_schedule = NULL
     WHERE id = $1 AND mentor_id = $2 AND status = 'requested'
     RETURNING mentee_id`,
    [sessionId, userId]
  );

  if (sessionResult.rows.length === 0) {
    return respond(404, { error: "Session not found or not in requested state" });
  }

  // Clean up DynamoDB queue if free chat
  if (session.billing_type === 'free_intro') {
    try {
      await dynamoClient.send(new DeleteCommand({
        TableName: "mentortalk-free-chat-queue",
        Key: { session_id: sessionId },
      }));
    } catch (err) {
      console.log(`Queue cleanup note: ${err.message}`);
    }

    // Send free_chat_unavailable instead of session_rejected
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
      }
    );

    return respond(200, { session_id: sessionId, status: "rejected" });
  }

  await pushToUser(
    sessionResult.rows[0].mentee_id,
    {
      type: "session_rejected",
      session_id: sessionId,
    },
    {
      title: "Session Declined",
      body: "The mentor declined your session request",
      data: {
        type: "session_rejected",
        session_id: sessionId,
      },
    }
  );

  return respond(200, { session_id: sessionId, status: "rejected" });
}

// ─── POST /session/:id/cancel ────────────────────────────────

async function handleSessionCancel(menteeId, event) {
  const sessionId = extractSessionId(event);
  const db = await getPool();

  const sessionData = await db.query(
    `SELECT request_timeout_schedule, billing_type FROM session
     WHERE id = $1 AND mentee_id = $2 AND status IN ('requested', 'pending')`,
    [sessionId, menteeId]
  );

  const sessionResult = await db.query(
    `UPDATE session SET status = 'cancelled', ended_at = NOW(), request_timeout_schedule = NULL
     WHERE id = $1 AND mentee_id = $2 AND status IN ('requested', 'pending')
     RETURNING mentor_id, status`,
    [sessionId, menteeId]
  );

  if (sessionResult.rows.length === 0) {
    return respond(404, { error: "Session not found or cannot be cancelled" });
  }

  await deleteRequestTimeoutSchedule(sessionData.rows[0]?.request_timeout_schedule);

  // Clean up DynamoDB queue if free chat
  if (sessionData.rows[0]?.billing_type === 'free_intro') {
    try {
      await dynamoClient.send(new DeleteCommand({
        TableName: "mentortalk-free-chat-queue",
        Key: { session_id: sessionId },
      }));
    } catch (err) {
      console.log(`Free chat queue cleanup note: ${err.message}`);
    }
  }

  await pushToUser(sessionResult.rows[0].mentor_id, {
    type: "session_cancelled",
    session_id: sessionId,
  });

  return respond(200, { session_id: sessionId, status: "cancelled" });
}

// ─── POST /session/:id/end ───────────────────────────────────

async function handleSessionEnd(userId, event) {
  const sessionId = extractSessionId(event);
  const db = await getPool();

  const sessionResult = await db.query(
    `SELECT * FROM session
     WHERE id = $1 AND status = 'active'
       AND (mentee_id = $2 OR mentor_id = $2)`,
    [sessionId, userId]
  );

  if (sessionResult.rows.length === 0) {
    return respond(404, { error: "Active session not found" });
  }

  const session = sessionResult.rows[0];
  const isMentor = session.mentor_id === userId;

  // Check if peer is disconnected (grace period active)
  const billingEndTime = session.disconnected_at || null;

  const client = await db.connect();
  try {
    await client.query("BEGIN");

    if (billingEndTime) {
      // Peer disconnected — bill up to disconnect time, not NOW
      await client.query(
        `UPDATE session_segment
         SET ended_at = $2,
             duration_seconds = GREATEST(EXTRACT(EPOCH FROM $2::timestamptz - started_at)::int, 0)
         WHERE session_id = $1 AND ended_at IS NULL`,
        [sessionId, billingEndTime]
      );
    } else {
      await client.query(
        `UPDATE session_segment
         SET ended_at = NOW(),
             duration_seconds = EXTRACT(EPOCH FROM NOW() - started_at)::int
         WHERE session_id = $1 AND ended_at IS NULL`,
        [sessionId]
      );
    }

     // Fetch all segments ordered by time
     const segRows = await client.query(
      `SELECT duration_seconds, rate_per_minute
       FROM session_segment
       WHERE session_id = $1
       ORDER BY started_at`,
      [sessionId]
    );

   // Merge ALL same-rate segments (global pool by rate) before CEIL
   let totalDuration = 0;
   const rateBuckets = new Map();

   for (const seg of segRows.rows) {
     const dur = parseInt(seg.duration_seconds) || 0;
     const rate = parseFloat(seg.rate_per_minute) || 0;
     totalDuration += dur;
     rateBuckets.set(rate, (rateBuckets.get(rate) || 0) + dur);
   }

   let grossAmount = 0;
   for (const [rate, seconds] of rateBuckets) {
     grossAmount += Math.ceil(seconds / 60) * rate;
   }
    // Free chat: force zero billing
    if (session.billing_type === 'free_intro') {
      grossAmount = 0;
    }

    const platformFeeRate = 0.50;
    const platformFee = grossAmount * platformFeeRate;
    const mentorEarning = grossAmount - platformFee;

    if (grossAmount > 0) {
      await client.query(
        `INSERT INTO transaction (wallet_id, user_id, type, direction, amount, session_id, status)
         VALUES (
           (SELECT id FROM wallet WHERE user_id = $1 AND type = 'mentee'),
           $1, 'session_payment', 'debit', $2, $3, 'completed'
         )`,
        [session.mentee_id, grossAmount, sessionId]
      );

      await client.query(
        `INSERT INTO transaction (wallet_id, user_id, type, direction, amount, session_id, status)
         VALUES (
           (SELECT id FROM wallet WHERE user_id = $1 AND type = 'mentor'),
           $1, 'session_earning', 'credit', $2, $3, 'completed'
         )`,
        [session.mentor_id, mentorEarning, sessionId]
      );

      const PLATFORM_USER_ID = "00000000-0000-0000-0000-000000000000";
      await client.query(
        `INSERT INTO transaction (user_id, type, direction, amount, session_id, status)
         VALUES ($1, 'platform_fee', 'credit', $2, $3, 'completed')`,
        [PLATFORM_USER_ID, platformFee, sessionId]
      );
    }
  // Log free chat in transaction history (zero amount, same types as paid)
  if (session.billing_type === 'free_intro') {
    const PLATFORM_USER_ID_FC = "00000000-0000-0000-0000-000000000000";

    await client.query(
      `INSERT INTO transaction (wallet_id, user_id, type, direction, amount, session_id, status)
       VALUES (
         (SELECT id FROM wallet WHERE user_id = $1 AND type = 'mentee'),
         $1, 'session_payment', 'debit', 0, $2, 'completed'
       )`,
      [session.mentee_id, sessionId]
    );

    await client.query(
      `INSERT INTO transaction (wallet_id, user_id, type, direction, amount, session_id, status)
       VALUES (
         (SELECT id FROM wallet WHERE user_id = $1 AND type = 'mentor'),
         $1, 'session_earning', 'credit', 0, $2, 'completed'
       )`,
      [session.mentor_id, sessionId]
    );

    await client.query(
      `INSERT INTO transaction (user_id, type, direction, amount, session_id, status)
       VALUES ($1, 'platform_fee', 'credit', 0, $2, 'completed')`,
      [PLATFORM_USER_ID_FC, sessionId]
    );
  }

  await client.query(
    `UPDATE session
     SET status = 'completed',
           ended_at = COALESCE($5::timestamptz, NOW()),
           total_amount = $2,
           platform_fee = $3,
           mentor_earning = $4,
           disconnected_at = NULL,
           disconnected_user_id = NULL,
           grace_schedule_name = NULL
       WHERE id = $1`,
      [sessionId, grossAmount, platformFee, mentorEarning, billingEndTime]
    );

    if (grossAmount > 0) {
      await client.query(
        `UPDATE wallet
         SET balance = balance - $2, updated_at = NOW()
         WHERE user_id = $1 AND type = 'mentee'`,
        [session.mentee_id, grossAmount]
      );

      await client.query(
        `UPDATE wallet
         SET balance = balance + $2, updated_at = NOW()
         WHERE user_id = $1 AND type = 'mentor'`,
        [session.mentor_id, mentorEarning]
      );
    }

    await client.query("COMMIT");

    if (session.sfn_execution_arn) {
      try {
        await sfnClient.send(new StopExecutionCommand({
          executionArn: session.sfn_execution_arn,
          cause: `Session ended by ${isMentor ? 'mentor' : 'mentee'}`,
        }));
        console.log(`Cancelled SFN timeout for session ${sessionId}`);
      } catch (err) {
        console.log(`SFN cancel note: ${err.message}`);
      }
    }

    // Clean up grace schedule if active
    if (session.grace_schedule_name) {
      try {
        await schedulerClient.send(new DeleteScheduleCommand({
          Name: session.grace_schedule_name,
        }));
        console.log(`Deleted grace schedule: ${session.grace_schedule_name}`);
      } catch (err) {
        console.log(`Grace schedule delete note: ${err.message}`);
      }
    }

    const segments = await db.query(
      `SELECT type, duration_seconds, rate_per_minute,
              CEIL(duration_seconds / 60.0) * rate_per_minute as cost
       FROM session_segment
       WHERE session_id = $1
       ORDER BY started_at`,
      [sessionId]
    );

    const summary = {
      session_id: sessionId,
      total_duration_seconds: totalDuration,
      gross_amount: grossAmount,
      platform_fee: platformFee,
      mentor_earning: mentorEarning,
      segments: segments.rows.map(s => ({
        type: s.type,
        duration_seconds: parseInt(s.duration_seconds) || 0,
        rate_per_minute: parseFloat(s.rate_per_minute) || 0,
        cost: parseFloat(s.cost) || 0,
      })),
    };

    const endedByLabel = isMentor ? "mentor" : "mentee";
    const sessionMode = session.requested_session_type || 'chat';

    // Persist system message in chat history
    const mentorRow = (await db.query(
      `SELECT first_name, last_name FROM mentor_profile WHERE user_id = $1`, [session.mentor_id]
    )).rows[0];
    const mentorName = [mentorRow?.first_name, mentorRow?.last_name].filter(Boolean).join(' ') || "Mentor";

    const menteeRow = (await db.query(
      `SELECT first_name, last_name FROM mentee_profile WHERE user_id = $1`, [session.mentee_id]
    )).rows[0];
    const menteeName = [menteeRow?.first_name, menteeRow?.last_name].filter(Boolean).join(' ') || "Mentee";
    const endedByName = isMentor ? mentorName : menteeName;

    const endedMsgId = `msg_${Date.now().toString(36)}_system`;
    const endedMsgAt = new Date().toISOString();

    await dynamoClient.send(new PutCommand({
      TableName: "mentortalk-messages",
      Item: {
        session_id: sessionId,
        message_id: endedMsgId,
        sender_id: "system",
        type: "system",
        content: `${endedByName} ended the ${sessionMode === 'audio' ? 'audio call' : sessionMode === 'video' ? 'video call' : 'chat'}`,
        created_at: endedMsgAt,
      },
    }));

    await pushToUser(session.mentee_id, {
      type: "new_message",
      message_id: endedMsgId,
      session_id: sessionId,
      sender_id: "system",
      content: `${endedByName} ended the ${sessionMode === 'audio' ? 'audio call' : sessionMode === 'video' ? 'video call' : 'chat'}`,
      message_type: "system",
      created_at: endedMsgAt,
    });
    await pushToUser(session.mentor_id, {
      type: "new_message",
      message_id: endedMsgId,
      session_id: sessionId,
      sender_id: "system",
      content: `${endedByName} ended the ${sessionMode === 'audio' ? 'audio call' : sessionMode === 'video' ? 'video call' : 'chat'}`,
      message_type: "system",
      created_at: endedMsgAt,
    });
    await pushToUser(
      session.mentee_id,
      { type: "session_ended", ended_by: endedByLabel, ...summary },
      {
        title: "Session Ended",
        body: `Session ended. Duration: ${Math.ceil(totalDuration / 60)} min. Cost: ₹${grossAmount}`,
        data: { type: "session_ended", session_id: sessionId },
      }
    );

    // Update presence BEFORE notifying users — prevents race where
    // mentee fetches chat list and sees stale "in_session" status
    await broadcastPresenceUpdate(session.mentor_id, "online");

    await pushToUser(
      session.mentor_id,
      { type: "session_ended", ended_by: endedByLabel, ...summary },
      {
        title: "Session Ended",
        body: `Session ended. Duration: ${Math.ceil(totalDuration / 60)} min. Earned: ₹${mentorEarning}`,
        data: { type: "session_ended", session_id: sessionId },
      }
    );
    await promoteNextPendingSession(db, session.mentor_id);

    return respond(200, summary);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

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

  // Create timeout schedule for promoted session
  const scheduleName = await createRequestTimeoutSchedule(promoted.id);
  if (scheduleName) {
    await db.query(
      `UPDATE session SET request_timeout_schedule = $2 WHERE id = $1`,
      [promoted.id, scheduleName]
    );
  }

  // Fetch mentee name
  const menteeResult = await db.query(
    `SELECT first_name, last_name, profile_photo_url FROM mentee_profile WHERE user_id = $1`,
    [promoted.mentee_id]
  );
  const menteeRow = menteeResult.rows[0];
  const menteeName = [menteeRow?.first_name, menteeRow?.last_name].filter(Boolean).join(' ') || 'Mentee';
  const menteeAvatar = toFullUrl(menteeRow?.profile_photo_url);

  // Fetch rate for the push payload
  const mentorProfile = await db.query(
    `SELECT rate_per_minute FROM mentor_profile WHERE user_id = $1`,
    [mentorId]
  );
  const ratePerMinute = parseFloat(mentorProfile.rows[0]?.rate_per_minute) || 0;

  const promotedType = promoted.requested_session_type || "chat";

  // Get billing type for promoted session
  const promotedSession = await db.query(
    `SELECT billing_type FROM session WHERE id = $1`,
    [promoted.id]
  );
  const promotedBillingType = promotedSession.rows[0]?.billing_type || 'paid';
  let promotedEffectiveRate = ratePerMinute;
  let promotedNormalRate = undefined;

  if (promotedBillingType === 'intro_rate') {
    const cfgPromo = await db.query(
      `SELECT intro_rate_per_minute FROM promo_config WHERE id = 1`
    );
    promotedEffectiveRate = parseFloat(cfgPromo.rows[0]?.intro_rate_per_minute) || ratePerMinute;
    promotedNormalRate = ratePerMinute;
  }

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

  await pushToUser(promoted.mentee_id, {
    type: "session_promoted",
    session_id: promoted.id,
    message: "Your session request has been sent to the mentor",
  });

  console.log(`Promoted session ${promoted.id} from pending to requested`);
}
// ─── POST /session/free-chat ─────────────────────────────────

async function handleFreeChat(menteeId, event) {
  const db = await getPool();

  // 1. Load promo config
  const configResult = await db.query(`SELECT * FROM promo_config WHERE id = 1`);
  if (configResult.rows.length === 0 || !configResult.rows[0].free_chat_enabled) {
    return respond(400, { error: "Free chat is not available" });
  }
  const cfg = configResult.rows[0];

  // 2. Check mentee eligibility
  const promoResult = await db.query(
    `SELECT free_chat_used FROM mentee_promo_status WHERE user_id = $1`,
    [menteeId]
  );

  if (promoResult.rows.length === 0) {
    // Auto-create if missing
    await db.query(
      `INSERT INTO mentee_promo_status (user_id) VALUES ($1) ON CONFLICT DO NOTHING`,
      [menteeId]
    );
  } else if (promoResult.rows[0].free_chat_used) {
    return respond(409, { error: "Free chat already used" });
  }

  // 3. Check no active/pending session
  const activeSession = await db.query(
    `SELECT id FROM session
     WHERE mentee_id = $1 AND status IN ('requested', 'active', 'pending')`,
    [menteeId]
  );
  if (activeSession.rows.length > 0) {
    return respond(409, {
      error: "You already have an active or pending session",
      session_id: activeSession.rows[0].id,
    });
  }

  // 4. Get mentee's categories for matching
  const menteeCategories = await db.query(
    `SELECT mentorship_category_id FROM user_mentorship WHERE user_id = $1 AND role = 'mentee'`,
    [menteeId]
  );
  const menteeCategoryIds = menteeCategories.rows.map(r => r.mentorship_category_id);

  if (menteeCategoryIds.length === 0) {
    return respond(400, { error: "No mentorship categories selected" });
  }

  // 5. Find eligible mentors: online, available, free_chat_enabled, quota not exhausted, category overlap
  const mentorCandidates = await db.query(
    `SELECT mp.user_id, mp.first_name, mp.last_name, mp.profile_photo_url,
       COALESCE(q.count, 0) AS free_chat_count
     FROM mentor_profile mp
     JOIN "user" u ON u.id = mp.user_id
     JOIN mentorship_application ma ON ma.user_id = mp.user_id
     LEFT JOIN mentor_free_chat_quota q
       ON q.mentor_id = mp.user_id AND q.date = CURRENT_DATE
     WHERE u.account_status = 'active'
       AND ma.submission_status = 'approved'
       AND mp.is_available = TRUE
       AND mp.free_chat_enabled = TRUE
       AND EXISTS (
         SELECT 1 FROM user_mentorship um
         WHERE um.user_id = mp.user_id
           AND um.role = 'mentor'
           AND um.mentorship_category_id = ANY($1)
       )
       AND NOT EXISTS (
         SELECT 1 FROM session s
         WHERE s.mentor_id = mp.user_id AND s.status = 'active'
       )
       AND COALESCE(q.count, 0) < COALESCE(q.max_count, $2)
       AND mp.user_id != $3
     ORDER BY free_chat_count ASC, RANDOM()
     LIMIT 5`,
      [menteeCategoryIds, cfg.mentor_daily_free_cap, menteeId]
  );

  if (mentorCandidates.rows.length === 0) {
    return respond(503, {
      error: "No mentors available for free chat right now",
      retry_after: 60,
    });
  }

  // 6. Check presence — find first online mentor
  let selectedMentor = null;
  const remainingMentors = [];

  for (const mentor of mentorCandidates.rows) {
    const presence = await dynamoClient.send(new GetCommand({
      TableName: "mentortalk-presence",
      Key: { user_id: mentor.user_id },
    }));

    if (!selectedMentor && presence.Item?.status === "online") {
      selectedMentor = mentor;
    } else {
      remainingMentors.push(mentor.user_id);
    }
  }

  if (!selectedMentor) {
    return respond(503, {
      error: "No mentors online for free chat right now",
      retry_after: 60,
    });
  }

  // 7. Create session with billing_type = 'free_intro'
  const sessionResult = await db.query(
    `INSERT INTO session
       (mentee_id, mentor_id, status, requested_session_type, billing_type, started_at)
     VALUES ($1, $2, 'requested', 'chat', 'free_intro', NOW())
     RETURNING id, status`,
    [menteeId, selectedMentor.user_id]
  );
  const sessionId = sessionResult.rows[0].id;

  // 8. Store forwarding queue in DynamoDB
  await dynamoClient.send(new PutCommand({
    TableName: "mentortalk-free-chat-queue",
    Item: {
      session_id: sessionId,
      remaining_mentors: remainingMentors,
      current_mentor_index: 0,
      created_at: new Date().toISOString(),
      ttl: Math.floor(Date.now() / 1000) + 300,
    },
  }));

  // 9. Create 10-second timeout schedule
  const scheduleName = `free-chat-${sessionId}`;
  const fireAt = new Date(Date.now() + cfg.free_chat_timeout_secs * 1000);

  try {
    await schedulerClient.send(new CreateScheduleCommand({
      Name: scheduleName,
      ScheduleExpression: `at(${fireAt.toISOString().replace(/\.\d{3}Z$/, '')})`,
      ScheduleExpressionTimezone: "UTC",
      FlexibleTimeWindow: { Mode: "OFF" },
      Target: {
        Arn: FREE_CHAT_TIMEOUT_LAMBDA_ARN,
        RoleArn: SCHEDULER_ROLE_ARN,
        Input: JSON.stringify({ sessionId }),
      },
      ActionAfterCompletion: "DELETE",
    }));

    await db.query(
      `UPDATE session SET request_timeout_schedule = $2 WHERE id = $1`,
      [sessionId, scheduleName]
    );
  } catch (err) {
    console.error("Failed to create free chat timeout schedule:", err.message);
  }

  // 10. Get mentee info for push
  const menteeResult = await db.query(
    `SELECT first_name, last_name, profile_photo_url FROM mentee_profile WHERE user_id = $1`,
    [menteeId]
  );
  const menteeRow = menteeResult.rows[0];
  const menteeName = [menteeRow?.first_name, menteeRow?.last_name].filter(Boolean).join(' ') || 'Mentee';
  const menteeAvatar = toFullUrl(menteeRow?.profile_photo_url);

  // 11. Push to mentor
  await pushToUser(
    selectedMentor.user_id,
    {
      type: "session_request",
      session_id: sessionId,
      mentee_id: menteeId,
      mentee_name: menteeName,
      mentee_avatar: menteeAvatar,
      session_type: "chat",
      is_free_chat: true,
      rate_per_minute: 0,
      timeout_seconds: cfg.free_chat_timeout_secs,
    },
    {
      title: "Free Chat Request",
      body: `${menteeName} wants a free intro chat`,
      data: {
        type: "session_request",
        session_id: sessionId,
        is_free_chat: "true",
      },
    }
  );

  return respond(201, {
    session_id: sessionId,
    status: "requested",
    mentor_name: `${selectedMentor.first_name} ${selectedMentor.last_name}`.trim(),
    mentor_avatar: toFullUrl(selectedMentor.profile_photo_url),
    session_type: "chat",
    billing_type: "free_intro",
    timeout_seconds: cfg.free_chat_timeout_secs,
  });
}

// ─── GET /session/free-chat/availability ─────────────────────

async function handleFreeChatAvailability(menteeId, event) {
  const db = await getPool();

  // 1. Check global config
  const configResult = await db.query(`SELECT * FROM promo_config WHERE id = 1`);
  if (configResult.rows.length === 0 || !configResult.rows[0].free_chat_enabled) {
    return respond(200, { available: false, reason: "feature_disabled" });
  }
  const cfg = configResult.rows[0];

  // 2. Check mentee eligibility
  const promoResult = await db.query(
    `SELECT free_chat_used FROM mentee_promo_status WHERE user_id = $1`,
    [menteeId]
  );

  if (promoResult.rows.length > 0 && promoResult.rows[0].free_chat_used) {
    return respond(200, { available: false, reason: "already_used" });
  }

  // 3. Get mentee categories
  const menteeCategories = await db.query(
    `SELECT mentorship_category_id FROM user_mentorship WHERE user_id = $1 AND role = 'mentee'`,
    [menteeId]
  );
  const menteeCategoryIds = menteeCategories.rows.map(r => r.mentorship_category_id);

  if (menteeCategoryIds.length === 0) {
    return respond(200, { available: false, reason: "no_categories" });
  }

  // 4. Count eligible mentors (quick check, no presence lookup)
  const mentorCount = await db.query(
    `SELECT COUNT(DISTINCT mp.user_id) as count
     FROM mentor_profile mp
     JOIN "user" u ON u.id = mp.user_id
     JOIN mentorship_application ma ON ma.user_id = mp.user_id
     JOIN user_mentorship um ON um.user_id = mp.user_id
     LEFT JOIN mentor_free_chat_quota q
       ON q.mentor_id = mp.user_id AND q.date = CURRENT_DATE
     WHERE u.account_status = 'active'
       AND ma.submission_status = 'approved'
       AND mp.is_available = TRUE
       AND mp.free_chat_enabled = TRUE
       AND um.mentorship_category_id = ANY($1)
       AND NOT EXISTS (
         SELECT 1 FROM session s
         WHERE s.mentor_id = mp.user_id AND s.status = 'active'
       )
       AND COALESCE(q.count, 0) < COALESCE(q.max_count, $2)`,
    [menteeCategoryIds, cfg.mentor_daily_free_cap]
  );

  const count = parseInt(mentorCount.rows[0].count);

  return respond(200, {
    available: count > 0,
    mentor_count: count,
    free_chat_duration_secs: cfg.free_chat_duration_secs,
  });
}

// ─── Helper: Extract Session ID ──────────────────────────────

function extractSessionId(event) {
  const pathParts = (event.path || event.resource || "").split("/");
  return event.pathParameters?.session_id || pathParts[2];
}


// ─── POST /session/:id/switch ────────────────────────────────

async function handleModeSwitchRequest(userId, event) {
  const sessionId = extractSessionId(event);
  const body = JSON.parse(event.body || "{}");
  const { new_type } = body;

  if (!new_type || !["audio", "video"].includes(new_type)) {
    return respond(400, { error: "new_type must be 'audio' or 'video'" });
  }

  const db = await getPool();

  // 1. Validate session is active and user belongs to it
  const sessionResult = await db.query(
  `SELECT s.*, mp.rate_per_minute, mp.pref_audio, mp.pref_video
     FROM session s
     JOIN mentor_profile mp ON mp.user_id = s.mentor_id
     WHERE s.id = $1 AND s.status = 'active'
       AND (s.mentee_id = $2 OR s.mentor_id = $2)`,
    [sessionId, userId]
  );

  if (sessionResult.rows.length === 0) {
    return respond(404, { error: "Active session not found" });
  }

  const session = sessionResult.rows[0];
   // 1b. Check mentor preferences for requested mode
   if (new_type === 'audio' && !session.pref_audio) {
    return respond(400, { error: "Mentor doesn't accept audio sessions" });
  }
  if (new_type === 'video' && !session.pref_video) {
    return respond(400, { error: "Mentor doesn't accept video sessions" });
  }

  // 2. Check no switch is already pending
  if (session.pending_switch_type) {
    return respond(409, { error: "A mode switch is already pending" });
  }

  // 3. Check not already in requested mode
  const currentSegment = await db.query(
    `SELECT type FROM session_segment
     WHERE session_id = $1 AND ended_at IS NULL
     ORDER BY started_at DESC LIMIT 1`,
    [sessionId]
  );

  const currentType = currentSegment.rows[0]?.type || "chat";
  if (currentType === new_type) {
    return respond(400, { error: `Already in ${new_type} mode` });
  }

  // 4. Calculate new rate and check mentee balance
  const baseRate = parseFloat(session.rate_per_minute);
  const newRate = new_type === "video" ? baseRate * 1.5 : baseRate;

  const balanceResult = await db.query(
    `SELECT balance FROM wallet WHERE user_id = $1 AND type = 'mentee'`,
    [session.mentee_id]
  );

  const balance = parseFloat(balanceResult.rows[0].balance);

  const completedSegs = await db.query(
    `SELECT duration_seconds, rate_per_minute
     FROM session_segment
     WHERE session_id = $1 AND ended_at IS NOT NULL
     ORDER BY started_at`,
    [sessionId]
  );

  let alreadySpent = 0;
  let mSec = 0;
  let mRate = null;
  for (const seg of completedSegs.rows) {
    const dur = parseInt(seg.duration_seconds) || 0;
    const rate = parseFloat(seg.rate_per_minute) || 0;
    if (rate === mRate) {
      mSec += dur;
    } else {
      if (mRate !== null) alreadySpent += Math.ceil(mSec / 60) * mRate;
      mRate = rate;
      mSec = dur;
    }
  }
  if (mRate !== null) alreadySpent += Math.ceil(mSec / 60) * mRate;

  // Also account for the currently running (unclosed) segment
  const runningCost = await db.query(
    `SELECT COALESCE(
       SUM(CEIL(EXTRACT(EPOCH FROM NOW() - started_at)::int / 60.0) * rate_per_minute), 0
     ) as cost
     FROM session_segment
     WHERE session_id = $1 AND ended_at IS NULL`,
    [sessionId]
  );
  alreadySpent += parseFloat(runningCost.rows[0].cost);

  const remainingBalance = balance - alreadySpent;
  const minimumForSwitch = newRate * 2;

  if (remainingBalance < minimumForSwitch) {
    return respond(402, {
      error: "Insufficient balance for mode switch",
      balance: remainingBalance,
      minimum_required: minimumForSwitch,
    });
  }

  // 5. Store pending switch
  await db.query(
    `UPDATE session SET pending_switch_type = $2 WHERE id = $1`,
    [sessionId, new_type]
  );

  // 6. Determine the other user and push notification
  const otherId = userId === session.mentor_id ? session.mentee_id : session.mentor_id;
  // Get requester name (from profile table, not user table)
  const isMentor = session.mentor_id === userId;
  const profileTable = isMentor ? 'mentor_profile' : 'mentee_profile';
  const requesterResult = await db.query(
    `SELECT first_name, last_name FROM ${profileTable} WHERE user_id = $1`,
    [userId]
  );
  const row = requesterResult.rows[0];
  const requesterName = [row?.first_name, row?.last_name].filter(Boolean).join(' ') || 'User';

  await pushToUser(
    otherId,
    {
      type: "mode_switch_request",
      session_id: sessionId,
      requested_by: userId,
      requester_name: requesterName,
      new_type,
      current_type: currentType,
      current_rate: currentType === "video" ? baseRate * 1.5 : baseRate,
      new_rate: newRate,
    },
    {
      title: "Mode Switch Request",
      body: `${requesterName} wants to switch to ${new_type}`,
      data: {
        type: "mode_switch_request",
        session_id: sessionId,
        new_type,
      },
    }
  );

  return respond(200, {
    session_id: sessionId,
    status: "pending",
    new_type,
    new_rate: newRate,
  });
}

// ─── POST /session/:id/switch/accept ─────────────────────────

async function handleModeSwitchAccept(userId, event) {
  const sessionId = extractSessionId(event);
  const db = await getPool();

  // 1. Validate session + pending switch exists
  const sessionResult = await db.query(
    `SELECT s.*, mp.rate_per_minute
     FROM session s
     JOIN mentor_profile mp ON mp.user_id = s.mentor_id
     WHERE s.id = $1 AND s.status = 'active'
       AND s.pending_switch_type IS NOT NULL
       AND (s.mentee_id = $2 OR s.mentor_id = $2)`,
    [sessionId, userId]
  );

  if (sessionResult.rows.length === 0) {
    return respond(404, { error: "No pending mode switch found" });
  }

  const session = sessionResult.rows[0];
  const newType = session.pending_switch_type;
  const baseRate = parseFloat(session.rate_per_minute);
  const newRate = newType === "video" ? baseRate * 1.5 : baseRate;

  // 2. DB transaction: close current segment, create new one
  const client = await db.connect();
  let closedSegmentDuration = 0;
  let closedSegmentType = "chat";

  try {
    await client.query("BEGIN");

    // Close current active segment
    const closedSegment = await client.query(
      `UPDATE session_segment
       SET ended_at = NOW(),
           duration_seconds = EXTRACT(EPOCH FROM NOW() - started_at)::int
       WHERE session_id = $1 AND ended_at IS NULL
       RETURNING type, duration_seconds`,
      [sessionId]
    );

    if (closedSegment.rows.length > 0) {
      closedSegmentType = closedSegment.rows[0].type;
      closedSegmentDuration = closedSegment.rows[0].duration_seconds;
    }

    // Create new segment with locked rate
    await client.query(
      `INSERT INTO session_segment (session_id, type, rate_per_minute, started_at)
       VALUES ($1, $2, $3, NOW())`,
      [sessionId, newType, newRate]
    );

    // Clear pending switch
    await client.query(
      `UPDATE session SET pending_switch_type = NULL WHERE id = $1`,
      [sessionId]
    );

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  // 3. Insert system events in DynamoDB
  const now = new Date().toISOString();

  await dynamoClient.send(new PutCommand({
    TableName: "mentortalk-messages",
    Item: {
      session_id: sessionId,
      message_id: `msg_${Date.now().toString(36)}_sys_end`,
      sender_id: "system",
      type: "system",
      content: `${closedSegmentType === "chat" ? "Chat" : closedSegmentType === "audio" ? "Audio call" : "Video call"} ended`,
      system_event: `${closedSegmentType}_ended`,
      metadata: JSON.stringify({ duration_seconds: closedSegmentDuration }),
      created_at: now,
    },
  }));

  await dynamoClient.send(new PutCommand({
    TableName: "mentortalk-messages",
    Item: {
      session_id: sessionId,
      message_id: `msg_${(Date.now() + 1).toString(36)}_sys_start`,
      sender_id: "system",
      type: "system",
      content: `${newType === "audio" ? "Audio" : "Video"} call started`,
      system_event: `${newType}_started`,
      created_at: new Date(Date.now() + 1).toISOString(),
    },
  }));

  // 4. Generate Agora token (placeholder — Step 3 will add agoraHelper)
  // TODO: Replace with actual Agora token generation
 // 4. Generate Agora tokens (one per user — different UIDs)
  const mentorAgora = await generateAgoraToken(sessionId, 1);
  const menteeAgora = await generateAgoraToken(sessionId, 2);

    // 5. Recalculate max duration with new rate (before WS push)
    const balanceResult = await db.query(
      `SELECT balance FROM wallet WHERE user_id = $1 AND type = 'mentee'`,
      [session.mentee_id]
    );
    const menteeBalance = parseFloat(balanceResult.rows[0].balance);

  const completedSegs = await db.query(
    `SELECT duration_seconds, rate_per_minute
     FROM session_segment
     WHERE session_id = $1 AND ended_at IS NOT NULL
     ORDER BY started_at`,
    [sessionId]
  );

  let alreadySpent = 0;
  let mSec = 0;
  let mRate = null;
  for (const seg of completedSegs.rows) {
    const dur = parseInt(seg.duration_seconds) || 0;
    const rate = parseFloat(seg.rate_per_minute) || 0;
    if (rate === mRate) {
      mSec += dur;
    } else {
      if (mRate !== null) alreadySpent += Math.ceil(mSec / 60) * mRate;
      mRate = rate;
      mSec = dur;
    }
  }
  if (mRate !== null) alreadySpent += Math.ceil(mSec / 60) * mRate;
  const remainingBalance = menteeBalance - alreadySpent;
  const maxDurationMinutes = Math.floor(remainingBalance / newRate);
  const maxDurationSeconds = maxDurationMinutes * 60;

  // 6. Build system messages for real-time chat
  const endMsg = {
    type: "new_message",
    session_id: sessionId,
    message_id: `msg_${Date.now().toString(36)}_sys_end`,
    sender_id: "system",
    content: `${closedSegmentType === "chat" ? "Chat" : closedSegmentType === "audio" ? "Audio call" : "Video call"} ended`,
    message_type: "system",
    created_at: now,
  };

  const startMsg = {
    type: "new_message",
    session_id: sessionId,
    message_id: `msg_${(Date.now() + 1).toString(36)}_sys_start`,
    sender_id: "system",
    content: `${newType === "audio" ? "Audio" : "Video"} call started`,
    message_type: "system",
    created_at: new Date(Date.now() + 1).toISOString(),
  };

  // 7. Push mode_switch_accepted + system messages to both users
  await pushToUser(session.mentor_id, {
    type: "mode_switch_accepted",
    session_id: sessionId,
    new_type: newType,
    new_rate: newRate,
    agora_channel: mentorAgora.channel,
    agora_token: mentorAgora.token,
    agora_uid: mentorAgora.uid,
    agora_app_id: mentorAgora.app_id,
    max_duration_seconds: maxDurationSeconds,
  });
  await pushToUser(session.mentor_id, endMsg);
  await pushToUser(session.mentor_id, startMsg);

  await pushToUser(session.mentee_id, {
    type: "mode_switch_accepted",
    session_id: sessionId,
    new_type: newType,
    new_rate: newRate,
    agora_channel: menteeAgora.channel,
    agora_token: menteeAgora.token,
    agora_uid: menteeAgora.uid,
    agora_app_id: menteeAgora.app_id,
    max_duration_seconds: maxDurationSeconds,
  });
  await pushToUser(session.mentee_id, endMsg);
  await pushToUser(session.mentee_id, startMsg);

  // 8. Update SFN timeout with new duration
  if (session.sfn_execution_arn) {
    try {
      await sfnClient.send(new StopExecutionCommand({
        executionArn: session.sfn_execution_arn,
        cause: "Mode switch — restarting with new duration",
      }));
    } catch (err) {
      console.log(`SFN stop note: ${err.message}`);
    }
  }

  // Start new SFN with updated max duration
  try {
    const execution = await sfnClient.send(new StartExecutionCommand({
      stateMachineArn: SFN_ARN,
      name: `session-${sessionId}-switch-${Date.now()}`,
      input: JSON.stringify({ sessionId, maxDurationSeconds }),
    }));

    await db.query(
      `UPDATE session SET sfn_execution_arn = $2 WHERE id = $1`,
      [sessionId, execution.executionArn]
    );
  } catch (err) {
    console.error("Failed to restart SFN after switch:", err.message);
  }

  return respond(200, {
    session_id: sessionId,
    new_type: newType,
    new_rate: newRate,
agora_channel: mentorAgora.channel,
    max_duration_seconds: maxDurationSeconds,
  });
}

// ─── POST /session/:id/switch/decline ────────────────────────

async function handleModeSwitchDecline(userId, event) {
  const sessionId = extractSessionId(event);
  const db = await getPool();

  // 1. Validate session + pending switch
  const sessionResult = await db.query(
    `SELECT * FROM session
     WHERE id = $1 AND status = 'active'
       AND pending_switch_type IS NOT NULL
       AND (mentee_id = $2 OR mentor_id = $2)`,
    [sessionId, userId]
  );

  if (sessionResult.rows.length === 0) {
    return respond(404, { error: "No pending mode switch found" });
  }

  const session = sessionResult.rows[0];

  // 2. Clear pending switch
  await db.query(
    `UPDATE session SET pending_switch_type = NULL WHERE id = $1`,
    [sessionId]
  );

  // 3. Notify the requester
  const otherId = userId === session.mentor_id ? session.mentee_id : session.mentor_id;

  await pushToUser(otherId, {
    type: "mode_switch_declined",
    session_id: sessionId,
  });

  return respond(200, {
    session_id: sessionId,
    status: "declined",
  });
}

// ─── POST /session/:id/call/end ──────────────────────────────

async function handleCallEnd(userId, event) {
  const sessionId = extractSessionId(event);
  const db = await getPool();

  // 1. Validate active session with active call segment
  const sessionResult = await db.query(
    `SELECT s.*
     FROM session s
     WHERE s.id = $1 AND s.status = 'active'
       AND (s.mentee_id = $2 OR s.mentor_id = $2)`,
    [sessionId, userId]
  );

  if (sessionResult.rows.length === 0) {
    return respond(404, { error: "Active session not found" });
  }

  const session = sessionResult.rows[0];

  // Verify current segment is a call (audio/video), not chat
  const currentSegment = await db.query(
    `SELECT type FROM session_segment
     WHERE session_id = $1 AND ended_at IS NULL
     ORDER BY started_at DESC LIMIT 1`,
    [sessionId]
  );

  const currentType = currentSegment.rows[0]?.type;
  if (!currentType || currentType === "chat") {
    return respond(400, { error: "No active call to end" });
  }

  // 2. Get base rate for new chat segment
  const mentorProfile = await db.query(
    `SELECT rate_per_minute FROM mentor_profile WHERE user_id = $1`,
    [session.mentor_id]
  );
  const chatRate = parseFloat(mentorProfile.rows[0].rate_per_minute);

  // 3. DB transaction: close call segment, create chat segment
  const client = await db.connect();
  let callDuration = 0;

  try {
    await client.query("BEGIN");

    // Close active call segment
    const closedSegment = await client.query(
      `UPDATE session_segment
       SET ended_at = NOW(),
           duration_seconds = EXTRACT(EPOCH FROM NOW() - started_at)::int
       WHERE session_id = $1 AND ended_at IS NULL
       RETURNING duration_seconds`,
      [sessionId]
    );

    callDuration = closedSegment.rows[0]?.duration_seconds || 0;

    // Create new chat segment (auto-resume)
    await client.query(
      `INSERT INTO session_segment (session_id, type, rate_per_minute, started_at)
       VALUES ($1, 'chat', $2, NOW())`,
      [sessionId, chatRate]
    );

    // Clear any stale pending switch
    await client.query(
      `UPDATE session SET pending_switch_type = NULL WHERE id = $1`,
      [sessionId]
    );

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  // 4. Insert system events in DynamoDB
  const now = new Date().toISOString();

  await dynamoClient.send(new PutCommand({
    TableName: "mentortalk-messages",
    Item: {
      session_id: sessionId,
      message_id: `msg_${Date.now().toString(36)}_sys_callend`,
      sender_id: "system",
      type: "system",
      content: `${currentType === "audio" ? "Audio" : "Video"} call ended`,
      system_event: `${currentType}_ended`,
      metadata: JSON.stringify({ duration_seconds: callDuration }),
      created_at: now,
    },
  }));

  await dynamoClient.send(new PutCommand({
    TableName: "mentortalk-messages",
    Item: {
      session_id: sessionId,
      message_id: `msg_${(Date.now() + 1).toString(36)}_sys_chatstart`,
      sender_id: "system",
      type: "system",
      content: "Chat started",
      system_event: "chat_started",
      created_at: new Date(Date.now() + 1).toISOString(),
    },
  }));

 // 5. Recalculate max duration for remaining chat
 const balanceResult = await db.query(
  `SELECT balance FROM wallet WHERE user_id = $1 AND type = 'mentee'`,
  [session.mentee_id]
);
const menteeBalance = parseFloat(balanceResult.rows[0].balance);

  const completedSegs = await db.query(
    `SELECT duration_seconds, rate_per_minute
     FROM session_segment
     WHERE session_id = $1 AND ended_at IS NOT NULL
     ORDER BY started_at`,
    [sessionId]
  );

  let alreadySpent = 0;
  let mSec = 0;
  let mRate = null;
  for (const seg of completedSegs.rows) {
    const dur = parseInt(seg.duration_seconds) || 0;
    const rate = parseFloat(seg.rate_per_minute) || 0;
    if (rate === mRate) {
      mSec += dur;
    } else {
      if (mRate !== null) alreadySpent += Math.ceil(mSec / 60) * mRate;
      mRate = rate;
      mSec = dur;
    }
  }
  if (mRate !== null) alreadySpent += Math.ceil(mSec / 60) * mRate;
  const remainingBalance = menteeBalance - alreadySpent;
  const maxDurationMinutes = Math.floor(remainingBalance / chatRate);
  const maxDurationSeconds = maxDurationMinutes * 60;
  

  // 6. Restart SFN timeout with updated duration
  if (session.sfn_execution_arn) {
    try {
      await sfnClient.send(new StopExecutionCommand({
        executionArn: session.sfn_execution_arn,
        cause: "Call ended — restarting with updated duration",
      }));
    } catch (err) {
      console.log(`SFN stop note: ${err.message}`);
    }
  }

  try {
    const execution = await sfnClient.send(new StartExecutionCommand({
      stateMachineArn: SFN_ARN,
      name: `session-${sessionId}-callend-${Date.now()}`,
      input: JSON.stringify({ sessionId, maxDurationSeconds }),
    }));

    await db.query(
      `UPDATE session SET sfn_execution_arn = $2 WHERE id = $1`,
      [sessionId, execution.executionArn]
    );
  } catch (err) {
    console.error("Failed to restart SFN after call end:", err.message);
  }

  // 7. Push system messages via WS so they appear in real-time chat
  const callEndMsg = {
    type: "new_message",
    session_id: sessionId,
    message_id: `msg_${Date.now().toString(36)}_sys_callend`,
    sender_id: "system",
    content: `${currentType === "audio" ? "Audio" : "Video"} call ended`,
    message_type: "system",
    created_at: now,
  };

  const chatStartMsg = {
    type: "new_message",
    session_id: sessionId,
    message_id: `msg_${(Date.now() + 1).toString(36)}_sys_chatstart`,
    sender_id: "system",
    content: "Chat started",
    message_type: "system",
    created_at: new Date(Date.now() + 1).toISOString(),
  };

  // 8. Push call_ended event + system messages to both users
  const callEndPayload = {
    type: "call_ended",
    session_id: sessionId,
    ended_type: currentType,
    duration_seconds: callDuration,
    max_duration_seconds: maxDurationSeconds,
    chat_rate: chatRate,
  };

  await pushToUser(session.mentor_id, callEndPayload);
  await pushToUser(session.mentor_id, callEndMsg);
  await pushToUser(session.mentor_id, chatStartMsg);
  await pushToUser(session.mentee_id, callEndPayload);
  await pushToUser(session.mentee_id, callEndMsg);
  await pushToUser(session.mentee_id, chatStartMsg);

  return respond(200, {
    session_id: sessionId,
    ended_type: currentType,
    duration_seconds: callDuration,
    resumed_type: "chat",
    chat_rate: chatRate,
    max_duration_seconds: maxDurationSeconds,
  });
}

// ─── POST /session/:id/review ────────────────────────────────

async function handleSubmitReview(userId, event) {
  const sessionId = extractSessionId(event);
  const body = JSON.parse(event.body || "{}");
  const { rating, comment } = body;

  if (!rating || rating < 1 || rating > 5) {
    return respond(400, { error: "rating is required (1-5)" });
  }

  const db = await getPool();

  const sessionResult = await db.query(
    `SELECT mentor_id, mentee_id, status FROM session WHERE id = $1`,
    [sessionId]
  );

  if (sessionResult.rows.length === 0) {
    return respond(404, { error: "Session not found" });
  }

  const session = sessionResult.rows[0];

  if (session.mentee_id !== userId) {
    return respond(403, { error: "Only the mentee can review a session" });
  }

  if (session.status !== "completed") {
    return respond(400, { error: "Can only review completed sessions" });
  }

  const existingReview = await db.query(
    `SELECT id FROM review WHERE session_id = $1`,
    [sessionId]
  );

  if (existingReview.rows.length > 0) {
    return respond(409, { error: "Session already reviewed" });
  }

  const client = await db.connect();
  try {
    await client.query("BEGIN");

    await client.query(
      `INSERT INTO review (session_id, mentor_id, mentee_id, rating, comment)
       VALUES ($1, $2, $3, $4, $5)`,
      [sessionId, session.mentor_id, userId, rating, comment?.trim() || null]
    );

    await client.query(
      `UPDATE mentor_profile
       SET avg_rating = (
             SELECT COALESCE(AVG(rating), 0)
             FROM review WHERE mentor_id = $1
           ),
           total_reviews = (
             SELECT COUNT(*)
             FROM review WHERE mentor_id = $1
           ),
           updated_at = NOW()
       WHERE user_id = $1`,
      [session.mentor_id]
    );

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  return respond(201, {
    message: "Review submitted",
    session_id: sessionId,
    rating,
  });
}

// ─── POST /session/:id/refresh-duration ──────────────────────

async function handleRefreshDuration(userId, event) {
  const sessionId = extractSessionId(event);
  const db = await getPool();

  // 1. Validate: active session, caller is the mentee
  const sessionResult = await db.query(
    `SELECT s.*, mp.rate_per_minute
     FROM session s
     JOIN mentor_profile mp ON mp.user_id = s.mentor_id
     WHERE s.id = $1 AND s.status = 'active' AND s.mentee_id = $2`,
    [sessionId, userId]
  );

  if (sessionResult.rows.length === 0) {
    return respond(404, { error: "Active session not found" });
  }

  const session = sessionResult.rows[0];
  const baseRate = parseFloat(session.rate_per_minute);

  // Free chat: fixed duration, no refresh needed
  if (session.billing_type === 'free_intro') {
    return respond(200, {
      session_id: sessionId,
      max_duration_seconds: null,
      remaining_balance: 0,
      message: "Free chat duration is fixed",
    });
  }

  // 2. Get current mentee wallet balance
  const balanceResult = await db.query(
    `SELECT balance FROM wallet WHERE user_id = $1 AND type = 'mentee'`,
    [userId]
  );
  const balance = parseFloat(balanceResult.rows[0].balance);

  // 3. Calculate cost so far (same pattern as handleCallEnd / handleModeSwitchAccept)
  const completedSegs = await db.query(
    `SELECT duration_seconds, rate_per_minute
     FROM session_segment
     WHERE session_id = $1 AND ended_at IS NOT NULL
     ORDER BY started_at`,
    [sessionId]
  );

  let alreadySpent = 0;
  let mSec = 0;
  let mRate = null;
  for (const seg of completedSegs.rows) {
    const dur = parseInt(seg.duration_seconds) || 0;
    const rate = parseFloat(seg.rate_per_minute) || 0;
    if (rate === mRate) {
      mSec += dur;
    } else {
      if (mRate !== null) alreadySpent += Math.ceil(mSec / 60) * mRate;
      mRate = rate;
      mSec = dur;
    }
  }
  if (mRate !== null) alreadySpent += Math.ceil(mSec / 60) * mRate;

  // Running segment cost (elapsed so far, not yet closed)
  const runningCost = await db.query(
    `SELECT COALESCE(
       SUM(CEIL(EXTRACT(EPOCH FROM NOW() - started_at)::int / 60.0) * rate_per_minute), 0
     ) as cost
     FROM session_segment
     WHERE session_id = $1 AND ended_at IS NULL`,
    [sessionId]
  );
  alreadySpent += parseFloat(runningCost.rows[0].cost);

  // 4. Current rate from active segment
  const activeSegment = await db.query(
    `SELECT rate_per_minute FROM session_segment
     WHERE session_id = $1 AND ended_at IS NULL
     ORDER BY started_at DESC LIMIT 1`,
    [sessionId]
  );
  const currentRate = parseFloat(activeSegment.rows[0]?.rate_per_minute) || baseRate;

  // 5. Calculate new max duration
  const remainingBalance = balance - alreadySpent;
  const maxDurationMinutes = Math.floor(remainingBalance / currentRate);
  const elapsedSeconds = Math.floor((Date.now() - new Date(session.started_at).getTime()) / 1000);
  const maxDurationSeconds = elapsedSeconds + (maxDurationMinutes * 60);

  // 6. Restart SFN timeout with new duration
  const remainingSeconds = maxDurationSeconds - elapsedSeconds;

  if (session.sfn_execution_arn) {
    try {
      await sfnClient.send(new StopExecutionCommand({
        executionArn: session.sfn_execution_arn,
        cause: "Balance refreshed — restarting with new duration",
      }));
    } catch (err) {
      console.log(`SFN stop note: ${err.message}`);
    }
  }

  try {
    const execution = await sfnClient.send(new StartExecutionCommand({
      stateMachineArn: SFN_ARN,
      name: `session-${sessionId}-refresh-${Date.now()}`,
      input: JSON.stringify({ sessionId, maxDurationSeconds: remainingSeconds }),
    }));

    await db.query(
      `UPDATE session SET sfn_execution_arn = $2 WHERE id = $1`,
      [sessionId, execution.executionArn]
    );
  } catch (err) {
    console.error("Failed to restart SFN after refresh:", err.message);
  }

  // Push updated duration to BOTH users via WebSocket
  const durationPayload = {
    type: "duration_refreshed",
    session_id: sessionId,
    max_duration_seconds: maxDurationSeconds,
  };

  await Promise.all([
    pushToUser(session.mentee_id, durationPayload),
    pushToUser(session.mentor_id, durationPayload),
  ]);

  console.log(`Refreshed duration for session ${sessionId}: ${maxDurationSeconds}s total, ${remainingSeconds}s remaining`);

  return respond(200, {
    session_id: sessionId,
    max_duration_seconds: maxDurationSeconds,
    remaining_balance: remainingBalance,
  });
}

// ─── GET /session/active ─────────────────────────────────────

async function handleGetActiveSession(userId, event) {
  const db = await getPool();

  // Find any session where this user is mentor or mentee
  // and status is requested, pending, or active
  const result = await db.query(
 `SELECT s.id, s.mentor_id, s.mentee_id, s.status, s.started_at,
            s.pending_switch_type, s.billing_type,
            mp.rate_per_minute AS mentor_rate,
            mp.pref_audio, mp.pref_video,
            mp.first_name AS mentor_first_name,
            mp.last_name AS mentor_last_name,
            mp.profile_photo_url AS mentor_avatar,
            mtp.first_name AS mentee_first_name,
            mtp.last_name AS mentee_last_name,
            mtp.profile_photo_url AS mentee_avatar
     FROM session s
     JOIN mentor_profile mp ON mp.user_id = s.mentor_id
     LEFT JOIN mentee_profile mtp ON mtp.user_id = s.mentee_id
     WHERE (s.mentee_id = $1 OR s.mentor_id = $1)
       AND s.status IN ('requested', 'pending', 'active')
     ORDER BY s.started_at DESC
     LIMIT 1`,
    [userId]
  );

  if (result.rows.length === 0) {
    return respond(404, { error: "No active session" });
  }

  const s = result.rows[0];
  const isMentor = s.mentor_id === userId;

  const otherUserId = isMentor ? s.mentee_id : s.mentor_id;
  const otherUserName = isMentor
    ? `${s.mentee_first_name || ''} ${s.mentee_last_name || ''}`.trim() || 'Mentee'
    : `${s.mentor_first_name || ''} ${s.mentor_last_name || ''}`.trim() || 'Mentor';
    const otherUserAvatar = toFullUrl(isMentor ? s.mentee_avatar : s.mentor_avatar);

  const baseRate = parseFloat(s.mentor_rate);

  // Get current segment info (for active sessions)
  let callType = null;
  let sessionType = 'chat';
  let agoraChannel = null;
  let agoraToken = null;
  let agoraUid = null;
  let agoraAppId = null;

  if (s.status === 'active') {
    const segment = await db.query(
      `SELECT type FROM session_segment
       WHERE session_id = $1 AND ended_at IS NULL
       ORDER BY started_at DESC LIMIT 1`,
      [s.id]
    );
    const segType = segment.rows[0]?.type;
    if (segType === 'audio' || segType === 'video') {
      callType = segType;
      // Regenerate Agora token for reconnection
      const agora = await generateAgoraToken(s.id, isMentor ? 1 : 2);
      agoraChannel = agora.channel;
      agoraToken = agora.token;
      agoraUid = agora.uid;
      agoraAppId = agora.app_id;
    }
    sessionType = segType || 'chat';
  }

  // Calculate max duration for active sessions
  let maxDurationSeconds = null;
  let timeoutSeconds = null;
  let queuePosition = null;

  if (s.status === 'active') {
    const balanceResult = await db.query(
      `SELECT balance FROM wallet WHERE user_id = $1 AND type = 'mentee'`,
      [s.mentee_id]
    );
    const balance = parseFloat(balanceResult.rows[0].balance);

    const completedCost = await db.query(
      `SELECT COALESCE(SUM(CEIL(duration_seconds / 60.0) * rate_per_minute), 0) as cost
       FROM session_segment
       WHERE session_id = $1 AND ended_at IS NOT NULL`,
      [s.id]
    );
    const spent = parseFloat(completedCost.rows[0].cost);

    // Also account for the currently running (unclosed) segment
    const runningCost = await db.query(
      `SELECT COALESCE(
         SUM(EXTRACT(EPOCH FROM NOW() - started_at)::int / 60.0 * rate_per_minute), 0
       ) as cost
       FROM session_segment
       WHERE session_id = $1 AND ended_at IS NULL`,
      [s.id]
    );
    const totalSpent = spent + parseFloat(runningCost.rows[0].cost);

    const currentRate = callType === 'video' ? baseRate * 1.5 : baseRate;
    if (s.billing_type === 'free_intro') {
      const cfgDuration = (await db.query(`SELECT free_chat_duration_secs FROM promo_config WHERE id = 1`)).rows[0];
      maxDurationSeconds = cfgDuration?.free_chat_duration_secs || 180;
    } else if (s.frozen_remaining_seconds) {
      maxDurationSeconds = s.frozen_remaining_seconds;
      // Clear after reading — one-time use
      db.query(`UPDATE session SET frozen_remaining_seconds = NULL WHERE id = $1`, [s.id]);
    } else {
      const maxMinutes = Math.floor((balance - totalSpent) / currentRate);
      maxDurationSeconds = maxMinutes * 60;
    }
  } else if (s.status === 'requested') {
    timeoutSeconds = SESSION_REQUEST_TIMEOUT_SECONDS;
  } else if (s.status === 'pending') {
    const pos = await getQueuePosition(db, s.mentor_id, s.id);
    queuePosition = pos;
  }

  return respond(200, {
    session_id: s.id,
    status: s.status,
    my_role: isMentor ? 'mentor' : 'mentee',
    session_type: sessionType,
    billing_type: s.billing_type || 'paid',
    rate_per_minute: baseRate,
    other_user_id: otherUserId,
    other_user_name: otherUserName,
    other_user_avatar: otherUserAvatar,
    started_at: s.started_at?.toISOString() || null,
    max_duration_seconds: maxDurationSeconds,
    timeout_seconds: timeoutSeconds,
    queue_position: queuePosition,
    call_type: callType,
    agora_channel: agoraChannel,
    agora_token: agoraToken,
    agora_uid: agoraUid,
    agora_app_id: agoraAppId,
    pref_audio: s.pref_audio ?? true,
    pref_video: s.pref_video ?? true,
  });
}

// ─── POST /session/:id/presign-upload ────────────────────────

async function handlePresignUpload(userId, event) {
  const sessionId = extractSessionId(event);
  const body = JSON.parse(event.body || "{}");
  const { file_name, content_type, media_type } = body;

  // media_type: "audio", "image", "file"
  if (!file_name || !content_type || !media_type) {
    return respond(400, { error: "file_name, content_type, and media_type are required" });
  }

  if (!["audio", "image", "file"].includes(media_type)) {
    return respond(400, { error: "media_type must be audio, image, or file" });
  }

  const db = await getPool();

  // Verify user belongs to this active session
  const sessionResult = await db.query(
    `SELECT id FROM session
     WHERE id = $1 AND status = 'active'
       AND (mentee_id = $2 OR mentor_id = $2)`,
    [sessionId, userId]
  );

  if (sessionResult.rows.length === 0) {
    return respond(404, { error: "Active session not found" });
  }

  // Generate S3 key
  const timestamp = Date.now();
  const safeName = file_name.replace(/[^a-zA-Z0-9._-]/g, '_');
  const s3Key = `chat-media/${sessionId}/${timestamp}-${safeName}`;

  const command = new PutObjectCommand({
    Bucket: BUCKET_NAME,
    Key: s3Key,
    ContentType: content_type,
  });

  const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn: 300 });

  return respond(200, {
    upload_url: uploadUrl,
    s3_key: s3Key,
    expires_in: 300,
  });
}