/**
 * mentortalk-mentee-wallet
 *
 * Wallet operations Lambda — Razorpay order creation & payment verification.
 *
 * Routes:
 *   POST /mentee/wallet/create-order    → Create Razorpay order for wallet top-up
 *   POST /mentee/wallet/verify-payment  → Verify payment signature & credit wallet
 *
 * Flow:
 *   1. Client calls create-order with amount
 *   2. Lambda creates order via Razorpay API, returns order_id
 *   3. Client opens Razorpay checkout, user pays
 *   4. Client sends payment_id + order_id + signature to verify-payment
 *   5. Lambda verifies signature using key_secret
 *   6. Lambda updates wallet_balance + inserts transaction row (in single DB txn)
 *   7. Returns new balance to client
 *
 * Credentials:
 *   DB via Secrets Manager: mentortalk/db-app-credentials
 */

import pg from "pg";
const { Client } = pg;
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import jwt from "jsonwebtoken";
import crypto from "crypto";

const s3Client = new S3Client({ region: "ap-south-1" });
const BUCKET_NAME = "mentortalk-storage-prod";

const secretsClient = new SecretsManagerClient({ region: "ap-south-1" });

// ============================================================
// SECRETS CACHE
// ============================================================

let jwtSecret = null;
let razorpayKeys = null;

const getJwtSecret = async () => {
  if (jwtSecret) return jwtSecret;
  const response = await secretsClient.send(
    new GetSecretValueCommand({ SecretId: "mentortalk/jwt-secret" })
  );
  jwtSecret = JSON.parse(response.SecretString).secret;
  return jwtSecret;
};

const getRazorpayKeys = async () => {
  if (razorpayKeys) return razorpayKeys;
  const response = await secretsClient.send(
    new GetSecretValueCommand({ SecretId: "mentortalk/razorpay" })
  );
  razorpayKeys = JSON.parse(response.SecretString);
  return razorpayKeys;
};

// ============================================================
// DATABASE CONNECTION
// ============================================================

let dbCreds = null;

const getDbCredentials = async () => {
  if (dbCreds) return dbCreds;
  const response = await secretsClient.send(
    new GetSecretValueCommand({ SecretId: "mentortalk/db-app-credentials" })
  );
  dbCreds = JSON.parse(response.SecretString);
  return dbCreds;
};

let client = null;

async function getClient() {
  if (client) {
    try {
      await client.query("SELECT 1");
      return client;
    } catch {
      client = null;
    }
  }

  const creds = await getDbCredentials();
  client = new Client({
    host: creds.host,
    port: creds.port,
    database: creds.database,
    user: creds.username,
    password: creds.password,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 5000,
  });

  await client.connect();
  console.log("[DB] Connected to PostgreSQL");
  return client;
}

// ============================================================
// HELPERS
// ============================================================

async function getUserId(event) {
  try {
    const claims =
      event.requestContext?.authorizer?.claims ||
      event.requestContext?.authorizer ||
      {};
    if (claims.sub) return claims.sub;

    const authHeader =
      event.headers?.Authorization || event.headers?.authorization || "";

    if (!authHeader.startsWith("Bearer ")) return null;

    const token = authHeader.split(" ")[1];
    const secret = await getJwtSecret();
    const payload = jwt.verify(token, secret, { algorithms: ["HS256"] });

    return payload.sub || null;
  } catch (err) {
    console.error("[AUTH] JWT verification failed:", err.message);
    return null;
  }
}

function res(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
    body: JSON.stringify(body),
  };
}

// ============================================================
// POST /mentee/wallet/create-order
//
// Body: { "amount": 500 }  (in rupees, minimum ₹1)
//
// Creates a Razorpay order and returns order_id + key_id
// for the client to open checkout.
// ============================================================

