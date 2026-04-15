import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  DeleteCommand,
} from "@aws-sdk/lib-dynamodb";
import pg from "pg";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { sendFcmNotification } from "./fcmHelper.js";

const dynamoClient = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: "ap-south-1" }),
);

let firebaseApp = null;

const getFirebaseApp = async () => {
  if (firebaseApp) return firebaseApp;
  const response = await secretsClient.send(
    new GetSecretValueCommand({
      SecretId: "mentortalk/firebase-service-account",
    }),
  );
  const serviceAccount = JSON.parse(response.SecretString);
  firebaseApp = initializeApp({ credential: cert(serviceAccount) });
  return firebaseApp;
};
const { Pool } = pg;
const secretsClient = new SecretsManagerClient({ region: "ap-south-1" });

let pool = null;
let jwtSecret = null;
let truecallerCredentials = null;
const TEST_PHONE_NUMBER = "+910000000000";

const getDbCredentials = async () => {
  const response = await secretsClient.send(
    new GetSecretValueCommand({ SecretId: "mentortalk/db-app-credentials" }),
  );
  return JSON.parse(response.SecretString);
};

const getJwtSecret = async () => {
  if (jwtSecret) return jwtSecret;
  const response = await secretsClient.send(
    new GetSecretValueCommand({ SecretId: "mentortalk/jwt-secret" }),
  );
  jwtSecret = JSON.parse(response.SecretString).secret;
  return jwtSecret;
};

const getTruecallerCredentials = async () => {
  if (truecallerCredentials) return truecallerCredentials;
  const response = await secretsClient.send(
    new GetSecretValueCommand({
      SecretId: "mentortalk/truecaller-credentials",
    }),
  );
  truecallerCredentials = JSON.parse(response.SecretString);
  return truecallerCredentials;
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
    max: 5,
  });
  return pool;
};

const generateTokens = async (user, appConfig) => {
  const secret = await getJwtSecret();

  const accessToken = jwt.sign(
    {
      sub: user.id,
      role: appConfig.default_role,
      app: appConfig.app,
      token_version: user.token_version,
    },
    secret,
    { expiresIn: "15m" },
  );
  const refreshToken = crypto.randomBytes(32).toString("hex");
  const refreshTokenHash = crypto
    .createHash("sha256")
    .update(refreshToken)
    .digest("hex");

  const db = await getPool();
  await db.query(
    `INSERT INTO refresh_token (user_id, token_hash, expires_at) VALUES ($1, $2, NOW() + INTERVAL '30 days')`,
    [user.id, refreshTokenHash],
  );

  return { accessToken, refreshToken };
};

// Exchange authorization code for access token with Truecaller
const exchangeTruecallerCode = async (
  authorizationCode,
  codeVerifier,
  appConfig,
) => {
  const creds = await getTruecallerCredentials();
  const clientId =
    appConfig.app === "mentor"
      ? creds.mentor_client_id
      : creds.mentee_client_id;

  const response = await fetch(
    "https://oauth-account-noneu.truecaller.com/v1/token",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: clientId,
        code: authorizationCode,
        code_verifier: codeVerifier,
      }),
    },
  );

  if (!response.ok) {
    const error = await response.text();
    console.error("Truecaller token exchange failed:", error);
    throw new Error("Failed to verify with Truecaller");
  }

  return response.json();
};

const getTruecallerProfile = async (accessToken) => {
  const response = await fetch(
    "https://oauth-account-noneu.truecaller.com/v1/userinfo",
    {
      headers: { Authorization: `Bearer ${accessToken}` },
    },
  );

  if (!response.ok) {
    const error = await response.text();
    console.error("Truecaller userinfo failed:", error);
    throw new Error("Failed to get user info from Truecaller");
  }

  return response.json();
};

