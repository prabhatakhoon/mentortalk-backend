/**
 * mentortalk-ws-disconnect
 *
 * Handles $disconnect route.
 * - Cleans up connection + presence (existing)
 * - NEW: Detects active session, records disconnect, schedules Tier 1
 */

const { removeConnection, updatePresence } = require('./dynamodb');

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, ScanCommand, GetCommand, QueryCommand, DeleteCommand } = require('@aws-sdk/lib-dynamodb');
const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
const { SchedulerClient, CreateScheduleCommand, DeleteScheduleCommand } = require('@aws-sdk/client-scheduler');
const pg = require('pg');

const client = new DynamoDBClient({ region: 'ap-south-1' });
const docClient = DynamoDBDocumentClient.from(client);
const secretsClient = new SecretsManagerClient({ region: 'ap-south-1' });
const schedulerClient = new SchedulerClient({ region: 'ap-south-1' });

const DISCONNECT_CHECK_LAMBDA_ARN = process.env.DISCONNECT_CHECK_LAMBDA_ARN;
const GRACE_PERIOD_LAMBDA_ARN = process.env.GRACE_PERIOD_LAMBDA_ARN;
const SCHEDULER_ROLE_ARN = process.env.SCHEDULER_ROLE_ARN;

const SILENT_WINDOW_SECONDS = 15;

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

async function findUserByConnectionId(connectionId) {
  const result = await docClient.send(new ScanCommand({
    TableName: 'mentortalk-connections',
    FilterExpression: 'connection_id = :cid',
    ExpressionAttributeValues: { ':cid': connectionId },
  }));
  return result.Items?.[0]?.user_id || null;
}

