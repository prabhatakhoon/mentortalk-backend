/**
 * sessionDisconnectCheck.js — Tier 1 (Silent Window)
 *
 * Fired by EventBridge 15 seconds after a user disconnects.
 * Checks if user reconnected. If not:
 *   - If other user also gone → schedule immediate grace end
 *   - If other user online → stop SFN, push peer_disconnected, schedule Tier 2
 *
 * Input: { sessionId, disconnectedUserId }
 */

import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import { ApiGatewayManagementApiClient, PostToConnectionCommand } from "@aws-sdk/client-apigatewaymanagementapi";
import { SFNClient, StopExecutionCommand } from "@aws-sdk/client-sfn";
import { SchedulerClient, CreateScheduleCommand, DeleteScheduleCommand } from "@aws-sdk/client-scheduler";
import { sendFcmNotification } from "./fcmHelper.js";
import pg from "pg";

const { Pool } = pg;
const secretsClient = new SecretsManagerClient({ region: "ap-south-1" });
const dynamoClient = DynamoDBDocumentClient.from(new DynamoDBClient({ region: "ap-south-1" }));
const sfnClient = new SFNClient({ region: "ap-south-1" });
const schedulerClient = new SchedulerClient({ region: "ap-south-1" });

const WS_ENDPOINT = process.env.WS_ENDPOINT;
const GRACE_PERIOD_LAMBDA_ARN = process.env.GRACE_PERIOD_LAMBDA_ARN;
const SCHEDULER_ROLE_ARN = process.env.SCHEDULER_ROLE_ARN;

const GRACE_PERIOD_SECONDS = 90;

let pool = null;
let jwtSecret = null;

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
    } catch (err) {
      console.error(`Failed to push to user ${userId}:`, err.message);
    }
  }

  if (fcmOptions) {
    await sendFcmNotification(userId, fcmOptions);
  }
}

// ─── Handler ─────────────────────────────────────────────────

export const handler = async (event) => {
  console.log("Disconnect check event:", JSON.stringify(event));

  const { sessionId, disconnectedUserId } = event;
  if (!sessionId || !disconnectedUserId) {
    return { action: "noop", reason: "Missing input" };
  }

  const db = await getPool();

  // 1. Check session is still active with disconnected_at still set
  const sessionResult = await db.query(
    `SELECT * FROM session
     WHERE id = $1 AND status = 'active' AND disconnected_at IS NOT NULL`,
    [sessionId]
  );

  if (sessionResult.rows.length === 0) {
    console.log(`Session ${sessionId} already resolved — user reconnected or session ended`);
    return { action: "noop", reason: "Already resolved" };
  }

  const session = sessionResult.rows[0];

  // 2. Determine the other user
  const otherUserId = session.mentor_id === disconnectedUserId
    ? session.mentee_id
    : session.mentor_id;

  // 3. Check if other user is still connected (DynamoDB lookup)
  const otherConn = await dynamoClient.send(new GetCommand({
    TableName: "mentortalk-connections",
    Key: { user_id: otherUserId },
  }));

  const otherIsOnline = !!otherConn.Item;

  // 4. Stop the SFN timer — session is paused either way
  if (session.sfn_execution_arn) {
    try {
      await sfnClient.send(new StopExecutionCommand({
        executionArn: session.sfn_execution_arn,
        cause: "User disconnected — session paused",
      }));
      console.log(`Stopped SFN for session ${sessionId}`);
    } catch (err) {
      console.log(`SFN stop note: ${err.message}`);
    }
  }

  if (!otherIsOnline) {
    // ── Both users gone → schedule immediate grace end ──
    console.log(`Both users disconnected for session ${sessionId} — scheduling immediate end`);

   const scheduleName = `sg-${sessionId}-${String(Date.now()).slice(-6)}`;
    const fireAt = new Date(Date.now() + 5000); // 5 seconds

    try {
      await schedulerClient.send(new CreateScheduleCommand({
        Name: scheduleName,
        ScheduleExpression: `at(${fireAt.toISOString().replace(/\.\d{3}Z$/, '')})`,
        ScheduleExpressionTimezone: "UTC",
        FlexibleTimeWindow: { Mode: "OFF" },
        Target: {
          Arn: GRACE_PERIOD_LAMBDA_ARN,
          RoleArn: SCHEDULER_ROLE_ARN,
          Input: JSON.stringify({ sessionId, disconnectedUserId }),
        },
        ActionAfterCompletion: "DELETE",
      }));

      await db.query(
        `UPDATE session SET grace_schedule_name = $2 WHERE id = $1`,
        [sessionId, scheduleName]
      );
    } catch (err) {
      console.error("Failed to schedule immediate grace end:", err.message);
    }

    return { action: "both_gone", reason: "Both users disconnected" };
  }
// ── Free chat: skip 90s grace, end immediately ──
if (session.billing_type === 'free_intro') {
  console.log(`Free chat session ${sessionId} — skipping grace period, scheduling immediate end`);
  const scheduleName = `sg-${sessionId}-${String(Date.now()).slice(-6)}`;
  const fireAt = new Date(Date.now() + 5000);

  try {
    await schedulerClient.send(new CreateScheduleCommand({
      Name: scheduleName,
      ScheduleExpression: `at(${fireAt.toISOString().replace(/\.\d{3}Z$/, '')})`,
      ScheduleExpressionTimezone: "UTC",
      FlexibleTimeWindow: { Mode: "OFF" },
      Target: {
        Arn: GRACE_PERIOD_LAMBDA_ARN,
        RoleArn: SCHEDULER_ROLE_ARN,
        Input: JSON.stringify({ sessionId, disconnectedUserId }),
      },
      ActionAfterCompletion: "DELETE",
    }));

    await db.query(
      `UPDATE session SET grace_schedule_name = $2 WHERE id = $1`,
      [sessionId, scheduleName]
    );
  } catch (err) {
    console.error("Failed to schedule free chat immediate end:", err.message);
  }

  return { action: "free_chat_no_grace", reason: "Free chat — no grace period" };
}

// ── Only one user gone → push peer_disconnected, schedule Tier 2 ──

let remainingSeconds;

if (session.billing_type === 'intro_rate') {
  // Intro rate: remaining time based on fixed cap, not balance
  const cfgIntro = (await db.query(
    `SELECT intro_max_minutes FROM promo_config WHERE id = 1`
  )).rows[0];
  const maxSecs = (cfgIntro?.intro_max_minutes || 5) * 60;
  const elapsed = Math.floor(
    (new Date(session.disconnected_at).getTime() - new Date(session.started_at).getTime()) / 1000
  );
  remainingSeconds = Math.max(maxSecs - elapsed, 0);
} else {
  remainingSeconds = await calculateRemainingSeconds(db, session);
}
   // Store frozen timer for sync on reconnect
  await db.query(
    `UPDATE session SET frozen_remaining_seconds = $2 WHERE id = $1`,
    [sessionId, remainingSeconds]
  );


  // 6. Push peer_disconnected to the online user
  await pushToUser(otherUserId, {
    type: "peer_disconnected",
    session_id: sessionId,
    disconnected_user_id: disconnectedUserId,
    grace_seconds: GRACE_PERIOD_SECONDS,
    remaining_seconds: remainingSeconds,
  });

  // 7. Schedule Tier 2 grace period (90 seconds)
  const scheduleName = `sg-${sessionId}-${String(Date.now()).slice(-6)}`;
  const fireAt = new Date(Date.now() + GRACE_PERIOD_SECONDS * 1000);

  try {
    await schedulerClient.send(new CreateScheduleCommand({
      Name: scheduleName,
      ScheduleExpression: `at(${fireAt.toISOString().replace(/\.\d{3}Z$/, '')})`,
      ScheduleExpressionTimezone: "UTC",
      FlexibleTimeWindow: { Mode: "OFF" },
      Target: {
        Arn: GRACE_PERIOD_LAMBDA_ARN,
        RoleArn: SCHEDULER_ROLE_ARN,
        Input: JSON.stringify({ sessionId, disconnectedUserId }),
      },
      ActionAfterCompletion: "DELETE",
    }));

    await db.query(
      `UPDATE session SET grace_schedule_name = $2 WHERE id = $1`,
      [sessionId, scheduleName]
    );

    console.log(`Tier 2 grace scheduled: ${scheduleName} (${GRACE_PERIOD_SECONDS}s)`);
  } catch (err) {
    console.error("Failed to schedule grace period:", err.message);
  }

  return { action: "grace_started", remaining_seconds: remainingSeconds };
};