function normalizePhone(phone) {
  if (!phone) return phone;
  phone = phone.replace(/[\s\-\(\)]/g, "");
  if (/^\d{10}$/.test(phone)) return `+91${phone}`;
  if (/^91\d{10}$/.test(phone)) return `+${phone}`;
  if (phone.startsWith("+")) return phone;
  return phone;
}
const findOrCreateUserAndRespond = async (
  phoneNumber,
  firstName,
  lastName,
  isOAuth,
  appConfig,
) => {
  if (!phoneNumber) {
    return { statusCode: 401, body: { error: "Phone number not available" } };
  }

  phoneNumber = normalizePhone(phoneNumber);

  const db = await getPool();
  let result = await db.query(`SELECT * FROM "user" WHERE phone_number = $1`, [
    phoneNumber,
  ]);
  let user = result.rows[0];

  if (!user) {
    // Brand new user — create with role from whichever app they signed up from
    const role = appConfig.default_role;

    const insertResult = await db.query(
      `INSERT INTO "user" (phone_number, role, auth_method, first_name, last_name)
       VALUES ($1, $2, 'truecaller_oauth', $3, $4) RETURNING *`,
      [
        phoneNumber,
        role,
        isOAuth ? firstName : null,
        isOAuth ? lastName : null,
      ],
    );
    user = insertResult.rows[0];
  }

  if (user.account_status === "banned") {
    return {
      statusCode: 403,
      body: { error: "Account banned", reason: user.ban_reason },
    };
  }

  // Soft-deleted user logging back in — restore account (grace period)
  if (user.account_status === "soft_deleted") {
    await db.query(
      `UPDATE "user" SET account_status = 'active', deletion_scheduled_at = NULL, updated_at = NOW() WHERE id = $1`,
      [user.id],
    );
    user.account_status = "active";
    console.log(`[ACCOUNT] Restored soft-deleted account for user ${user.id}`);
  }

  // Hard-deleted user — cannot log in, must re-register
  if (user.account_status === "hard_deleted") {
    return {
      statusCode: 410,
      body: {
        error:
          "Account has been permanently deleted. Please register with a new account.",
      },
    };
  }

  // ── Ensure profile exists for the current app ──────────────
  // This handles: mentor logging into mentee app (or vice versa)
  // Profile existence = role capability

  if (appConfig.default_role === "mentee") {
    const profileExists = await db.query(
      `SELECT 1 FROM mentee_profile WHERE user_id = $1`,
      [user.id],
    );

    if (profileExists.rows.length === 0) {
      // Create bare mentee profile — onboarding will fill the rest
      // Pre-fill names from user table (Truecaller name) if available
      await db.query(
        `INSERT INTO mentee_profile (user_id, first_name, last_name)
         VALUES ($1, $2, $3)`,
        [user.id, user.first_name, user.last_name],
      );
      console.log(`Created mentee_profile for existing user ${user.id}`);
    }
  }

  if (appConfig.default_role === "mentor") {
    const appExists = await db.query(
      `SELECT 1 FROM mentorship_application WHERE user_id = $1`,
      [user.id],
    );

    if (appExists.rows.length === 0) {
      await db.query(
        `INSERT INTO mentorship_application (user_id) VALUES ($1)`,
        [user.id],
      );

      // Also create mentor_profile if missing
      const profileExists = await db.query(
        `SELECT 1 FROM mentor_profile WHERE user_id = $1`,
        [user.id],
      );

      if (profileExists.rows.length === 0) {
        await db.query(
          `INSERT INTO mentor_profile (user_id, first_name, last_name)
           VALUES ($1, $2, $3)`,
          [user.id, user.first_name, user.last_name],
        );
      }

      console.log(
        `Created mentorship_application + mentor_profile for existing user ${user.id}`,
      );
    }
  }

  // ── Force logout old device (single-device enforcement) ────
  // Send FCM to old device before invalidating (best-effort)
  await sendFcmNotification(user.id, {
    title: "Signed in on another device",
    body: "Your MentorTalk account was signed in on another device. You have been logged out.",
    data: { type: "force_logout", reason: "signed_in_elsewhere" },
  });

  // Revoke all existing refresh tokens
  await db.query(
    `UPDATE refresh_token SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL`,
    [user.id],
  );

  // Increment token_version to invalidate all existing JWTs, clear FCM token
  const versionResult = await db.query(
    `UPDATE "user" SET token_version = token_version + 1, fcm_token = NULL, updated_at = NOW() WHERE id = $1 RETURNING token_version`,
    [user.id],
  );
  user.token_version = versionResult.rows[0].token_version;

  console.log(`[FORCE_LOGOUT] Invalidated old sessions for user ${user.id}`);

  // ── Generate tokens with role from app config, not DB ──────
  const tokens = await generateTokens(user, appConfig);

  return {
    statusCode: 200,
    body: {
      access_token: tokens.accessToken,
      refresh_token: tokens.refreshToken,
      user: {
        id: user.id,
        phone_number: user.phone_number,
        role: appConfig.default_role, // Return app-based role, not DB role
        first_name: user.first_name,
        last_name: user.last_name,
        account_status: user.account_status,
      },
    },
  };
};
let fast2smsKey = null;

