const { ApiGatewayManagementApiClient, PostToConnectionCommand } = require('@aws-sdk/client-apigatewaymanagementapi');
const { getConnection } = require('./dynamodb');

/**
 * Handles $default route — catches any message that doesn't match a custom route.
 * 
 * Primary use: heartbeat ping/pong to keep connection alive.
 * API Gateway has a 10-minute idle timeout. Client sends a ping every 30s.
 * 
 * Also acts as fallback for unrecognized actions.
 */
exports.handler = async (event) => {
  console.log('$default event:', JSON.stringify(event));

  const { connectionId, domainName, stage } = event.requestContext;

  try {
    const body = JSON.parse(event.body || '{}');

    // Handle heartbeat
    if (body.action === 'ping') {
      const apiClient = new ApiGatewayManagementApiClient({
        endpoint: `https://${domainName}/${stage}`,
      });

      await apiClient.send(new PostToConnectionCommand({
        ConnectionId: connectionId,
        Data: Buffer.from(JSON.stringify({ type: 'pong' })),
      }));

      return { statusCode: 200, body: 'pong' };
    }

    // Unknown action
    console.log('Unknown action:', body.action);
    return { statusCode: 200, body: 'Unknown action' };
  } catch (err) {
    console.error('Default handler error:', err.message);
    return { statusCode: 200, body: 'Error' };
  }
};
