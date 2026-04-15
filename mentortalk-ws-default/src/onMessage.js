const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const s3Client = new S3Client({ region: 'ap-south-1' });
const BUCKET_NAME = 'mentortalk-storage-prod';
const { DynamoDBDocumentClient, PutCommand, GetCommand, QueryCommand, ScanCommand } = require('@aws-sdk/lib-dynamodb');
const { ApiGatewayManagementApiClient, PostToConnectionCommand } = require('@aws-sdk/client-apigatewaymanagementapi');
const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
const pg = require('pg');

const client = new DynamoDBClient({ region: 'ap-south-1' });
const docClient = DynamoDBDocumentClient.from(client);
const secretsClient = new SecretsManagerClient({ region: 'ap-south-1' });

let pgPool = null;

async function getPgPool() {
  if (pgPool) return pgPool;
  const response = await secretsClient.send(
    new GetSecretValueCommand({ SecretId: 'mentortalk/db-app-credentials' })
  );
  const creds = JSON.parse(response.SecretString);
  pgPool = new pg.Pool({
    host: creds.host,
    port: creds.port,
    database: creds.database,
    user: creds.username,
    password: creds.password,
    ssl: { rejectUnauthorized: false },
    max: 1,
  });
  return pgPool;
}

const TABLES = {
  connections: 'mentortalk-connections',
  presence: 'mentortalk-presence',
  messages: 'mentortalk-messages',
};

// ─── Main Handler ────────────────────────────────────────────────────────

exports.handler = async (event) => {
  console.log('onMessage event:', JSON.stringify(event));

  const { connectionId, domainName, stage } = event.requestContext;

  const apiClient = new ApiGatewayManagementApiClient({
    endpoint: `https://${domainName}/${stage}`,
  });

  try {
    const body = JSON.parse(event.body || '{}');
    const { action } = body;

    // ── Heartbeat (keep backward compat with onDefault) ──
    if (action === 'ping') {
      await postToConnection(apiClient, connectionId, { type: 'pong' });
      return ok();
    }

    // ── Resolve sender from connectionId ──
    const sender = await resolveUserByConnection(connectionId);
    if (!sender) {
      await postToConnection(apiClient, connectionId, {
        type: 'error',
        code: 'AUTH_FAILED',
        message: 'Could not resolve your identity. Reconnect.',
      });
      return ok();
    }

    switch (action) {
      case 'sendMessage':
        return await handleSendMessage(apiClient, sender, body);

      case 'typing':
        return await handleTyping(apiClient, sender, body);

      case 'stopTyping':
        return await handleStopTyping(apiClient, sender, body);

      case 'messageReceived':
        return await handleDeliveryReceipt(apiClient, sender, body);

        case 'messageRead':
          return await handleReadReceipt(apiClient, sender, body);
  
        case 'subscribe_presence':
          return await handleSubscribePresence(apiClient, sender, body);
  
        case 'unsubscribe_presence':
          return await handleUnsubscribePresence(sender, body);
  
        default:
        console.log('Unknown action:', action);
        await postToConnection(apiClient, connectionId, {
          type: 'error',
          code: 'UNKNOWN_ACTION',
          message: `Unknown action: ${action}`,
        });
        return ok();
    }
  } catch (err) {
    console.error('onMessage error:', err);
    try {
      await postToConnection(apiClient, connectionId, {
        type: 'error',
        code: 'INTERNAL_ERROR',
        message: 'Something went wrong. Try again.',
      });
    } catch (_) { /* connection might be gone */ }
    return ok();
  }
};

// ─── Action Handlers ─────────────────────────────────────────────────────

/**
 * sendMessage — Store in DynamoDB, forward to recipient, send server ack.
 *
 * Client sends:
 * {
 *   "action": "sendMessage",
 *   "session_id": "ses_abc123",
 *   "recipient_id": "usr_xyz789",
 *   "content": "Hello!",
 *   "type": "text",                    // text | image | system
 *   "client_message_id": "cm_001"      // client-generated ID for dedup/optimistic UI
 * }
 */