const getFast2smsKey = async () => {
  if (fast2smsKey) return fast2smsKey;
  const response = await secretsClient.send(
    new GetSecretValueCommand({ SecretId: "mentortalk/fast2sms-credentials" }),
  );
  fast2smsKey = JSON.parse(response.SecretString).api_key;
  return fast2smsKey;
};

const generateOtp = () => {
  return crypto.randomInt(100000, 999999).toString();
};

let apiKeyConfig = null;

const getApiKeyConfig = async () => {
  if (apiKeyConfig) return apiKeyConfig;
  const response = await secretsClient.send(
    new GetSecretValueCommand({ SecretId: "mentortalk/api-keys" }),
  );
  apiKeyConfig = JSON.parse(response.SecretString);
  return apiKeyConfig;
};

const validateApiKey = async (event) => {
  const apiKey = event.headers?.["x-api-key"] || event.headers?.["X-Api-Key"];
  if (!apiKey) return null;
  const config = await getApiKeyConfig();
  return config[apiKey] || null;
};

// ─── Verify JWT for authenticated endpoints ──────────────────

const verifyToken = async (authHeader) => {
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    throw new Error("Missing or invalid authorization header");
  }
  const token = authHeader.split(" ")[1];
  const secret = await getJwtSecret();
  const decoded = jwt.verify(token, secret);

  // Check token_version matches DB — rejects tokens issued before ban/unban
  const db = await getPool();
  const result = await db.query(
    `SELECT token_version, account_status, ban_reason FROM "user" WHERE id = $1`,
    [decoded.sub],
  );

  if (result.rows.length === 0) {
    throw new Error("User not found");
  }

  const user = result.rows[0];

  if (user.account_status === "banned") {
    throw new Error("Account banned");
  }

  if (
    decoded.token_version !== undefined &&
    decoded.token_version !== user.token_version
  ) {
    throw new Error("Token revoked");
  }

  return decoded;
};

// ─── Handlers ────────────────────────────────────────────────

