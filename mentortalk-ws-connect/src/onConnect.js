/**
 * mentortalk-ws-connect
 *
 * Handles $connect route.
 * - Verifies JWT, stores connection, sets online (existing)
 * - NEW: Detects reconnection during grace period,
 *   clears disconnect state, restarts SFN, pushes peer_reconnected
 */

const { verifyToken } = require('./auth');
const { storeConnection, updatePresence } = require('./dynamodb');

const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, GetCommand, QueryCommand } = require('@aws-sdk/lib-dynamodb');
const { ApiGatewayManagementApiClient, PostToConnectionCommand } = require('@aws-sdk/client-apigatewaymanagementapi');
const { SFNClient, StartExecutionCommand } = require('@aws-sdk/client-sfn');
const { SchedulerClient, DeleteScheduleCommand } = require('@aws-sdk/client-scheduler');
const pg = require('pg');

const secretsClient = new SecretsManagerClient({ region: 'ap-south-1' });
const dynamoClient = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'ap-south-1' }));
const sfnClient = new SFNClient({ region: 'ap-south-1' });
const schedulerClient = new SchedulerClient({ region: 'ap-south-1' });

const SFN_ARN = process.env.SFN_ARN;
const SCHEDULER_ROLE_ARN = process.env.SCHEDULER_ROLE_ARN;
const WS_ENDPOINT = process.env.WS_ENDPOINT;

let pool = null;

async function getPool() {
  if (pool) return pool;
  const response = await secretsClient.send(
    new GetSecretValueCommand({ SecretId: 'mentortalk/db-app-credentials' })
  );
  const creds = JSON.parse(response.SecretString);
  pool = new pg.Pool({
    host: creds.host,
    port: creds.port,
    database: creds.database,
    user: creds.username,
    password: creds.password,
    ssl: { rejectUnauthorized: false },
    max: 3,
  });
  return pool;
}

