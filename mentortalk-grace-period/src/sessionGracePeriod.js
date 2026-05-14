/**
 * sessionGracePeriod.js — Tier 2 (Grace Expiry)
 *
 * Fired by EventBridge 90 seconds after Tier 1 (or 5 seconds if both gone).
 * If user is still disconnected, ends the session and bills up to disconnected_at.
 *
 * Input: { sessionId, disconnectedUserId }
 */

import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
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

async function pushToUser(userId, payload, fcmOptions = null) {
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
      console.error(`Failed to push to user ${userId}:`, err.message);
    }
  }

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

// ─── Handler ─────────────────────────────────────────────────

export const handler = async (event) => {
  console.log("Grace period event:", JSON.stringify(event));

  const { sessionId, disconnectedUserId } = event;
  if (!sessionId) {
    return { ended: false, reason: "No sessionId provided" };
  }

  const db = await getPool();

  // 1. Check if session is still active with disconnected_at still set
  const sessionResult = await db.query(
    `SELECT * FROM session WHERE id = $1 AND status = 'active'`,
    [sessionId]
  );

  if (sessionResult.rows.length === 0) {
    console.log(`Session ${sessionId} already ended — no-op`);
    return { ended: false, reason: "Session already ended" };
  }

  const session = sessionResult.rows[0];

  if (!session.disconnected_at) {
    console.log(`Session ${sessionId} — user reconnected, no-op`);
    return { ended: false, reason: "User reconnected" };
  }

  // 2. End session — bill up to disconnected_at
  const disconnectedAt = session.disconnected_at;

  const client = await db.connect();
  try {
    await client.query("BEGIN");

    // Close active segment at disconnected_at (NOT NOW)
    await client.query(
      `UPDATE session_segment
       SET ended_at = $2,
           duration_seconds = GREATEST(EXTRACT(EPOCH FROM $2::timestamptz - started_at)::int, 0)
       WHERE session_id = $1 AND ended_at IS NULL`,
      [sessionId, disconnectedAt]
    );

    // Fetch all segments — global rate bucket merge before CEIL
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

    // Calculate splits
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

    // Create transactions
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

    // Update session
    await client.query(
      `UPDATE session
       SET status = 'completed',
           ended_at = $2,
           total_amount = $3,
           platform_fee = $4,
           mentor_earning = $5,
           disconnected_at = NULL,
           disconnected_user_id = NULL,
           grace_schedule_name = NULL
       WHERE id = $1`,
      [sessionId, disconnectedAt, grossAmount, platformFee, mentorEarning]
    );

    // Update wallets
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

    // 3. Build summary
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

    // 4. System message
    const endMsgId = `msg_${Date.now().toString(36)}_system`;
    const endMsgAt = new Date().toISOString();

    await dynamoClient.send(new PutCommand({
      TableName: "mentortalk-messages",
      Item: {
        session_id: sessionId,
        message_id: endMsgId,
        sender_id: "system",
        type: "system",
        content: "Session ended — user disconnected",
        created_at: endMsgAt,
      },
    }));

    const sysMsgPayload = {
      type: "new_message",
      message_id: endMsgId,
      session_id: sessionId,
      sender_id: "system",
      content: "Session ended — user disconnected",
      message_type: "system",
      created_at: endMsgAt,
    };
    await pushToUser(session.mentee_id, sysMsgPayload);
    await pushToUser(session.mentor_id, sysMsgPayload);

    // 5. Notify both users (session_updates channel — not a request, just a status change)
    await pushToUser(
      session.mentee_id,
      { type: "session_ended", ended_by: "system", reason: "peer_disconnected", ...summary },
      {
        title: "Session Ended",
        body: `Session ended — user disconnected. Cost: ₹${grossAmount}`,
        data: { type: "session_ended", session_id: sessionId, ended_by: "system" },
        androidChannelId: "session_updates",
      }
    );

    await pushToUser(
      session.mentor_id,
      { type: "session_ended", ended_by: "system", reason: "peer_disconnected", ...summary },
      {
        title: "Session Ended",
        body: `Session ended — user disconnected. Earned: ₹${mentorEarning}`,
        data: { type: "session_ended", session_id: sessionId, ended_by: "system" },
        androidChannelId: "session_updates",
      }
    );

    // 6. Presence + queue promotion
    await updatePresence(session.mentor_id, "online");
    await promoteNextPendingSession(db, session.mentor_id);

    console.log(`Grace ended session ${sessionId}. Duration: ${totalDuration}s, Cost: ₹${grossAmount}`);
    return { ended: true, reason: "peer_disconnected" };

  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Grace period end failed:", err);
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