const handlers = {
  // POST /auth/truecaller/verify
  truecallerVerify: async (body, appConfig) => {
    const {
      authorization_code,
      code_verifier,
      access_token,
      phone_number,
      first_name,
      last_name,
    } = body;

    if (
      process.env.ENABLE_TEST_ACCOUNT === "true" &&
      phone_number === TEST_PHONE_NUMBER
    ) {
      console.log("[TEST ACCOUNT] Bypassing Truecaller for test phone number");
      return findOrCreateUserAndRespond(
        TEST_PHONE_NUMBER,
        "Play Store",
        "Reviewer",
        false,
        appConfig,
      );
    }

    // Path 1: OAuth PKCE flow (one-tap Truecaller login)
    if (authorization_code && code_verifier) {
      let truecallerTokens;
      try {
        truecallerTokens = await exchangeTruecallerCode(
          authorization_code,
          code_verifier,
          appConfig,
        );
      } catch (e) {
        return {
          statusCode: 401,
          body: { error: "Truecaller verification failed" },
        };
      }

      let profile;
      try {
        profile = await getTruecallerProfile(truecallerTokens.access_token);
      } catch (e) {
        return {
          statusCode: 401,
          body: { error: "Failed to get Truecaller profile" },
        };
      }

      const profilePhone = profile.phone_number;
      const profileFirst =
        profile.given_name || profile.name?.split(" ")[0] || null;
      const profileLast =
        profile.family_name ||
        profile.name?.split(" ").slice(1).join(" ") ||
        null;

      return findOrCreateUserAndRespond(
        profilePhone,
        profileFirst,
        profileLast,
        true,
        appConfig,
      );
    }

    // Path 2: Non-OAuth flow (OTP / missed call verification)
    if (access_token) {
      try {
        const profile = await getTruecallerProfile(access_token);
        const profilePhone = profile.phone_number;
        const profileFirst =
          profile.given_name || profile.name?.split(" ")[0] || null;
        const profileLast =
          profile.family_name ||
          profile.name?.split(" ").slice(1).join(" ") ||
          null;

        return findOrCreateUserAndRespond(
          profilePhone,
          profileFirst,
          profileLast,
          true,
          appConfig,
        );
      } catch (e) {
        console.warn(
          "Truecaller userinfo failed with SDK token, using client data:",
          e.message,
        );

        if (!phone_number) {
          return {
            statusCode: 400,
            body: { error: "phone_number required for non-OAuth verification" },
          };
        }

        return findOrCreateUserAndRespond(
          phone_number,
          first_name,
          last_name,
          false,
          appConfig,
        );
      }
    }

    return {
      statusCode: 400,
      body: {
        error:
          "Either authorization_code+code_verifier or access_token required",
      },
    };
  },
  // POST /auth/firebase/verify
  firebaseVerify: async (body, appConfig) => {
    const { firebase_id_token } = body;

    if (!firebase_id_token) {
      return { statusCode: 400, body: { error: "firebase_id_token required" } };
    }

    try {
      await getFirebaseApp();
      const decoded = await getAuth().verifyIdToken(firebase_id_token);
      const phoneNumber = decoded.phone_number;

      if (!phoneNumber) {
        return {
          statusCode: 401,
          body: { error: "No phone number in Firebase token" },
        };
      }

      return findOrCreateUserAndRespond(
        phoneNumber,
        null,
        null,
        false,
        appConfig,
      );
    } catch (e) {
      console.error("Firebase token verification failed:", e.message);
      return { statusCode: 401, body: { error: "Invalid Firebase token" } };
    }
  },

  // POST /auth/otp/send
  otpSend: async (body, appConfig) => {
    const { phone_number } = body;

    if (!phone_number) {
      return { statusCode: 400, body: { error: "phone_number required" } };
    }

    const normalized = normalizePhone(phone_number);
    const otp = generateOtp();
    const expiresAt = Math.floor(Date.now() / 1000) + 120; // 2 minutes

    // Store OTP in DynamoDB
    await dynamoClient.send(
      new PutCommand({
        TableName: "mentortalk-otp",
        Item: {
          phone_number: normalized,
          otp,
          expires_at: expiresAt,
          attempts: 0,
          created_at: new Date().toISOString(),
        },
      }),
    );

    // Send via Fast2SMS
    const apiKey = await getFast2smsKey();
    const phoneDigits = normalized.replace("+91", "");

    const response = await fetch("https://www.fast2sms.com/dev/bulkV2", {
      method: "POST",
      headers: {
        authorization: apiKey,
        "Content-Type": "application/json",
        "cache-control": "no-cache",
      },
      body: JSON.stringify({
        message: `Your MentorTalk verification code is ${otp}. Valid for 2 minutes.`,
        route: "q",
        numbers: phoneDigits,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      console.error("Fast2SMS send failed:", error);
      return { statusCode: 500, body: { error: "Failed to send OTP" } };
    }

    const result = await response.json();
    if (!result.return) {
      console.error("Fast2SMS error:", result);
      return { statusCode: 500, body: { error: "Failed to send OTP" } };
    }

    console.log(`OTP sent to ${normalized}`);
    return { statusCode: 200, body: { success: true, message: "OTP sent" } };
  },

  // POST /auth/otp/verify
  otpVerify: async (body, appConfig) => {
    const { phone_number, otp } = body;

    if (!phone_number || !otp) {
      return {
        statusCode: 400,
        body: { error: "phone_number and otp required" },
      };
    }

    const normalized = normalizePhone(phone_number);

    // Get stored OTP
    let record;
    try {
      const result = await dynamoClient.send(
        new GetCommand({
          TableName: "mentortalk-otp",
          Key: { phone_number: normalized },
        }),
      );
      record = result.Item;
    } catch (e) {
      console.error("DynamoDB get failed:", e.message);
      return { statusCode: 500, body: { error: "Verification failed" } };
    }

    if (!record) {
      return {
        statusCode: 400,
        body: { error: "No OTP found. Request a new one." },
      };
    }

    // Check expiry
    if (Math.floor(Date.now() / 1000) > record.expires_at) {
      await dynamoClient.send(
        new DeleteCommand({
          TableName: "mentortalk-otp",
          Key: { phone_number: normalized },
        }),
      );
      return {
        statusCode: 400,
        body: { error: "OTP expired. Request a new one." },
      };
    }

    // Check attempts (max 3)
    if (record.attempts >= 3) {
      await dynamoClient.send(
        new DeleteCommand({
          TableName: "mentortalk-otp",
          Key: { phone_number: normalized },
        }),
      );
      return {
        statusCode: 429,
        body: { error: "Too many attempts. Request a new OTP." },
      };
    }

    // Verify OTP
    if (record.otp !== otp) {
      // Increment attempts
      await dynamoClient.send(
        new PutCommand({
          TableName: "mentortalk-otp",
          Item: { ...record, attempts: record.attempts + 1 },
        }),
      );
      return { statusCode: 401, body: { error: "Invalid OTP" } };
    }

    // OTP valid — delete it
    await dynamoClient.send(
      new DeleteCommand({
        TableName: "mentortalk-otp",
        Key: { phone_number: normalized },
      }),
    );

    // Authenticate using existing function
    return findOrCreateUserAndRespond(normalized, null, null, false, appConfig);
  },

  // POST /auth/refresh
  refresh: async (body, appConfig) => {
    const { refresh_token } = body;

    if (!refresh_token) {
      return { statusCode: 400, body: { error: "refresh_token required" } };
    }

    const tokenHash = crypto
      .createHash("sha256")
      .update(refresh_token)
      .digest("hex");
    const db = await getPool();

    // Find and validate refresh token
    const result = await db.query(
      `SELECT rt.*, u.* FROM refresh_token rt
       JOIN "user" u ON rt.user_id = u.id
       WHERE rt.token_hash = $1 AND rt.revoked_at IS NULL AND rt.expires_at > NOW()`,
      [tokenHash],
    );

    if (result.rows.length === 0) {
      return {
        statusCode: 401,
        body: { error: "Invalid or expired refresh token" },
      };
    }

    const row = result.rows[0];

    // Check if user is banned
    if (row.account_status === "banned") {
      // Revoke the token so it can't be retried
      await db.query(
        `UPDATE refresh_token SET revoked_at = NOW() WHERE token_hash = $1`,
        [tokenHash],
      );
      return {
        statusCode: 403,
        body: { error: "Account banned", reason: row.ban_reason },
      };
    }

    // Revoke old token
    await db.query(
      `UPDATE refresh_token SET revoked_at = NOW() WHERE token_hash = $1`,
      [tokenHash],
    );

    // Generate new tokens
    const user = {
      id: row.user_id,
      role: row.role,
      token_version: row.token_version,
    };
    const tokens = await generateTokens(user, appConfig);

    return {
      statusCode: 200,
      body: {
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken,
        user: {
          id: row.user_id,
          account_status: row.account_status,
        },
      },
    };
  },

  // POST /auth/logout
  logout: async (body, appConfig) => {
    const { refresh_token } = body;

    if (!refresh_token) {
      return { statusCode: 400, body: { error: "refresh_token required" } };
    }

    const tokenHash = crypto
      .createHash("sha256")
      .update(refresh_token)
      .digest("hex");
    const db = await getPool();

    // Look up user before revoking
    const tokenResult = await db.query(
      `SELECT user_id FROM refresh_token WHERE token_hash = $1 AND revoked_at IS NULL`,
      [tokenHash],
    );

    await db.query(
      `UPDATE refresh_token SET revoked_at = NOW() WHERE token_hash = $1`,
      [tokenHash],
    );

    // Set mentor unavailable on logout (mentor app only)
    if (appConfig.app === "mentor" && tokenResult.rows.length > 0) {
      await db.query(
        `UPDATE mentor_profile SET is_available = false, updated_at = NOW() WHERE user_id = $1`,
        [tokenResult.rows[0].user_id],
      );
    }

    return { statusCode: 200, body: { message: "Logged out" } };
  },

  // POST /auth/delete-account
  accountDelete: async (body, appConfig, event) => {
    // Requires authentication
    const authHeader = event.headers?.Authorization || event.headers?.authorization;
    let decoded;
    try {
      decoded = await verifyToken(authHeader);
    } catch (e) {
      return { statusCode: 401, body: { error: "Unauthorized" } };
    }

    const userId = decoded.sub;
    const role = appConfig.app; // "mentee" or "mentor"
    const db = await getPool();

    // 1. Check user exists and is active
    const userResult = await db.query(
      `SELECT account_status FROM "user" WHERE id = $1`,
      [userId]
    );

    if (userResult.rows.length === 0) {
      return { statusCode: 404, body: { error: "User not found" } };
    }

    if (userResult.rows[0].account_status !== "active") {
      return { statusCode: 400, body: { error: "Account is not in active state" } };
    }

    // 2. Check pre-conditions: no active sessions
    const activeSession = await db.query(
      `SELECT id FROM session
       WHERE (mentor_id = $1 OR mentee_id = $1) AND status IN ('active', 'requested', 'pending')
       LIMIT 1`,
      [userId]
    );

    if (activeSession.rows.length > 0) {
      return { statusCode: 409, body: { error: "You have an active or pending session. Please wait for it to complete before deleting your account." } };
    }

    // 3. Check pre-conditions: no open reports as reporter
    const openReport = await db.query(
      `SELECT id FROM report WHERE reporter_id = $1 AND status = 'pending' LIMIT 1`,
      [userId]
    );

    if (openReport.rows.length > 0) {
      return { statusCode: 409, body: { error: "You have an open report pending review. Please wait for it to be resolved." } };
    }

    // 4. Get wallet balance info for response
    const walletResult = await db.query(
      `SELECT type, balance FROM wallet WHERE user_id = $1`,
      [userId]
    );

    const walletInfo = {};
    for (const w of walletResult.rows) {
      walletInfo[w.type] = parseFloat(w.balance);
    }

    // 5. Execute soft delete
    const deletionDate = new Date();
    deletionDate.setDate(deletionDate.getDate() + 30);

    // Update user status
    await db.query(
      `UPDATE "user"
       SET account_status = 'soft_deleted',
           deletion_scheduled_at = $2,
           token_version = token_version + 1,
           fcm_token = NULL,
           updated_at = NOW()
       WHERE id = $1`,
      [userId, deletionDate.toISOString()]
    );

    // Revoke all refresh tokens
    await db.query(
      `UPDATE refresh_token SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL`,
      [userId]
    );

    // If mentor, set unavailable
    if (role === "mentor") {
      await db.query(
        `UPDATE mentor_profile SET is_available = false, updated_at = NOW() WHERE user_id = $1`,
        [userId]
      );
    }

    // Clean up DynamoDB ephemeral data (best-effort)
    try {
      await dynamoClient.send(new DeleteCommand({
        TableName: "mentortalk-connections",
        Key: { user_id: userId },
      }));
      await dynamoClient.send(new DeleteCommand({
        TableName: "mentortalk-presence",
        Key: { user_id: userId },
      }));
    } catch (e) {
      console.log(`[ACCOUNT] DynamoDB cleanup failed: ${e.message}`);
    }

    console.log(`[ACCOUNT] Soft delete executed for user ${userId}, scheduled hard delete at ${deletionDate.toISOString()}`);

    return {
      statusCode: 200,
      body: {
        message: "Account deletion scheduled",
        deletion_date: deletionDate.toISOString(),
        grace_period_days: 30,
        wallet_balances: walletInfo,
      },
    };
  },

  // POST /auth/fcm-token — store FCM token for push notifications
  fcmToken: async (body, event) => {
    const { fcm_token } = body;

    if (!fcm_token) {
      return { statusCode: 400, body: { error: "fcm_token required" } };
    }

    // This endpoint requires authentication
    const authHeader =
      event.headers?.Authorization || event.headers?.authorization;
    let decoded;
    try {
      decoded = await verifyToken(authHeader);
    } catch (e) {
      return { statusCode: 401, body: { error: "Unauthorized" } };
    }

    const userId = decoded.sub;
    const db = await getPool();

    // Clear this FCM token from any other user (token can only belong to one device/user)
    await db.query(
      `UPDATE "user" SET fcm_token = NULL WHERE fcm_token = $1 AND id != $2`,
      [fcm_token, userId],
    );

    // Set token for this user
    await db.query(`UPDATE "user" SET fcm_token = $2 WHERE id = $1`, [
      userId,
      fcm_token,
    ]);

    console.log(`FCM token stored for user ${userId}`);

    return { statusCode: 200, body: { message: "FCM token registered" } };
  },
};

export const handler = async (event) => {
  try {
    const appConfig = await validateApiKey(event);
    if (!appConfig) {
      return {
        statusCode: 401,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Invalid or missing API key" }),
      };
    }

    const path = event.path || event.rawPath || "";
    const body =
      typeof event.body === "string"
        ? JSON.parse(event.body)
        : event.body || {};

    let result;

    if (path.includes("/truecaller/verify")) {
      result = await handlers.truecallerVerify(body, appConfig);
    } else if (path.includes("/firebase/verify")) {
      result = await handlers.firebaseVerify(body, appConfig);
    } else if (path.includes("/otp/send")) {
      result = await handlers.otpSend(body, appConfig);
    } else if (path.includes("/otp/verify")) {
      result = await handlers.otpVerify(body, appConfig);
    } else if (path.includes("/delete-account")) {
      result = await handlers.accountDelete(body, appConfig, event);
    } else if (path.includes("/fcm-token")) {
      result = await handlers.fcmToken(body, event);
    } else if (path.includes("/refresh")) {
      result = await handlers.refresh(body, appConfig);
    } else if (path.includes("/logout")) {
      result = await handlers.logout(body, appConfig);
    } else {
      result = { statusCode: 404, body: { error: "Not found" } };
    }

    return {
      statusCode: result.statusCode,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(result.body),
    };
  } catch (error) {
    console.error("Error:", error);
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Internal server error" }),
    };
  }
};