async function createOrder(db, userId, body) {
  const amount = parseInt(body.amount);

  if (!amount || amount < 1) {
    return res(400, { message: "Amount must be at least ₹1" });
  }

  if (amount > 10000) {
    return res(400, { message: "Maximum top-up amount is ₹10,000" });
  }

  const { key_id, key_secret } = await getRazorpayKeys();

  // Create Razorpay order via their API
  const orderPayload = JSON.stringify({
    amount: amount * 100, // Razorpay expects paise
    currency: "INR",
    receipt: `w_${Date.now()}`,
    notes: {
      user_id: userId,
      type: "wallet_topup",
    },
  });

  const auth = Buffer.from(`${key_id}:${key_secret}`).toString("base64");

  const response = await fetch("https://api.razorpay.com/v1/orders", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Basic ${auth}`,
    },
    body: orderPayload,
  });

  if (!response.ok) {
    const error = await response.text();
    console.error("[RAZORPAY] Order creation failed:", error);
    return res(500, { message: "Failed to create payment order" });
  }

  const order = await response.json();

  console.log("[WALLET] Order created:", order.id, "amount:", amount);

  return res(200, {
    order_id: order.id,
    amount: amount,
    currency: "INR",
    key_id: key_id,
  });
}

// ============================================================
// POST /mentee/wallet/verify-payment
//
// Body: {
//   "razorpay_order_id":   "order_xxx",
//   "razorpay_payment_id": "pay_xxx",
//   "razorpay_signature":  "hex_signature",
//   "amount":              500
// }
//
// 1. Verifies signature using HMAC-SHA256
// 2. In a single DB transaction:
//    a. INSERT into transaction table
//    b. UPDATE wallet_balance on mentee_profile
// 3. Returns new wallet balance
// ============================================================

async function verifyPayment(db, userId, body) {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature, amount } =
    body;

  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
    return res(400, { message: "Missing payment details" });
  }

  const parsedAmount = parseFloat(amount);
  if (!parsedAmount || parsedAmount <= 0) {
    return res(400, { message: "Invalid amount" });
  }

  // ── 1. Verify signature ──
  const { key_secret } = await getRazorpayKeys();

  const expectedSignature = crypto
    .createHmac("sha256", key_secret)
    .update(`${razorpay_order_id}|${razorpay_payment_id}`)
    .digest("hex");

  if (expectedSignature !== razorpay_signature) {
    console.error("[WALLET] Signature mismatch for user:", userId);
    return res(400, { message: "Payment verification failed" });
  }

// ── 2. Check for duplicate (idempotency) ──
const duplicate = await db.query(
  `SELECT id FROM transaction WHERE reference_id = $1`,
  [razorpay_payment_id]
);

if (duplicate.rows.length > 0) {
  // Already processed — return current balance
  const balanceResult = await db.query(
    `SELECT balance FROM wallet WHERE user_id = $1 AND type = 'mentee'`,
    [userId]
  );
  const currentBalance = parseFloat(balanceResult.rows[0]?.balance ?? 0);
  console.log("[WALLET] Duplicate payment ignored:", razorpay_payment_id);
  return res(200, {
    message: "Payment already processed",
    wallet_balance: currentBalance,
  });
}
// ── 3. Credit wallet in a single transaction ──
try {
  await db.query("BEGIN");

  // Insert mentee credit transaction (linked to mentee wallet)
  await db.query(
    `INSERT INTO transaction (id, wallet_id, user_id, type, direction, amount, reference_id, status)
     VALUES (
       gen_random_uuid(),
       (SELECT id FROM wallet WHERE user_id = $1 AND type = 'mentee'),
       $1, 'wallet_topup', 'credit', $2, $3, 'completed'
     )`,
    [userId, parsedAmount, razorpay_payment_id]
  );

  // Insert platform debit transaction (double-entry)
  await db.query(
    `INSERT INTO transaction (id, user_id, type, direction, amount, reference_id, status)
     VALUES (gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'platform_cash', 'debit', $1, $2, 'completed')`,
    [parsedAmount, razorpay_order_id]
  );

  // Update wallet balance
  const balanceResult = await db.query(
    `UPDATE wallet
     SET balance = balance + $1, updated_at = NOW()
     WHERE user_id = $2 AND type = 'mentee'
     RETURNING balance`,
    [parsedAmount, userId]
  );

  await db.query("COMMIT");

  const newBalance = parseFloat(balanceResult.rows[0].balance);

  console.log(
    "[WALLET] Credited ₹%s to user %s. New balance: ₹%s",
    parsedAmount,
    userId,
    newBalance
  );

  return res(200, {
    message: "Payment successful",
    wallet_balance: newBalance,
  });
} catch (error) {
  await db.query("ROLLBACK");
  console.error("[WALLET] DB error:", error);
  return res(500, { message: "Failed to credit wallet" });
}
}

function resolvePhotoUrl(photoKey) {
  if (!photoKey) return null;
  if (photoKey.startsWith("http")) return photoKey;
  const cdnBase = process.env.CDN_BASE_URL;
  if (cdnBase) return `${cdnBase}/${photoKey}`;
  return null;
}
// ============================================================
// GET /mentee/wallet/transactions?page=1&limit=20
//
// Returns paginated transaction history for the logged-in user.
// ============================================================

async function getTransactions(db, userId, queryParams) {
  const page = Math.max(1, parseInt(queryParams?.page) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(queryParams?.limit) || 20));
  const offset = (page - 1) * limit;

  const result = await db.query(
    `SELECT
       t.id,
       t.type,
       t.direction,
       t.amount,
       t.reference_id,
       t.status,
       t.notes,
       t.created_at,
       t.session_id,
       u.first_name AS mentor_first_name,
       u.last_name AS mentor_last_name,
     mp.profile_photo_url AS mentor_photo_key,
       s.requested_session_type AS session_type,
       s.billing_type
     FROM transaction t
     JOIN wallet w ON w.id = t.wallet_id
     LEFT JOIN session s ON s.id = t.session_id
     LEFT JOIN mentor_profile mp ON mp.user_id = s.mentor_id
     LEFT JOIN "user" u ON u.id = s.mentor_id
     WHERE t.user_id = $1 AND w.type = 'mentee'
     ORDER BY t.created_at DESC
     LIMIT $2 OFFSET $3`,
    [userId, limit + 1, offset]
  );

  const hasMore = result.rows.length > limit;
  const transactions = [];

  for (const row of result.rows.slice(0, limit)) {
    const txn = {
      id: row.id,
      type: row.type,
      direction: row.direction,
      amount: parseFloat(row.amount),
      reference_id: row.reference_id,
      status: row.status,
      notes: row.notes || null,
      created_at: row.created_at,
      session_id: row.session_id || null,
      other_user_name: null,
      other_user_avatar: null,
      session_type: row.session_type || null,
      billing_type: row.billing_type || null,
    };

    if (row.mentor_first_name) {
      txn.other_user_name = [row.mentor_first_name, row.mentor_last_name]
        .filter(Boolean)
        .join(" ");
    }

    if (row.mentor_photo_key) {
      txn.other_user_avatar = resolvePhotoUrl(row.mentor_photo_key);
    }

    transactions.push(txn);
  }

  return res(200, {
    transactions,
    has_more: hasMore,
    page,
  });
}

// ============================================================
// ROUTER
// ============================================================

export const handler = async (event) => {
  try {
    const path = event.path || event.rawPath || "";
    const method =
      event.httpMethod || event.requestContext?.http?.method || "";

    console.log(`[ROUTER] ${method} ${path}`);

    // All wallet endpoints require auth
    const userId = await getUserId(event);
    if (!userId) return res(401, { message: "Unauthorized" });

    const db = await getClient();

    const body =
      typeof event.body === "string"
        ? JSON.parse(event.body)
        : event.body || {};

    // Create Razorpay order
    if (method === "POST" && path.endsWith("/create-order")) {
      return await createOrder(db, userId, body);
    }

    // Verify payment & credit wallet
    if (method === "POST" && path.endsWith("/verify-payment")) {
      return await verifyPayment(db, userId, body);
    }

    // Get transaction history
    if (method === "GET" && path.endsWith("/transactions")) {
      const queryParams = event.queryStringParameters || {};
      return await getTransactions(db, userId, queryParams);
    }

    return res(404, { message: "Not found" });
  } catch (error) {
    console.error("[ERROR] Unhandled:", error);
    return res(500, { message: "Internal server error" });
  }
};
