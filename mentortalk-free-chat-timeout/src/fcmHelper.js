/**
 * FCM Push Notification Helper
 *
 * Uses Firebase Admin SDK HTTP v1 API (OAuth2) to send notifications.
 * Shared by session, request-timeout, and session-timeout Lambdas.
 *
 * Usage:
 *   import { sendFcmNotification } from './fcmHelper.js';
 *   await sendFcmNotification(userId, { title, body, data });
 */

import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import pg from "pg";

const { Pool } = pg;
const secretsClient = new SecretsManagerClient({ region: "ap-south-1" });
const dynamoClient = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: "ap-south-1" }),
);

let serviceAccount = null;
let cachedAccessToken = null;
let tokenExpiresAt = 0;
let pool = null;

// ─── Firebase Service Account ────────────────────────────────

async function getServiceAccount() {
  if (serviceAccount) return serviceAccount;
  const response = await secretsClient.send(
    new GetSecretValueCommand({
      SecretId: "mentortalk/firebase-service-account",
    }),
  );
  serviceAccount = JSON.parse(response.SecretString);
  return serviceAccount;
}

// ─── OAuth2 Access Token (for FCM HTTP v1 API) ──────────────

async function getAccessToken() {
  // Return cached token if still valid (with 60s buffer)
  if (cachedAccessToken && Date.now() < tokenExpiresAt - 60000) {
    return cachedAccessToken;
  }

  const sa = await getServiceAccount();

  // Create JWT for Google OAuth2
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };

  // Sign JWT with service account private key
  const crypto = await import("crypto");
  const headerB64 = Buffer.from(JSON.stringify(header)).toString("base64url");
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signInput = `${headerB64}.${payloadB64}`;

  const sign = crypto.createSign("RSA-SHA256");
  sign.update(signInput);
  const signature = sign.sign(sa.private_key, "base64url");

  const jwtToken = `${signInput}.${signature}`;

  // Exchange JWT for access token
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwtToken,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    console.error("Failed to get FCM access token:", error);
    throw new Error("FCM auth failed");
  }

  const data = await response.json();
  cachedAccessToken = data.access_token;
  tokenExpiresAt = Date.now() + data.expires_in * 1000;

  return cachedAccessToken;
}

// ─── DB Pool (for FCM token lookup) ──────────────────────────

async function getPool() {
  if (pool) return pool;
  const response = await secretsClient.send(
    new GetSecretValueCommand({ SecretId: "mentortalk/db-app-credentials" }),
  );
  const creds = JSON.parse(response.SecretString);
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
}

// ─── Send FCM Notification ───────────────────────────────────

/**
 * Send a push notification to a user via FCM.
 *
 * @param {string} userId - The user ID to send to
 * @param {object} options
 * @param {string} options.title - Notification title
 * @param {string} options.body - Notification body
 * @param {object} [options.data] - Optional data payload (all values must be strings)
 * @returns {boolean} - true if sent, false if user has no FCM token
 */
export async function sendFcmNotification(userId, { title, body, data = {} }) {
  // Look up FCM token from DB
  const db = await getPool();
  const result = await db.query(`SELECT fcm_token FROM "user" WHERE id = $1`, [
    userId,
  ]);

  const fcmToken = result.rows[0]?.fcm_token;
  if (!fcmToken) {
    console.log(`No FCM token for user ${userId} — skipping push`);
    return false;
  }

  try {
    const accessToken = await getAccessToken();
    const sa = await getServiceAccount();
    const projectId = sa.project_id;

    // Ensure all data values are strings (FCM requirement)
    const stringData = {};
    for (const [key, value] of Object.entries(data)) {
      stringData[key] = String(value);
    }

    const message = {
      message: {
        token: fcmToken,
        notification: {
          title,
          body,
        },
        data: stringData,
        android: {
          priority: "high",
          notification: {
            channel_id: "session_notifications",
            sound: "default",
          },
        },
        apns: {
          payload: {
            aps: {
              alert: { title, body },
              sound: "default",
              "content-available": 1,
            },
          },
          headers: {
            "apns-priority": "10",
          },
        },
      },
    };

    const response = await fetch(
      `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(message),
      },
    );

    if (!response.ok) {
      const error = await response.text();
      console.error(`FCM send failed for user ${userId}:`, error);

      // If token is invalid, clear it from DB
      if (
        error.includes("UNREGISTERED") ||
        error.includes("INVALID_ARGUMENT")
      ) {
        await db.query(`UPDATE "user" SET fcm_token = NULL WHERE id = $1`, [
          userId,
        ]);
        console.log(`Cleared invalid FCM token for user ${userId}`);
      }

      return false;
    }

    console.log(`FCM notification sent to user ${userId}`);
    return true;
  } catch (err) {
    console.error(`FCM error for user ${userId}:`, err.message);
    return false;
  }
}