async function handleSendMessage(apiClient, sender, body) {
  const { session_id, recipient_id, content, type, client_message_id, media_url, media_metadata } = body;

  const msgType = type || 'text';
  const isMediaMessage = ['audio', 'image', 'file'].includes(msgType);

  // Validate required fields
  if (!session_id || !recipient_id) {
    await postToConnection(apiClient, sender.connection_id, {
      type: 'error',
      code: 'INVALID_MESSAGE',
      message: 'session_id and recipient_id are required.',
    });
    return ok();
  }

  // Text messages require content; media messages require media_url
  if (!isMediaMessage && !content) {
    await postToConnection(apiClient, sender.connection_id, {
      type: 'error',
      code: 'INVALID_MESSAGE',
      message: 'content is required for text messages.',
    });
    return ok();
  }

  if (isMediaMessage && !media_url) {
    await postToConnection(apiClient, sender.connection_id, {
      type: 'error',
      code: 'INVALID_MESSAGE',
      message: 'media_url is required for media messages.',
    });
    return ok();
  }

 // Generate server message ID (ULID-like: timestamp + random for sortability)
  const messageId = generateMessageId();
  const timestamp = new Date().toISOString();

  // ── Contact info detection (text messages only) ──
  let finalContent = content || '';
  let detected = null;

  if (!isMediaMessage && content) {
    const result = detectAndMaskContactInfo(content);
    finalContent = result.detected ? result.masked : content;
    detected = result.detected;

    if (detected) {
      console.log(`Contact info detected from ${sender.user_id}: ${detected}`);

      try {
        const db = await getPgPool();
        await db.query(
          `INSERT INTO report (reporter_id, reported_id, reason, description, status)
           VALUES ('00000000-0000-0000-0000-000000000000', $1, 'contact_sharing', $2, 'pending')`,
          [sender.user_id, `Original: ${content} | Pattern: ${detected} | Session: ${session_id}`]
        );
      } catch (err) {
        console.error('Failed to log contact violation:', err.message);
      }
    }
  }

  // Store message in DynamoDB
  const messageItem = {
    session_id,
    message_id: messageId,
    client_message_id: client_message_id || null,
    sender_id: sender.user_id,
    recipient_id,
    type: msgType,
    content: finalContent,
    created_at: timestamp,
  };

  // Media fields (only for audio/image/file messages)
  if (isMediaMessage && media_url) {
    messageItem.media_url = media_url;
  }
  if (isMediaMessage && media_metadata) {
    messageItem.media_metadata = typeof media_metadata === 'string'
      ? media_metadata
      : JSON.stringify(media_metadata);
  }

  if (detected) {
    messageItem.flagged = true;
    messageItem.original_content = content;
    messageItem.detected_pattern = detected;
  }

  await docClient.send(new PutCommand({
    TableName: TABLES.messages,
    Item: messageItem,
  }));

  // ✓ Single tick — server got it. Send ack back to sender.
  const ackPayload = {
    type: 'message_ack',
    client_message_id: client_message_id || null,
    message_id: messageId,
    session_id,
    created_at: timestamp,
    status: 'sent',
    ...(detected ? { content: finalContent } : {}),
  };

  await postToConnection(apiClient, sender.connection_id, ackPayload);

  // Forward message to recipient
  const recipientConn = await getConnection(recipient_id);

  if (recipientConn) {
    try {
      const forwardPayload = {
        type: 'new_message',
        message_id: messageId,
        session_id,
        sender_id: sender.user_id,
        content: finalContent,
        message_type: msgType,
        created_at: timestamp,
      };

      if (isMediaMessage && media_url) {
        forwardPayload.media_url = await getSignedUrl(s3Client, new GetObjectCommand({
          Bucket: BUCKET_NAME,
          Key: media_url,
        }), { expiresIn: 3600 });
        if (media_metadata) {
          forwardPayload.media_metadata = typeof media_metadata === 'object'
            ? media_metadata
            : JSON.parse(media_metadata);
        }
      }

      await postToConnection(apiClient, recipientConn.connection_id, forwardPayload);
    } catch (err) {
      // Connection is stale (410 Gone) — recipient went offline
      console.log(`Recipient ${recipient_id} connection stale, cleaning up`);
      await cleanupStaleConnection(recipient_id);
      // TODO: Queue for FCM push notification
    }
  } else {
    // Recipient is offline
    console.log(`Recipient ${recipient_id} is offline`);
    // TODO: Queue for FCM push notification
  }

  return ok();
}

