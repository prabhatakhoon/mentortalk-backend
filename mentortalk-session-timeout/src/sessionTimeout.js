/**
 * mentortalk-session-timeout
 *
 * Invoked by Step Functions when a session's max duration expires.
 * Checks if the session is still active, and if so, force-ends it
 * with proper billing and notifications.
 *
 * Input: { sessionId: "uuid" }
 * Output: { ended: true/false, reason: string }
 */

import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { ApiGatewayManagementApiClient, PostToConnectionCommand } from "@aws-sdk/client-apigatewaymanagementapi";
import { SchedulerClient, DeleteScheduleCommand } from "@aws-sdk/client-scheduler";
import { sendFcmNotification } from "./fcmHelper.js";
import pg from "pg";

const { Pool } = pg;
const secretsClient = new SecretsManagerClient({ region: "ap-south-1" });
const dynamoClient = DynamoDBDocumentClient.from(new DynamoDBClient({ region: "ap-south-1" }));
const schedulerClient = new SchedulerClient({ region: "ap-south-1" });

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

async function updatePresence(userId, status) {
  await dynamoClient.send(new PutCommand({
    TableName: "mentortalk-presence",
    Item: {
      user_id: userId,
      status,
      last_seen: new Date().toISOString(),
    },
  }));
}

