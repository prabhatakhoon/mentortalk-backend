/**
 * mentortalk-mentee-onboarding
 *
 * Routes:
 *   GET  /mentee/onboarding/status
 *   GET  /mentee/onboarding/categories
 *   POST /mentee/onboarding/basic-info   (name + username only)
 *   POST /mentee/onboarding/submit
 *
 * Categories + Education CRUD handled by mentor onboarding Lambda:
 *   POST /onboarding/mentorship/categories
 *   GET  /onboarding/education
 *   POST /onboarding/education
 *   DELETE /onboarding/education/:id
 */

import pg from "pg";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import jwt from "jsonwebtoken";
const { Client } = pg;


const secretsClient = new SecretsManagerClient({ region: "ap-south-1" });
let jwtSecret = null;

// ============================================================
// DATABASE CONNECTION (reused across warm Lambda invocations)
// ============================================================




const getJwtSecret = async () => {
  if (jwtSecret) return jwtSecret;
  const response = await secretsClient.send(
    new GetSecretValueCommand({ SecretId: "mentortalk/jwt-secret" })
  );
  jwtSecret = JSON.parse(response.SecretString).secret;
  return jwtSecret;
};



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
    const authHeader =
      event.headers?.Authorization || event.headers?.authorization || "";

    if (!authHeader.startsWith("Bearer ")) return null;

    const token = authHeader.split(" ")[1];
    const secret = await getJwtSecret();
    const payload = jwt.verify(token, secret);  // ← throws if tampered or expired

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
// HANDLERS
// ============================================================

/**
 * GET /mentee/onboarding/status
 *
 * Derives current step from what data exists:
 *   - No mentee_profile row         → { is_complete: false, current_step: 0 }
 *   - Profile exists, no mentorship → { is_complete: false, current_step: 0 }
 *   - Profile + mentorships exist   → { is_complete: false, current_step: 1 }
 *   - onboarding_completed_at set   → { is_complete: true, current_step: 2 }
 */
async function getStatus(db, userId) {
  const profileResult = await db.query(
    `SELECT username, onboarding_completed_at
     FROM mentee_profile WHERE user_id = $1`,
    [userId]
  );

  if (profileResult.rows.length === 0) {
    return res(200, { is_complete: false, current_step: 0 });
  }

  const profile = profileResult.rows[0];

  if (profile.onboarding_completed_at) {
    return res(200, { is_complete: true, current_step: 3 });
  }

  // Step 0: basic info (name + username)
  if (!profile.username) {
    return res(200, { is_complete: false, current_step: 0 });
  }

  // Step 1: categories
  const mentorshipResult = await db.query(
    `SELECT 1 FROM user_mentorship WHERE user_id = $1 AND role = 'mentee' LIMIT 1`,
    [userId]
  );

  if (mentorshipResult.rows.length === 0) {
    return res(200, { is_complete: false, current_step: 1 });
  }

  // Step 2: education (optional) — user can submit from here
  const educationResult = await db.query(
    `SELECT id, institution_name, degree, field_of_study, start_year, end_year
     FROM education WHERE user_id = $1 AND role = 'mentee'
     ORDER BY start_year DESC NULLS LAST, created_at DESC`,
    [userId]
  );

  return res(200, {
    is_complete: false,
    current_step: 2,
    education: educationResult.rows,
  });
}

/**
 * GET /mentee/onboarding/categories
 *
 * Returns categories from DB with their options nested.
 */
async function getCategories(db) {
  const catResult = await db.query(
    `SELECT id, name, sort_order
     FROM mentorship_category
     WHERE is_active = true
     ORDER BY sort_order`
  );

  const optResult = await db.query(
    `SELECT id, category_id, name, sort_order, group_label
     FROM mentorship_option
     WHERE is_active = true
     ORDER BY sort_order`
  );

  // Group options by category
  const optionsByCategory = {};
  for (const opt of optResult.rows) {
    if (!optionsByCategory[opt.category_id]) {
      optionsByCategory[opt.category_id] = [];
    }
    optionsByCategory[opt.category_id].push({
      id: opt.id,
      name: opt.name,
      code: opt.name,
      group_label: opt.group_label || null,
    });
  }

  const categories = catResult.rows.map((cat) => ({
    id: cat.id,
    name: cat.name,
    code: cat.name,
    options: optionsByCategory[cat.id] || [],
  }));

  return res(200, { categories });
}