/**
 * typing — Forward typing indicator to the other party. No storage.
 *
 * Client sends:
 * { "action": "typing", "session_id": "ses_abc123", "recipient_id": "usr_xyz789" }
 */
async function handleTyping(apiClient, sender, body) {
  const { session_id, recipient_id } = body;
  if (!session_id || !recipient_id) return ok();

  const recipientConn = await getConnection(recipient_id);
  if (recipientConn) {
    try {
      await postToConnection(apiClient, recipientConn.connection_id, {
        type: 'typing',
        session_id,
        sender_id: sender.user_id,
      });
    } catch (_) { /* stale connection, ignore */ }
  }

  return ok();
}

/**
 * stopTyping — Forward stop typing indicator. No storage.
 */
async function handleStopTyping(apiClient, sender, body) {
  const { session_id, recipient_id } = body;
  if (!session_id || !recipient_id) return ok();

  const recipientConn = await getConnection(recipient_id);
  if (recipientConn) {
    try {
      await postToConnection(apiClient, recipientConn.connection_id, {
        type: 'stop_typing',
        session_id,
        sender_id: sender.user_id,
      });
    } catch (_) { /* stale connection, ignore */ }
  }

  return ok();
}

/**
 * messageReceived — Delivery receipt. Recipient's app confirms it got the message.
 * Forward ✓✓ to sender. No storage.
 *
 * Client sends:
 * { "action": "messageReceived", "session_id": "ses_abc123", "message_id": "msg_001", "sender_id": "usr_abc123" }
 */
async function handleDeliveryReceipt(apiClient, sender, body) {
  const { session_id, message_id, sender_id } = body;
  if (!session_id || !message_id || !sender_id) return ok();

  // Forward ✓✓ to the original sender
  const senderConn = await getConnection(sender_id);
  if (senderConn) {
    try {
      await postToConnection(apiClient, senderConn.connection_id, {
        type: 'delivery_receipt',
        session_id,
        message_id,
        status: 'delivered', // ✓✓
      });
    } catch (_) { /* stale, ignore */ }
  }

  return ok();
}

/**
 * messageRead — Read receipt. Recipient opened/scrolled to the message.
 * Forward blue ✓✓ to sender. No storage.
 *
 * Client sends:
 * { "action": "messageRead", "session_id": "ses_abc123", "message_ids": ["msg_001", "msg_002"], "sender_id": "usr_abc123" }
 */
async function handleReadReceipt(apiClient, sender, body) {
  const { session_id, message_ids, message_id, sender_id } = body;
  if (!session_id || !sender_id) return ok();

  // Support both single message_id and batch message_ids
  const ids = message_ids || (message_id ? [message_id] : []);
  if (ids.length === 0) return ok();

  const senderConn = await getConnection(sender_id);
  if (senderConn) {
    try {
      await postToConnection(apiClient, senderConn.connection_id, {
        type: 'read_receipt',
        session_id,
        message_ids: ids,
        status: 'read', // blue ✓✓
      });
    } catch (_) { /* stale, ignore */ }
  }

  return ok();
}

// ─── Presence Subscription ───────────────────────────────────────────────

async function handleSubscribePresence(apiClient, sender, body) {
  const { user_id } = body;
  if (!user_id) return ok();

  // Store subscription
  await docClient.send(new PutCommand({
    TableName: 'mentortalk-presence-subscriptions',
    Item: {
      target_user_id: user_id,
      subscriber_id: sender.user_id,
      connection_id: sender.connection_id,
      created_at: new Date().toISOString(),
    },
  }));

  // Read presence from DynamoDB + is_available from PostgreSQL
  const [presence, db] = await Promise.all([
    docClient.send(new GetCommand({
      TableName: TABLES.presence,
      Key: { user_id },
    })),
    getPgPool(),
  ]);

  const availResult = await db.query(
    `SELECT is_available FROM mentor_profile WHERE user_id = $1`,
    [user_id]
  );

  const status = presence.Item?.status || 'offline';
  const lastSeen = presence.Item?.last_seen || null;
  const isAvailable = availResult.rows[0]?.is_available ?? false;

  await postToConnection(apiClient, sender.connection_id, {
    type: 'presence_update',
    user_id,
    presence: status,
    is_available: isAvailable,
    last_seen: lastSeen,
  });

  return ok();
}

