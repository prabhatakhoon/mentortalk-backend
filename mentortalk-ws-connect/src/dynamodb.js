const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand, DeleteCommand, GetCommand, UpdateCommand } = require('@aws-sdk/lib-dynamodb');

const client = new DynamoDBClient({ region: 'ap-south-1' });
const docClient = DynamoDBDocumentClient.from(client);

const TABLES = {
  connections: 'mentortalk-connections',
  presence: 'mentortalk-presence',
  messages: 'mentortalk-messages',
};

/**
 * Store WebSocket connection mapping.
 * One user = one connection (if they reconnect, old one is overwritten).
 */
async function storeConnection(userId, connectionId) {
  await docClient.send(new PutCommand({
    TableName: TABLES.connections,
    Item: {
      user_id: userId,
      connection_id: connectionId,
      connected_at: new Date().toISOString(),
    },
  }));
}

/**
 * Remove connection on disconnect.
 */
async function removeConnection(userId) {
  await docClient.send(new DeleteCommand({
    TableName: TABLES.connections,
    Key: { user_id: userId },
  }));
}

/**
 * Get a user's connection_id (to send them messages).
 */
async function getConnection(userId) {
  const result = await docClient.send(new GetCommand({
    TableName: TABLES.connections,
    Key: { user_id: userId },
  }));
  return result.Item || null;
}

/**
 * Update user presence (online/offline).
 */
async function updatePresence(userId, status) {
  await docClient.send(new PutCommand({
    TableName: TABLES.presence,
    Item: {
      user_id: userId,
      status: status,  // 'online' or 'offline'
      last_seen: new Date().toISOString(),
    },
  }));
}

/**
 * Get user's online status.
 */
async function getPresence(userId) {
  const result = await docClient.send(new GetCommand({
    TableName: TABLES.presence,
    Key: { user_id: userId },
  }));
  return result.Item || { user_id: userId, status: 'offline', last_seen: null };
}

module.exports = {
  storeConnection,
  removeConnection,
  getConnection,
  updatePresence,
  getPresence,
  TABLES,
  docClient,
};