/**
 * POST /mentee/onboarding/basic-info
 *
 * Body: { display_name, username, selected_categories }
 *
 * selected_categories format:
 *   { "jee": [], "ssc": ["ssc_cgl", "ssc_chsl"] }
 *
 * Actions:
 *   1. Validate inputs
 *   2. Check username uniqueness
 *   3. UPDATE user.first_name
 *   4. UPSERT mentee_profile with username
 *   5. DELETE old + INSERT new user_mentorship rows
 */
async function submitBasicInfo(db, userId, event) {
  const body = JSON.parse(event.body || "{}");
  const { display_name, username } = body;

  if (!display_name || !username) {
    return res(422, {
      message: "Validation failed",
      errors: {
        ...(!display_name && { display_name: ["Display name is required"] }),
        ...(!username && { username: ["Username is required"] }),
      },
    });
  }

  const usernameCheck = await db.query(
    `SELECT user_id FROM mentee_profile
     WHERE username = $1 AND user_id != $2`,
    [username, userId]
  );

  if (usernameCheck.rows.length > 0) {
    return res(409, { message: "Username already taken" });
  }

  const nameParts = display_name.trim().split(/\s+/);
  const firstName = nameParts[0];
  const lastName = nameParts.length > 1 ? nameParts.slice(1).join(' ') : null;

  await db.query(
    `INSERT INTO mentee_profile (user_id, username, first_name, last_name, updated_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (user_id)
     DO UPDATE SET username = $2, first_name = $3, last_name = $4, updated_at = NOW()`,
    [userId, username, firstName, lastName]
  );

  console.log(`[DB] Basic info saved for user ${userId}`);
  return res(200, { success: true });
}

/**
 * POST /mentee/onboarding/submit
 *
 * Validates all steps are done, then marks onboarding complete.
 */
async function submitOnboarding(db, userId) {
  const profile = await db.query(
    `SELECT username FROM mentee_profile WHERE user_id = $1`,
    [userId]
  );

  if (profile.rows.length === 0 || !profile.rows[0].username) {
    return res(400, { message: "Please complete basic info first." });
  }

  const mentorships = await db.query(
    `SELECT 1 FROM user_mentorship WHERE user_id = $1 AND role = 'mentee' LIMIT 1`,
    [userId]
  );

  if (mentorships.rows.length === 0) {
    return res(400, { message: "Please select at least one category." });
  }

  await db.query(
    `UPDATE mentee_profile
     SET onboarding_completed_at = NOW(), updated_at = NOW()
     WHERE user_id = $1`,
    [userId]
  );

  // Create mentee wallet (zero balance)
  await db.query(
    `INSERT INTO wallet (id, user_id, type, balance)
     VALUES (gen_random_uuid(), $1, 'mentee', 0)
     ON CONFLICT (user_id, type) DO NOTHING`,
    [userId]
  );

  // Create mentee promo status (free chat + intro rate entitlements)
  await db.query(
    `INSERT INTO mentee_promo_status (user_id, free_chat_used, intro_session_used)
     VALUES ($1, FALSE, FALSE)
     ON CONFLICT (user_id) DO NOTHING`,
    [userId]
  );

  // Create mentee privacy settings row with defaults from column definitions
  await db.query(
    `INSERT INTO mentee_privacy_settings (user_id)
     VALUES ($1)
     ON CONFLICT (user_id) DO NOTHING`,
    [userId]
  );

  console.log(`[DB] Onboarding completed for user ${userId}`);
  return res(200, { success: true });
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

   // Public endpoints (no auth needed)
   if (method === "GET" && path.endsWith("/categories")) {
    const db = await getClient();
    return await getCategories(db);
  }

  // Auth-required endpoints
  const userId = await getUserId(event);
  if (!userId) return res(401, { message: "Unauthorized" });

  const db = await getClient();

  if (method === "GET" && path.endsWith("/status"))
    return await getStatus(db, userId);
  if (method === "POST" && path.endsWith("/basic-info"))
    return await submitBasicInfo(db, userId, event);
  if (method === "POST" && path.endsWith("/submit"))
    return await submitOnboarding(db, userId);

    return res(404, { message: "Not found" });
  } catch (error) {
    console.error("[ERROR] Unhandled:", error);
    return res(500, { message: "Internal server error" });
  }
};