async function broadcastPresenceUpdate(userId, status) {
  await updatePresence(userId, status);

  try {
    const { QueryCommand } = await import("@aws-sdk/lib-dynamodb");
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

// ─── Handler ─────────────────────────────────────────────────

export const handler = async (event) => {
  console.log("Session timeout event:", JSON.stringify(event));

  const { sessionId } = event;

  if (!sessionId) {
    return { ended: false, reason: "No sessionId provided" };
  }

  const db = await getPool();

  // Check if session is still active
  const sessionResult = await db.query(
    `SELECT * FROM session WHERE id = $1 AND status = 'active'`,
    [sessionId]
  );

  if (sessionResult.rows.length === 0) {
    console.log(`Session ${sessionId} already ended — no-op`);
    return { ended: false, reason: "Session already ended" };
  }

  const session = sessionResult.rows[0];

  // Force-end the session with billing
  const client = await db.connect();
  try {
    await client.query("BEGIN");

    // 1. Close active segment
    const maxSeconds = event.maxDurationSeconds;

    await client.query(
      `UPDATE session_segment
       SET ended_at = NOW(),
           duration_seconds = LEAST(
             EXTRACT(EPOCH FROM NOW() - started_at)::int,
             $2
           )
       WHERE session_id = $1 AND ended_at IS NULL`,
      [sessionId, maxSeconds]
    );
     // 2. Fetch all segments and merge consecutive same-rate before CEIL
     const segRows = await client.query(
      `SELECT duration_seconds, rate_per_minute
       FROM session_segment
       WHERE session_id = $1
       ORDER BY started_at`,
      [sessionId]
    );

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

    // 3. Free chat: force zero billing
    if (session.billing_type === 'free_intro') {
      grossAmount = 0;
    }

    // 3b. Calculate splits
    let platformFee, mentorEarning;
    if ((session.billing_type === 'paid' || session.billing_type === 'intro_rate') && grossAmount > 0) {
      // Platform takes 100% of minute 1 (at the first segment's rate), then 50/50 from minute 2 onward.
      // Applies to both paid and the platform first-session promo (intro_rate).
      const firstMinuteRate = parseFloat(segRows.rows[0]?.rate_per_minute) || 0;
      const remainingAmount = Math.max(0, grossAmount - firstMinuteRate);
      mentorEarning = remainingAmount * 0.5;
      platformFee = grossAmount - mentorEarning;
    } else {
      // free_intro path — gross is 0, split is moot.
      platformFee = grossAmount * 0.50;
      mentorEarning = grossAmount - platformFee;
    }

    if (Math.abs(grossAmount - (platformFee + mentorEarning)) > 0.0001) {
      throw new Error(
        `Billing assertion failed for session ${sessionId}: ` +
        `total=${grossAmount}, platform=${platformFee}, mentor=${mentorEarning}`
      );
    }
   // 4. Create transactions
   if (grossAmount > 0) {
    await client.query(
      `INSERT INTO transaction (wallet_id, user_id, type, direction, amount, session_id, status, is_test)
       VALUES (
         (SELECT id FROM wallet WHERE user_id = $1 AND type = 'mentee'),
         $1, 'session_payment', 'debit', $2, $3, 'completed', $4
       )`,
      [session.mentee_id, grossAmount, sessionId, session.is_test]
    );

    // Write session_earning even when amount is 0 (1-min paid sessions)
    await client.query(
      `INSERT INTO transaction (wallet_id, user_id, type, direction, amount, session_id, status, is_test)
       VALUES (
         (SELECT id FROM wallet WHERE user_id = $1 AND type = 'mentor'),
         $1, 'session_earning', 'credit', $2, $3, 'completed', $4
       )`,
      [session.mentor_id, mentorEarning, sessionId, session.is_test]
    );

    const PLATFORM_USER_ID = "00000000-0000-0000-0000-000000000000";
    await client.query(
      `INSERT INTO transaction (user_id, type, direction, amount, session_id, status, is_test)
       VALUES ($1, 'platform_fee', 'credit', $2, $3, 'completed', $4)`,
      [PLATFORM_USER_ID, platformFee, sessionId, session.is_test]
    );
  }

 // Log free chat in transaction history (zero amount, audit trail)
 if (session.billing_type === 'free_intro') {
  const PLATFORM_USER_ID_FC = "00000000-0000-0000-0000-000000000000";

  await client.query(
    `INSERT INTO transaction (wallet_id, user_id, type, direction, amount, session_id, status, is_test)
     VALUES (
       (SELECT id FROM wallet WHERE user_id = $1 AND type = 'mentee'),
       $1, 'session_payment', 'debit', 0, $2, 'completed', $3
     )`,
    [session.mentee_id, sessionId, session.is_test]
  );

  await client.query(
    `INSERT INTO transaction (wallet_id, user_id, type, direction, amount, session_id, status, is_test)
     VALUES (
       (SELECT id FROM wallet WHERE user_id = $1 AND type = 'mentor'),
       $1, 'session_earning', 'credit', 0, $2, 'completed', $3
     )`,
    [session.mentor_id, sessionId, session.is_test]
  );

  await client.query(
    `INSERT INTO transaction (user_id, type, direction, amount, session_id, status, is_test)
     VALUES ($1, 'platform_fee', 'credit', 0, $2, 'completed', $3)`,
    [PLATFORM_USER_ID_FC, sessionId, session.is_test]
  );
}

// 5. Clean up grace schedule if present
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

  // 6. Update session
  await client.query(
    `UPDATE session
     SET status = 'completed',
         ended_at = NOW(),
         total_amount = $2,
         platform_fee = $3,
         mentor_earning = $4,
         disconnected_at = NULL,
         disconnected_user_id = NULL,
         grace_schedule_name = NULL
     WHERE id = $1`,
    [sessionId, grossAmount, platformFee, mentorEarning]
  );

   // 6. Update cached balances
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

    // 7. Build summary
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
      segments: segments.rows,
    };

    // 8. Update presence BEFORE notifying — prevents stale "in_session" on client refresh
    await broadcastPresenceUpdate(session.mentor_id, "online");

    // 9. Persist system message in chat history + push via WS
    const timeoutMsgId = `msg_${Date.now().toString(36)}_system`;
    const timeoutMsgAt = new Date().toISOString();

    const sessionMode = session.requested_session_type || 'chat';
    const modeLabel = sessionMode === 'audio' ? 'Audio call'
      : sessionMode === 'video' ? 'Video call'
      : 'Chat';
    const timeoutContent = session.billing_type === 'paid'
      ? `${modeLabel} ended — balance exhausted`
      : "Chat ended";

    await dynamoClient.send(new PutCommand({
      TableName: "mentortalk-messages",
      Item: {
        session_id: sessionId,
        message_id: timeoutMsgId,
        sender_id: "system",
        type: "system",
        content: timeoutContent,
        created_at: timeoutMsgAt,
      },
    }));

    const timeoutMsgPayload = {
      type: "new_message",
      message_id: timeoutMsgId,
      session_id: sessionId,
      sender_id: "system",
      content: timeoutContent,
      message_type: "system",
      created_at: timeoutMsgAt,
    };
    await pushToUser(session.mentee_id, timeoutMsgPayload);
    await pushToUser(session.mentor_id, timeoutMsgPayload);

    // 9. Notify both users (WebSocket + FCM fallback)
    const isFreeChatSession = session.billing_type === 'free_intro';
    const isIntroSession = session.billing_type === 'intro_rate';
    const endReason = isFreeChatSession ? "free_chat_ended"
      : isIntroSession ? "intro_session_ended"
      : "balance_exhausted";

      const menteeTitle = isFreeChatSession ? "Free Chat Ended"
      : isIntroSession ? "Intro Session Ended"
      : "Session Ended";
    const menteeBody = isFreeChatSession
      ? "Your free intro chat has ended"
      : isIntroSession
        ? `Intro session ended. Cost: ₹${grossAmount}`
        : `Session ended — balance exhausted. Cost: ₹${grossAmount}`;
    const mentorBody = isFreeChatSession
      ? "Free intro chat has ended"
      : isIntroSession
        ? `Intro session ended. Earned: ₹${mentorEarning}`
        : `Session ended — mentee balance exhausted. Earned: ₹${mentorEarning}`;

    await pushToUser(
      session.mentee_id,
      { type: "session_ended", ended_by: "system", reason: endReason, billing_type: session.billing_type || 'paid', ...summary },
      {
        title: menteeTitle,
        body: menteeBody,
        data: { type: "session_ended", session_id: sessionId, ended_by: "system" },
      }
    );

    await pushToUser(
      session.mentor_id,
      { type: "session_ended", ended_by: "system", reason: endReason, billing_type: session.billing_type || 'paid', ...summary },
      {
        title: menteeTitle,
        body: mentorBody,
        data: { type: "session_ended", session_id: sessionId, ended_by: "system" },
      }
    );

    // 10. Promote next queued session
   await promoteNextPendingSession(db, session.mentor_id);

    console.log(`Session ${sessionId} force-ended. Duration: ${totalDuration}s, Cost: ₹${grossAmount}`);
    return { ended: true, reason: "balance_exhausted" };

  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Force-end failed:", err);
    throw err;
  } finally {
    client.release();
  }
};

// ─── Queue Promotion ─────────────────────────────────────────
// Full implementation — kept in sync with sessionHandler.js:promoteNextPendingSession

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

  // Guard: only promote if mentor is still available
  const mentorAvail = await db.query(
    `SELECT is_available FROM mentor_profile WHERE user_id = $1`,
    [mentorId]
  );
  if (!mentorAvail.rows[0]?.is_available) {
    console.log(`Mentor ${mentorId} is not available — reverting promotion of session ${promoted.id}`);
    await db.query(
      `UPDATE session SET status = 'pending' WHERE id = $1`,
      [promoted.id]
    );
    return;
  }

  // Create timeout schedule for promoted session
  const REQUEST_TIMEOUT_LAMBDA_ARN = process.env.REQUEST_TIMEOUT_LAMBDA_ARN;
  const SCHEDULER_ROLE_ARN = process.env.SCHEDULER_ROLE_ARN;
  if (REQUEST_TIMEOUT_LAMBDA_ARN && SCHEDULER_ROLE_ARN) {
    const { SchedulerClient, CreateScheduleCommand } = await (async () => {
      const { SchedulerClient: SC, CreateScheduleCommand: CSC } = await import("@aws-sdk/client-scheduler");
      return { SchedulerClient: SC, CreateScheduleCommand: CSC };
    })();
    const schedulerClient = new SchedulerClient({ region: "ap-south-1" });
    const scheduleName = `rt-${promoted.id}-${String(Date.now()).slice(-6)}`;
    const fireAt = new Date(Date.now() + 60 * 1000);

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

  // Fetch rate + chat discount
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

  // Get billing type
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

  // Push to mentor
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
      timeout_seconds: 60,
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
    timeout_seconds: 60,
  });

  console.log(`Promoted session ${promoted.id} from pending to requested`);
}
