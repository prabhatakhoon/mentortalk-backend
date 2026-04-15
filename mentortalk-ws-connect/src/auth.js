const jwt = require('jsonwebtoken');

/**
 * Verify JWT token from WebSocket query string.
 * WebSocket API Gateway doesn't support Authorization headers on $connect,
 * so the token comes as a query parameter: ?token=xxx
 * 
 * Uses the same secret as your mentortalk-auth Lambda.
 */
async function verifyToken(token) {
  // Pull secret from environment variable
  // (Set this in Lambda config, value from AWS Secrets Manager)
  const secret = process.env.JWT_SECRET;
  
  if (!token || !secret) {
    throw new Error('Missing token or secret');
  }

  try {
    const decoded = jwt.verify(token, secret);
    return {
      userId: decoded.sub,
      role: decoded.role,
      tokenVersion: decoded.token_version,
    };
  } catch (err) {
    throw new Error(`Invalid token: ${err.message}`);
  }
}

module.exports = { verifyToken };