async function pushToUser(userId, payload) {
  const conn = await dynamoClient.send(new GetCommand({
    TableName: 'mentortalk-connections',
    Key: { user_id: userId },
  }));

  if (!conn.Item) return;

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

exports.handler = async (event) => {
  console.log('$connect event:', JSON.stringify(event));

  try {
    const token = event.queryStringParameters?.token;

    if (!token) {
      console.log('No token provided');
      return { statusCode: 401, body: 'Unauthorized: no token' };
    }

    const user = await verifyToken(token);
    console.log('Authenticated user:', user.userId);

    const connectionId = event.requestContext.connectionId;
    await storeConnection(user.userId, connectionId);
    await updatePresence(user.userId, 'online');

    // Broadcast presence to anyone watching this user
    try {
      const subs = await dynamoClient.send(new QueryCommand({
        TableName: 'mentortalk-presence-subscriptions',
        KeyConditionExpression: 'target_user_id = :uid',
        ExpressionAttributeValues: { ':uid': user.userId },
      }));

      if (subs.Items && subs.Items.length > 0) {
        const payload = {
          type: 'presence_update',
          user_id: user.userId,
          presence: 'online',
          last_seen: new Date().toISOString(),
        };

        await Promise.all(
          subs.Items.map(sub => pushToUser(sub.subscriber_id, payload))
        );
      }
    } catch (err) {
      console.error('Presence broadcast failed (non-fatal):', err.message);
    }

    console.log(`User ${user.userId} connected with connectionId ${connectionId}`);

    // ── NEW: Check for disconnected session (reconnection) ──
    try {
      const db = await getPool();

      const sessionResult = await db.query(
      `SELECT s.*, ss.rate_per_minute as current_rate, ss.type as current_type
         FROM session s
         LEFT JOIN session_segment ss ON ss.session_id = s.id AND ss.ended_at IS NULL
         WHERE s.disconnected_user_id = $1
           AND s.disconnected_at IS NOT NULL
           AND s.status = 'active'
         LIMIT 1`,
        [user.userId]
      );

      if (sessionResult.rows.length > 0) {
        const session = sessionResult.rows[0];
        console.log(`Reconnection detected for session ${session.id}`);

        // 1. Delete pending grace schedule (Tier 1 or Tier 2)
        if (session.grace_schedule_name) {
          try {
            await schedulerClient.send(new DeleteScheduleCommand({
              Name: session.grace_schedule_name,
            }));
            console.log(`Deleted grace schedule: ${session.grace_schedule_name}`);
          } catch (err) {
            console.log(`Schedule delete note: ${err.message}`);
          }
        }

       // 2. Close current segment at disconnected_at, open new one at NOW
        await db.query(
          `UPDATE session_segment
           SET ended_at = $2,
               duration_seconds = GREATEST(EXTRACT(EPOCH FROM $2::timestamptz - started_at)::int, 0)
           WHERE session_id = $1 AND ended_at IS NULL`,
          [session.id, session.disconnected_at]
        );

        await db.query(
          `INSERT INTO session_segment (session_id, type, rate_per_minute, started_at)
           VALUES ($1, $2, $3, NOW())`,
          [session.id, session.current_type || 'chat', parseFloat(session.current_rate) || 0]
        );

        // 3. Clear disconnect fields
        await db.query(
          `UPDATE session
           SET disconnected_at = NULL,
               disconnected_user_id = NULL,
               grace_schedule_name = NULL
           WHERE id = $1`,
          [session.id]
        );

       // 4. Use frozen value (set by sessionDisconnectCheck at disconnect time — already correct)
       const remainingSeconds = session.frozen_remaining_seconds || await calculateRemainingSeconds(db, session);

        // 5. Start new SFN with remaining time
        if (SFN_ARN) {
          try {
            const execution = await sfnClient.send(new StartExecutionCommand({
              stateMachineArn: SFN_ARN,
              name: `session-${session.id}-reconnect-${Date.now()}`,
              input: JSON.stringify({
                sessionId: session.id,
                maxDurationSeconds: remainingSeconds,
              }),
            }));

            await db.query(
              `UPDATE session SET sfn_execution_arn = $2 WHERE id = $1`,
              [session.id, execution.executionArn]
            );

            console.log(`Restarted SFN for session ${session.id}: ${remainingSeconds}s`);
          } catch (err) {
            console.error('Failed to restart SFN:', err.message);
          }
        }

       // 6. Push peer_reconnected to both users
        const otherUserId = session.mentor_id === user.userId
          ? session.mentee_id
          : session.mentor_id;

        await pushToUser(otherUserId, {
          type: 'peer_reconnected',
          session_id: session.id,
          remaining_seconds: remainingSeconds,
        });

        await pushToUser(user.userId, {
          type: 'peer_reconnected',
          session_id: session.id,
          remaining_seconds: remainingSeconds,
        });

        console.log(`Pushed peer_reconnected to ${otherUserId}, remaining: ${remainingSeconds}s`);
      }
    } catch (err) {
      // Reconnection logic should not block the connection
      console.error('Reconnection check failed (non-fatal):', err.message);
    }

    return { statusCode: 200, body: 'Connected' };
  } catch (err) {
    console.error('Connection failed:', err.message);
    return { statusCode: 401, body: `Unauthorized: ${err.message}` };
  }
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

  // Running segment cost up to disconnected_at (paused time doesn't count)
  const runningCost = await db.query(
    `SELECT COALESCE(
       SUM(CEIL(EXTRACT(EPOCH FROM $2::timestamptz - started_at)::int / 60.0) * rate_per_minute), 0
     ) as cost
     FROM session_segment
     WHERE session_id = $1 AND ended_at IS NULL`,
    [session.id, session.disconnected_at]
  );
  alreadySpent += parseFloat(runningCost.rows[0].cost);

  const currentRate = parseFloat(session.current_rate) || 0;
  if (currentRate === 0) return 0;

  const remainingBalance = balance - alreadySpent;
  const maxMinutes = Math.floor(remainingBalance / currentRate);
  return Math.max(maxMinutes * 60, 0);
}