exports.handler = async (event) => {
  console.log('$disconnect event:', JSON.stringify(event));

  try {
    const connectionId = event.requestContext.connectionId;

    const userId = await findUserByConnectionId(connectionId);
if (!userId) {
  console.log(`No user found for connectionId ${connectionId}`);
  return { statusCode: 200, body: 'Disconnected' };
}

// Guard: only clean up if this is still the active connection
const currentEntry = await docClient.send(new GetCommand({
  TableName: 'mentortalk-connections',
  Key: { user_id: userId },
  ConsistentRead: true,
}));

if (currentEntry.Item && currentEntry.Item.connection_id !== connectionId) {
  console.log(`Stale disconnect for user ${userId} — newer connection exists, skipping cleanup`);
  return { statusCode: 200, body: 'Disconnected' };
}

await removeConnection(userId);
await updatePresence(userId, 'offline');

// Broadcast offline to anyone watching this user
try {
  const subs = await docClient.send(new QueryCommand({
    TableName: 'mentortalk-presence-subscriptions',
    KeyConditionExpression: 'target_user_id = :uid',
    ExpressionAttributeValues: { ':uid': userId },
  }));

  if (subs.Items && subs.Items.length > 0) {
    const { ApiGatewayManagementApiClient, PostToConnectionCommand } = require('@aws-sdk/client-apigatewaymanagementapi');
    const WS_ENDPOINT = process.env.WS_ENDPOINT;

    await Promise.all(
      subs.Items.map(async (sub) => {
        const conn = await docClient.send(new GetCommand({
          TableName: 'mentortalk-connections',
          Key: { user_id: sub.subscriber_id },
        }));
        if (!conn.Item) return;

        const apiClient = new ApiGatewayManagementApiClient({ endpoint: WS_ENDPOINT });
        try {
          await apiClient.send(new PostToConnectionCommand({
            ConnectionId: conn.Item.connection_id,
            Data: Buffer.from(JSON.stringify({
              type: 'presence_update',
              user_id: userId,
              presence: 'offline',
              last_seen: new Date().toISOString(),
            })),
          }));
        } catch (err) {
          console.log(`Failed to push presence to ${sub.subscriber_id}:`, err.message);
        }
      })
    );
  }
} catch (err) {
  console.error('Presence broadcast failed:', err.message);
}

// Clean up this user's own subscriptions (they were watching others)
try {
  const mySubs = await docClient.send(new ScanCommand({
    TableName: 'mentortalk-presence-subscriptions',
    FilterExpression: 'subscriber_id = :uid',
    ExpressionAttributeValues: { ':uid': userId },
  }));

  if (mySubs.Items && mySubs.Items.length > 0) {
    await Promise.all(
      mySubs.Items.map(sub =>
        docClient.send(new DeleteCommand({
          TableName: 'mentortalk-presence-subscriptions',
          Key: {
            target_user_id: sub.target_user_id,
            subscriber_id: userId,
          },
        }))
      )
    );
  }
} catch (err) {
  console.error('Subscription cleanup failed:', err.message);
}

console.log(`User ${userId} disconnected`);

    // ── NEW: Check for active session ──
    const db = await getPool();

    const sessionResult = await db.query(
      `SELECT id, disconnected_at, disconnected_user_id, grace_schedule_name
       FROM session
       WHERE (mentee_id = $1 OR mentor_id = $1)
         AND status = 'active'
       LIMIT 1`,
      [userId]
    );

    if (sessionResult.rows.length === 0) {
      // No active session — nothing to do
      return { statusCode: 200, body: 'Disconnected' };
    }

    const session = sessionResult.rows[0];

    if (session.disconnected_at) {
      // ── Other user already disconnected — both are gone ──
      // Delete existing grace schedule, schedule immediate grace end
      console.log(`Both users disconnected for session ${session.id}`);

      if (session.grace_schedule_name) {
        try {
          await schedulerClient.send(new DeleteScheduleCommand({
            Name: session.grace_schedule_name,
          }));
        } catch (err) {
          console.log(`Schedule delete note: ${err.message}`);
        }
      }

      const scheduleName = `sg-${session.id}-${String(Date.now()).slice(-6)}`;
      const fireAt = new Date(Date.now() + 5000);

      await schedulerClient.send(new CreateScheduleCommand({
        Name: scheduleName,
        ScheduleExpression: `at(${fireAt.toISOString().replace(/\.\d{3}Z$/, '')})`,
        ScheduleExpressionTimezone: 'UTC',
        FlexibleTimeWindow: { Mode: 'OFF' },
        Target: {
          Arn: GRACE_PERIOD_LAMBDA_ARN,
          RoleArn: SCHEDULER_ROLE_ARN,
          Input: JSON.stringify({
            sessionId: session.id,
            disconnectedUserId: session.disconnected_user_id,
          }),
        },
        ActionAfterCompletion: 'DELETE',
      }));

      await db.query(
        `UPDATE session SET grace_schedule_name = $2 WHERE id = $1`,
        [session.id, scheduleName]
      );

    } else {
      // ── First disconnect — record it, schedule Tier 1 ──
      console.log(`Recording disconnect for user ${userId} on session ${session.id}`);

     const scheduleName = `sd-${session.id}-${String(Date.now()).slice(-6)}`;
      const fireAt = new Date(Date.now() + SILENT_WINDOW_SECONDS * 1000);

      await db.query(
        `UPDATE session
         SET disconnected_at = NOW(),
             disconnected_user_id = $2,
             grace_schedule_name = $3
         WHERE id = $1`,
        [session.id, userId, scheduleName]
      );

      await schedulerClient.send(new CreateScheduleCommand({
        Name: scheduleName,
        ScheduleExpression: `at(${fireAt.toISOString().replace(/\.\d{3}Z$/, '')})`,
        ScheduleExpressionTimezone: 'UTC',
        FlexibleTimeWindow: { Mode: 'OFF' },
        Target: {
          Arn: DISCONNECT_CHECK_LAMBDA_ARN,
          RoleArn: SCHEDULER_ROLE_ARN,
          Input: JSON.stringify({
            sessionId: session.id,
            disconnectedUserId: userId,
          }),
        },
        ActionAfterCompletion: 'DELETE',
      }));

      console.log(`Tier 1 scheduled: ${scheduleName} (${SILENT_WINDOW_SECONDS}s)`);
    }

    return { statusCode: 200, body: 'Disconnected' };
  } catch (err) {
    console.error('Disconnect handler error:', err.message);
    return { statusCode: 200, body: 'Disconnected' };
  }
};