// ─── Helpers ─────────────────────────────────────────────────

async function calculateRemainingSeconds(db, session) {
  const balanceResult = await db.query(
    `SELECT balance FROM wallet WHERE user_id = $1 AND type = 'mentee'`,
    [session.mentee_id]
  );
  const balance = parseFloat(balanceResult.rows[0].balance);

  // Completed segments — global rate bucket merge
  const completedSegs = await db.query(
    `SELECT duration_seconds, rate_per_minute
     FROM session_segment
     WHERE session_id = $1 AND ended_at IS NOT NULL
     ORDER BY started_at`,
    [session.id]
  );

  const rateBuckets = new Map();
  for (const seg of completedSegs.rows) {
    const dur = parseInt(seg.duration_seconds) || 0;
    const rate = parseFloat(seg.rate_per_minute) || 0;
    rateBuckets.set(rate, (rateBuckets.get(rate) || 0) + dur);
  }

  let alreadySpent = 0;
  for (const [rate, seconds] of rateBuckets) {
    alreadySpent += Math.ceil(seconds / 60) * rate;
  }

  // Running segment cost up to disconnected_at
  const runningCost = await db.query(
    `SELECT COALESCE(
       SUM(CEIL(EXTRACT(EPOCH FROM $2::timestamptz - started_at)::int / 60.0) * rate_per_minute), 0
     ) as cost
     FROM session_segment
     WHERE session_id = $1 AND ended_at IS NULL`,
    [session.id, session.disconnected_at]
  );
  alreadySpent += parseFloat(runningCost.rows[0].cost);

  // Current rate
  const currentSeg = await db.query(
    `SELECT rate_per_minute FROM session_segment
     WHERE session_id = $1 AND ended_at IS NULL
     ORDER BY started_at DESC LIMIT 1`,
    [session.id]
  );
  const currentRate = parseFloat(currentSeg.rows[0]?.rate_per_minute) || 0;

  if (currentRate === 0) return 0;

  const remainingBalance = balance - alreadySpent;
  const maxMinutes = Math.floor(remainingBalance / currentRate);
  return Math.max(maxMinutes * 60, 0);
}
