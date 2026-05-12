// Send an FCM "finish your mentor onboarding" push to every mentor whose
// application is still `in_progress`.
//
// Usage:
//   node index.mjs --dry-run        # list recipients, send nothing
//   node index.mjs                  # send for real
//   node index.mjs --title "X" --body "Y"
//   node index.mjs --limit 10       # safety cap (default: no cap)
//   node index.mjs --user-id <uuid> # bypass filter, send to one user (testing)
//
// Requires AWS creds with read access to:
//   mentortalk/db-app-credentials, mentortalk/firebase-service-account
// and network reach to the prod RDS in ap-south-1.

import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import pg from "pg";
import crypto from "crypto";

const { Pool } = pg;
const REGION = "ap-south-1";
const CONCURRENCY = 5;

const DEFAULT_TITLE = "Finish your mentor onboarding";
const DEFAULT_BODY = "A few steps left to start mentoring.";

const args = parseArgs(process.argv.slice(2));
const DRY_RUN = args["dry-run"] === true;
const TITLE = args.title ?? DEFAULT_TITLE;
const BODY = args.body ?? DEFAULT_BODY;
const LIMIT = args.limit ? Number(args.limit) : null;
const TEST_USER_ID = args["user-id"] ?? null;

const secretsClient = new SecretsManagerClient({ region: REGION });

let serviceAccount = null;
let cachedAccessToken = null;
let tokenExpiresAt = 0;

async function getSecret(id) {
  const r = await secretsClient.send(new GetSecretValueCommand({ SecretId: id }));
  return JSON.parse(r.SecretString);
}

async function getServiceAccount() {
  if (!serviceAccount) serviceAccount = await getSecret("mentortalk/firebase-service-account");
  return serviceAccount;
}

async function getAccessToken() {
  if (cachedAccessToken && Date.now() < tokenExpiresAt - 60_000) return cachedAccessToken;

  const sa = await getServiceAccount();
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  })).toString("base64url");
  const signInput = `${header}.${payload}`;
  const signature = crypto.createSign("RSA-SHA256").update(signInput).sign(sa.private_key, "base64url");
  const jwt = `${signInput}.${signature}`;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  if (!res.ok) throw new Error(`FCM auth failed: ${await res.text()}`);
  const data = await res.json();
  cachedAccessToken = data.access_token;
  tokenExpiresAt = Date.now() + data.expires_in * 1000;
  return cachedAccessToken;
}

async function sendFcm(db, userId, fcmToken) {
  const sa = await getServiceAccount();
  const accessToken = await getAccessToken();

  const message = {
    message: {
      token: fcmToken,
      notification: { title: TITLE, body: BODY },
      data: { type: "onboarding_reminder" },
      android: {
        priority: "high",
        notification: { channel_id: "session_notifications", sound: "default" },
      },
      apns: {
        payload: { aps: { alert: { title: TITLE, body: BODY }, sound: "default", "content-available": 1 } },
        headers: { "apns-priority": "10" },
      },
    },
  };

  const res = await fetch(
    `https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(message),
    }
  );

  if (!res.ok) {
    const error = await res.text();
    if (error.includes("UNREGISTERED") || error.includes("INVALID_ARGUMENT")) {
      await db.query(`UPDATE "user" SET fcm_token = NULL WHERE id = $1`, [userId]);
      return { ok: false, reason: "stale_token_cleared" };
    }
    return { ok: false, reason: error.slice(0, 200) };
  }
  return { ok: true };
}

async function main() {
  const creds = await getSecret("mentortalk/db-app-credentials");
  const pool = new Pool({
    host: creds.host,
    port: creds.port,
    database: creds.database,
    user: creds.username,
    password: creds.password,
    ssl: { rejectUnauthorized: false },
    max: 3,
  });

  let rows;
  if (TEST_USER_ID) {
    const r = await pool.query(
      `SELECT u.id AS user_id, u.fcm_token, u.phone_number,
              ma.step1_status, ma.step2_status, ma.attempt_number,
              ma.submission_status
       FROM "user" u
       LEFT JOIN mentorship_application ma ON ma.user_id = u.id
       WHERE u.id = $1`,
      [TEST_USER_ID]
    );
    if (r.rows.length === 0) {
      console.error(`User ${TEST_USER_ID} not found.`);
      await pool.end();
      process.exit(1);
    }
    if (!r.rows[0].fcm_token) {
      console.error(`User ${TEST_USER_ID} has no fcm_token — open the app on their device first.`);
      await pool.end();
      process.exit(1);
    }
    rows = r.rows;
    console.log(`\n[TEST MODE] Targeting single user ${TEST_USER_ID} (filter bypassed).`);
  } else {
    const sql = `
      SELECT ma.user_id, u.fcm_token, u.phone_number,
             ma.step1_status, ma.step2_status, ma.attempt_number
      FROM mentorship_application ma
      JOIN "user" u ON u.id = ma.user_id
      WHERE ma.submission_status = 'in_progress'
        AND u.account_status = 'active'
        AND u.fcm_token IS NOT NULL
      ORDER BY ma.updated_at DESC
      ${LIMIT ? `LIMIT ${LIMIT}` : ""}
    `;
    rows = (await pool.query(sql)).rows;
    console.log(`\nMatched ${rows.length} mentor(s) with in_progress onboarding + active account + fcm_token.`);
  }
  console.log(`Title: ${TITLE}`);
  console.log(`Body:  ${BODY}`);
  console.log(`Mode:  ${DRY_RUN ? "DRY-RUN (no sends)" : "LIVE"}\n`);

  if (rows.length === 0) {
    await pool.end();
    return;
  }

  if (DRY_RUN) {
    for (const r of rows) {
      console.log(`  ${r.user_id}  ${r.phone_number}  step1=${r.step1_status}  step2=${r.step2_status}  attempt=${r.attempt_number}`);
    }
    await pool.end();
    return;
  }

  let sent = 0, failed = 0, stale = 0;
  const queue = [...rows];

  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (queue.length) {
        const r = queue.shift();
        const result = await sendFcm(pool, r.user_id, r.fcm_token);
        if (result.ok) {
          sent++;
          console.log(`✓ ${r.user_id}`);
        } else if (result.reason === "stale_token_cleared") {
          stale++;
          console.log(`✗ ${r.user_id} (stale token cleared)`);
        } else {
          failed++;
          console.log(`✗ ${r.user_id} (${result.reason})`);
        }
      }
    })
  );

  console.log(`\nDone. sent=${sent} stale=${stale} failed=${failed} total=${rows.length}`);
  await pool.end();
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
