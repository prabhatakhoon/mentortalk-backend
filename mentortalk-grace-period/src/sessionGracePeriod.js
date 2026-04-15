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
    const platformFeeRate = 0.50;
    const platformFee = grossAmount * platformFeeRate;
    const mentorEarning = grossAmount - platformFee;

    // Create transactions
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

    // 5. Notify both users
    await pushToUser(
      session.mentee_id,
      { type: "session_ended", ended_by: "system", reason: "peer_disconnected", ...summary },
      {
        title: "Session Ended",
        body: `Session ended — user disconnected. Cost: ₹${grossAmount}`,
        data: { type: "session_ended", session_id: sessionId, ended_by: "system" },
      }
    );

    await pushToUser(
      session.mentor_id,
      { type: "session_ended", ended_by: "system", reason: "peer_disconnected", ...summary },
      {
        title: "Session Ended",
        body: `Session ended — user disconnected. Earned: ₹${mentorEarning}`,
        data: { type: "session_ended", session_id: sessionId, ended_by: "system" },
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

// ─── Queue Promotion (same as sessionTimeout.js) ────────────

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

  const menteeResult = await db.query(
    `SELECT first_name, last_name FROM mentee_profile WHERE user_id = $1`,
    [promoted.mentee_id]
  );
  const menteeRow = menteeResult.rows[0];
  const menteeName = [menteeRow?.first_name, menteeRow?.last_name].filter(Boolean).join(' ') || 'Mentee';

  const mentorProfile = await db.query(
    `SELECT rate_per_minute FROM mentor_profile WHERE user_id = $1`,
    [mentorId]
  );
  const ratePerMinute = parseFloat(mentorProfile.rows[0]?.rate_per_minute) || 0;

  const promotedType = promoted.requested_session_type || "chat";

  await pushToUser(
    mentorId,
    {
      type: "session_request",
      session_id: promoted.id,
      mentee_id: promoted.mentee_id,
      mentee_name: menteeName,
      session_type: promotedType,
      rate_per_minute: ratePerMinute,
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

  await pushToUser(promoted.mentee_id, {
    type: "session_promoted",
    session_id: promoted.id,
    message: "Your session request has been sent to the mentor",
  });

  console.log(`Promoted session ${promoted.id} from pending to requested`);
}