async function handleUnsubscribePresence(sender, body) {
  const { user_id } = body;
  if (!user_id) return ok();

  const { DeleteCommand } = require('@aws-sdk/lib-dynamodb');
  await docClient.send(new DeleteCommand({
    TableName: 'mentortalk-presence-subscriptions',
    Key: {
      target_user_id: user_id,
      subscriber_id: sender.user_id,
    },
  }));

  return ok();
}

// ─── Helpers ─────────────────────────────────────────────────────────────

/**
 * Reverse lookup: connectionId → userId
 * Scans the connections table. Fine at MVP scale (< 1000 concurrent users).
 * At scale: add a GSI on connection_id or a reverse-lookup table.
 */
async function resolveUserByConnection(connectionId) {
  const result = await docClient.send(new ScanCommand({
    TableName: TABLES.connections,
    FilterExpression: 'connection_id = :cid',
    ExpressionAttributeValues: { ':cid': connectionId },
    ConsistentRead: true,
  }));

  return result.Items && result.Items.length > 0 ? result.Items[0] : null;
}

/**
 * Get a user's connection by user_id.
 */
async function getConnection(userId) {
  const result = await docClient.send(new GetCommand({
    TableName: TABLES.connections,
    Key: { user_id: userId },
  }));
  return result.Item || null;
}

/**
 * Cleanup stale connection — remove from connections, set offline.
 */
async function cleanupStaleConnection(userId) {
  const { DeleteCommand } = require('@aws-sdk/lib-dynamodb');

  await docClient.send(new DeleteCommand({
    TableName: TABLES.connections,
    Key: { user_id: userId },
  }));

  await docClient.send(new PutCommand({
    TableName: TABLES.presence,
    Item: {
      user_id: userId,
      status: 'offline',
      last_seen: new Date().toISOString(),
    },
  }));
}

/**
 * Generate a sortable message ID.
 * Format: timestamp_hex + random_hex (ensures chronological ordering as sort key)
 */
function generateMessageId() {
  const timestamp = Date.now().toString(36); // base36 timestamp
  const random = Math.random().toString(36).substring(2, 8); // 6 random chars
  return `msg_${timestamp}_${random}`;
}

/**
 * Send a JSON payload to a WebSocket connection.
 */
async function postToConnection(apiClient, connectionId, payload) {
  await apiClient.send(new PostToConnectionCommand({
    ConnectionId: connectionId,
    Data: Buffer.from(JSON.stringify(payload)),
  }));
}

/**
 * Standard OK response for WebSocket Lambda.
 */
function ok() {
  return { statusCode: 200, body: 'OK' };
}

// ─── Contact Info Detection ──────────────────────────────────────────────

/**
 * Detects and masks phone numbers and email addresses.
 * Returns { masked, detected } where detected is the first matched pattern or null.
 */
function detectAndMaskContactInfo(text) {
  const phonePattern = /(?:\+?91[\s\-.]?)?(?:0[\s\-.]?)?[6-9][\d\s\-.]{8,12}(?=\s|$|[^0-9])/gi;
  const emailPattern = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/gi;

  const stripped = text.replace(/[\s\-.()\u00A0]/g, '');
  const strippedPhone = /(?:\+?91)?0?[6-9]\d{9,}/.test(stripped);

  let detected = null;
  let masked = text;

  const emailMatch = text.match(emailPattern);
  const phoneMatch = text.match(phonePattern);

  if (emailMatch) {
    detected = emailMatch[0];
    masked = masked.replace(emailPattern, '********');
  }

  if (phoneMatch) {
    detected = detected || phoneMatch[0];
    masked = masked.replace(phonePattern, (m) => '*'.repeat(m.length));
  }

  if (!detected && strippedPhone) {
    detected = stripped.match(/(?:\+?91)?0?[6-9]\d{9,}/)?.[0];
    masked = masked.replace(/\d/g, '*');
  }

  return { masked, detected };
}
