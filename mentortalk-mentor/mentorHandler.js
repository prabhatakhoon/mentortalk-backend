import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import pg from "pg";
import jwt from "jsonwebtoken";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const s3Client = new S3Client({ region: "ap-south-1" });
const BUCKET_NAME = "mentortalk-storage-prod";

const dynamoClient = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: "ap-south-1" })
);
const { Pool } = pg;
const secretsClient = new SecretsManagerClient({ region: "ap-south-1" });
function toFullUrl(path) {
  if (!path || path.startsWith('http')) return path;
  const cdnBase = process.env.CDN_BASE_URL;
  if (cdnBase) return `${cdnBase}/${path}`;
  return null;
}

let pool = null;
let jwtSecret = null;

// ─── Shared Setup ────────────────────────────────────────────

const getDbCredentials = async () => {
  const response = await secretsClient.send(
    new GetSecretValueCommand({ SecretId: "mentortalk/db-app-credentials" })
  );
  return JSON.parse(response.SecretString);
};

const getJwtSecret = async () => {
  if (jwtSecret) return jwtSecret;
  const response = await secretsClient.send(
    new GetSecretValueCommand({ SecretId: "mentortalk/jwt-secret" })
  );
  jwtSecret = JSON.parse(response.SecretString).secret;
  return jwtSecret;
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

const verifyToken = async (authHeader) => {
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    throw new Error("Missing or invalid authorization header");
  }
  const token = authHeader.split(" ")[1];
  const secret = await getJwtSecret();
  return jwt.verify(token, secret);
};

const respond = (statusCode, body) => ({
  statusCode,
  headers: {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  },
  body: JSON.stringify(body),
});

// Lightweight push for presence broadcast only — no FCM needed
async function pushToUser(userId, payload) {
  const conn = await dynamoClient.send(new GetCommand({
    TableName: "mentortalk-connections",
    Key: { user_id: userId },
  }));

  if (!conn.Item) return;

  const { ApiGatewayManagementApiClient, PostToConnectionCommand } = await import("@aws-sdk/client-apigatewaymanagementapi");
  const apiClient = new ApiGatewayManagementApiClient({ endpoint: process.env.WS_ENDPOINT });

  try {
    await apiClient.send(new PostToConnectionCommand({
      ConnectionId: conn.Item.connection_id,
      Data: Buffer.from(JSON.stringify(payload)),
    }));
  } catch (err) {
    console.log(`Push to ${userId} failed: ${err.message}`);
  }
}

// ─── Route Handler ───────────────────────────────────────────

export const handler = async (event) => {
  console.log("Mentor event:", JSON.stringify(event));

  try {
    const authHeader = event.headers?.Authorization || event.headers?.authorization;
    const decoded = await verifyToken(authHeader);
    const userId = decoded.sub;
    const userRole = decoded.role;

    if (userRole !== "mentor") {
      return respond(403, { error: "Forbidden — mentor access only" });
    }

    const method = event.httpMethod;
    const path = event.resource || event.path;

    // ─── Profile ───────────────────────────────────────────
    if (method === "GET" && path === "/mentor/profile") {
      return await getProfile(userId);
    }
    if (method === "GET" && path === "/mentor/earnings/overview") {
      return await getEarningsOverview(userId, event);
    }

    if (method === "PUT" && path === "/mentor/profile") {
      return await updateProfile(userId, event);
    }

    if (method === "PUT" && path === "/mentor/availability") {
      return await updateAvailability(userId, event);
    }

    // ─── Stats ─────────────────────────────────────────────
    if (method === "GET" && path === "/mentor/stats") {
      return await getStats(userId, event);
    }

    // ─── Sessions ──────────────────────────────────────────
    if (method === "GET" && path === "/mentor/sessions") {
      return await getSessions(userId, event);
    }

    if (method === "GET" && (path === "/session/{session_id}/details" || path.match(/\/session\/[^/]+\/details/))) {
      return await getSessionDetails(userId, event);
    }

    // ─── Transactions ──────────────────────────────────────
    if (method === "GET" && path === "/mentor/transactions") {
      return await getTransactions(userId, event);
    }

    // ─── Reviews ───────────────────────────────────────────
    if (method === "GET" && path === "/mentor/reviews") {
      return await getReviews(userId, event);
    }

    // ─── Tier Progress ─────────────────────────────────────
    if (method === "GET" && path === "/mentor/tier-progress") {
      return await getTierProgress(userId);
    }

     // ─── Mentees ─────────────────────────────────────────────
     if (method === "GET" && path.match(/\/mentor\/mentees\/[^/]+\/messages/)) {
      return await getMenteeMessages(userId, event);
    }

    if (method === "GET" && path === "/mentor/mentees") {
      return await getMentees(userId, event);
    }


    if (path === '/mentor/profile/photo/presign' && method === 'POST') {
        return await profilePhotoPresign(userId, event);
      }
      if (path === '/mentor/profile/photo/confirm' && method === 'POST') {
        return await profilePhotoConfirm(userId, event);
      }

      if (method === "GET" && path === "/mentor/launch-info") {
        const launchDate = process.env.LAUNCH_DATE || null;
        if (!launchDate) return respond(200, { launch_date: null });
        return respond(200, {
          launch_date: launchDate,
          title: "Launching Soon!",
          message: "Start receiving sessions on " + new Date(launchDate).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' }+"."),
        });
      }

      // ─── Quick Replies ───────────────────────────────────────
    if (method === "GET" && path === "/mentor/quick-replies") {
      return await getQuickReplies(userId);
    }
    if (method === "POST" && path === "/mentor/quick-replies") {
      return await createQuickReply(userId, event);
    }
    if (method === "PUT" && path.match(/\/mentor\/quick-replies\/[^/]+$/)) {
      return await updateQuickReply(userId, event);
    }
    if (method === "DELETE" && path.match(/\/mentor\/quick-replies\/[^/]+$/)) {
      return await deleteQuickReply(userId, event);
    }
  
      return respond(404, { error: "Not found" });
  } catch (err) {
    if (err.name === "JsonWebTokenError" || err.name === "TokenExpiredError" || err.message.includes("authorization header")) {
      return respond(401, { error: "Unauthorized" });
    }
    console.error("Unhandled error:", err);
    return respond(500, { error: "Internal server error" });
  }
};

// ─── GET /mentor/profile ─────────────────────────────────────
// user: id, phone_number, first_name, last_name, created_at
// mentor_profile: user_id, profile_photo_url, bio, rate_per_minute,
//   is_available, pref_audio, pref_video, unlocked_tier_id,
//   pending_earnings, avg_rating, total_reviews
// rate_tier: id, name, max_rate
// user_mentorship → mentorship_category: name
// user_language: user_id, language_code

async function getProfile(userId) {
  const db = await getPool();

  const result = await db.query(
    `SELECT
       u.id, mp.first_name, mp.last_name, u.phone_number,
       u.created_at AS member_since,
       mp.profile_photo_url, mp.bio, mp.rate_per_minute,
       mp.is_available, mp.pref_audio, mp.pref_video,
       mp.intro_discount_percent,
       mw.balance AS wallet_balance, mp.avg_rating, mp.total_reviews,
       mp.unlocked_tier_id,
       rt.name AS tier_name, rt.max_rate AS tier_max_rate,
       array_agg(DISTINCT mc.name) FILTER (WHERE mc.name IS NOT NULL) AS categories,
array_agg(DISTINCT ul.language_code) FILTER (WHERE ul.language_code IS NOT NULL) AS languages,
       mp.free_chat_enabled,
       pc.free_chat_enabled AS global_free_chat_enabled,
       COALESCE(mfcq.count, 0) AS free_chat_count_today,
       COALESCE(mfcq.max_count, pc.mentor_daily_free_cap, 5) AS free_chat_daily_cap,
       pc.free_chat_duration_secs
   FROM "user" u
     JOIN mentor_profile mp ON mp.user_id = u.id
     LEFT JOIN wallet mw ON mw.user_id = u.id AND mw.type = 'mentor'
     LEFT JOIN rate_tier rt ON rt.id = mp.unlocked_tier_id
     LEFT JOIN user_mentorship um ON um.user_id = u.id AND um.role = 'mentor'
    LEFT JOIN mentorship_category mc ON mc.id = um.mentorship_category_id
LEFT JOIN user_language ul ON ul.user_id = u.id AND ul.role = 'mentor'
     LEFT JOIN mentor_free_chat_quota mfcq ON mfcq.mentor_id = u.id AND mfcq.date = CURRENT_DATE
     CROSS JOIN promo_config pc
     WHERE u.id = $1 AND pc.id = 1
     GROUP BY u.id, mp.user_id, rt.name, rt.max_rate, mw.balance, mfcq.count, mfcq.max_count, pc.free_chat_enabled, pc.mentor_daily_free_cap, pc.free_chat_duration_secs`,
    [userId]
  );

  if (result.rows.length === 0) {
    return respond(404, { error: "Mentor profile not found" });
  }

  const row = result.rows[0];

  return respond(200, {
    id: row.id,
    first_name: row.first_name,
    last_name: row.last_name,
    phone_number: row.phone_number,
    profile_image_url: toFullUrl(row.profile_photo_url),
    bio: row.bio,
    rate_per_minute: row.rate_per_minute ? parseFloat(row.rate_per_minute) : null,
    intro_discount_percent: row.intro_discount_percent,
    intro_rate_per_minute: row.intro_discount_percent != null
      ? parseFloat(row.rate_per_minute) * (1 - row.intro_discount_percent / 100)
      : null,
    is_available: row.is_available,
    pref_audio: row.pref_audio,
    pref_video: row.pref_video,
    pending_earnings: parseFloat(row.wallet_balance) || 0,
    avg_rating: parseFloat(row.avg_rating) || 0,
    total_reviews: row.total_reviews || 0,
    tier: {
      id: row.unlocked_tier_id,
      name: row.tier_name,
      max_rate: row.tier_max_rate ? parseFloat(row.tier_max_rate) : 0,
    },
    categories: row.categories || [],
    languages: row.languages || [],
    member_since: row.member_since,
    free_chat: {
      enabled: (row.free_chat_enabled ?? false) && (row.global_free_chat_enabled ?? false),
      count_today: parseInt(row.free_chat_count_today) || 0,
      daily_cap: parseInt(row.free_chat_daily_cap) || 5,
      session_duration_secs: row.free_chat_duration_secs || 180,
    },
  });
}

// ─── PUT /mentor/profile ─────────────────────────────────────
// user: first_name, last_name
// mentor_profile: bio, rate_per_minute, profile_photo_url
async function updateProfile(userId, event) {
  const body = JSON.parse(event.body || "{}");
  const db = await getPool();

 // ── User table updates (no name fields — names live on mentor_profile) ──
 const userUpdates = [];
 const userValues = [];
 let idx = 1;
  // ── Mentor profile table updates (bio, photo, rate) ──
  const profileUpdates = [];
  const profileValues = [];
  let pidx = 1;

  if (body.first_name !== undefined) {
    profileUpdates.push(`first_name = $${pidx++}`);
    profileValues.push(body.first_name);
  }
  if (body.last_name !== undefined) {
    profileUpdates.push(`last_name = $${pidx++}`);
    profileValues.push(body.last_name);
  }
  if (body.bio !== undefined) {
    profileUpdates.push(`bio = $${pidx++}`);
    profileValues.push(body.bio);
  }
  if (body.profile_photo_url !== undefined) {
    profileUpdates.push(`profile_photo_url = $${pidx++}`);
    profileValues.push(body.profile_photo_url);
  }
  if (body.rate_per_minute !== undefined) {
    const tierResult = await db.query(
      `SELECT rt.max_rate FROM mentor_profile mp
       JOIN rate_tier rt ON rt.id = mp.unlocked_tier_id
       WHERE mp.user_id = $1`,
      [userId]
    );
    if (tierResult.rows.length > 0 && tierResult.rows[0].max_rate) {
      const maxRate = parseFloat(tierResult.rows[0].max_rate);
      if (body.rate_per_minute > maxRate) {
        return respond(400, { error: `Rate cannot exceed ₹${maxRate}/min for your current tier` });
      }
    }
    if (body.rate_per_minute < 1) {
      return respond(400, { error: "Rate must be at least ₹1/min" });
    }
    profileUpdates.push(`rate_per_minute = $${pidx++}`);
    profileValues.push(body.rate_per_minute);
  }
  if (body.intro_discount_percent !== undefined) {
    const valid = [null, 25, 50];
    if (!valid.includes(body.intro_discount_percent)) {
      return respond(400, { error: "intro_discount_percent must be null, 25, or 50" });
    }
    profileUpdates.push(`intro_discount_percent = $${pidx++}`);
    profileValues.push(body.intro_discount_percent);
  }

  // ── Languages (ISO 639-1 codes via user_language junction table) ──
  const hasLanguages = body.languages !== undefined && Array.isArray(body.languages);

  if (userUpdates.length === 0 && profileUpdates.length === 0 && !hasLanguages) {
    return respond(400, { error: "No fields to update" });
  }

  let oldPhotoKey = null;
  if (body.profile_photo_url !== undefined) {
    const old = await db.query(
      `SELECT profile_photo_url FROM mentor_profile WHERE user_id = $1`,
      [userId]
    );
    oldPhotoKey = old.rows[0]?.profile_photo_url;
  }

  const client = await db.connect();
  try {
    await client.query("BEGIN");

    if (userUpdates.length > 0) {
      await client.query(
        `UPDATE "user" SET ${userUpdates.join(", ")}, updated_at = NOW() WHERE id = $${idx}`,
        [...userValues, userId]
      );
    }

    if (profileUpdates.length > 0) {
      await client.query(
        `UPDATE mentor_profile SET ${profileUpdates.join(", ")}, updated_at = NOW() WHERE user_id = $${pidx}`,
        [...profileValues, userId]
      );
    }

    if (hasLanguages) {
      // Delete-and-reinsert within the same transaction
      await client.query("DELETE FROM user_language WHERE user_id = $1 AND role = 'mentor'", [userId]);

      if (body.languages.length > 0) {
        // Batch insert: VALUES ($1,$2), ($1,$3), ($1,$4)...
        const langParams = [userId];

        const langPlaceholders = body.languages.map((code, i) => {
          langParams.push(code);
          return `($1, $${i + 2}, 'mentor')`;
        });
        
        await client.query(
          `INSERT INTO user_language (user_id, language_code, role) VALUES ${langPlaceholders.join(", ")}`,
          langParams
        );
      }
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  if (oldPhotoKey) {
    try {
      await s3Client.send(new DeleteObjectCommand({
        Bucket: BUCKET_NAME,
        Key: oldPhotoKey,
      }));
    } catch (e) {
      console.warn("Failed to delete old photo:", e.message);
    }
  }
  // Return full profile (getProfile already joins user_language)
  return await getProfile(userId);
}

// ─── PUT /mentor/availability ────────────────────────────────
// mentor_profile: is_available, pref_audio, pref_video

async function updateAvailability(userId, event) {
  const body = JSON.parse(event.body || "{}");
  const db = await getPool();

  const updates = [];
  const values = [];
  let idx = 1;

  if (body.is_available !== undefined) {
    updates.push(`is_available = $${idx++}`);
    values.push(body.is_available);
  }
  if (body.pref_audio !== undefined) {
    updates.push(`pref_audio = $${idx++}`);
    values.push(body.pref_audio);
  }
  if (body.pref_video !== undefined) {
    updates.push(`pref_video = $${idx++}`);
    values.push(body.pref_video);
  }

  if (updates.length === 0) {
    return respond(400, { error: "No availability fields to update" });
  }

  values.push(userId);
  await db.query(
    `UPDATE mentor_profile SET ${updates.join(", ")}, updated_at = NOW() WHERE user_id = $${idx}`,
    values
  );

  const result = await db.query(
    `SELECT is_available, pref_audio, pref_video FROM mentor_profile WHERE user_id = $1`,
    [userId]
  );

  // Push availability change to any mentee watching this mentor's chat thread
  if (body.is_available !== undefined) {
    try {
      const subs = await dynamoClient.send(new QueryCommand({
        TableName: "mentortalk-presence-subscriptions",
        KeyConditionExpression: "target_user_id = :uid",
        ExpressionAttributeValues: { ":uid": userId },
      }));

      if (subs.Items && subs.Items.length > 0) {
        const presence = await dynamoClient.send(new GetCommand({
          TableName: "mentortalk-presence",
          Key: { user_id: userId },
        }));

        const payload = {
          type: "presence_update",
          user_id: userId,
          presence: presence.Item?.status || "offline",
          is_available: result.rows[0].is_available,
          last_seen: presence.Item?.last_seen || new Date().toISOString(),
        };

        await Promise.all(
          subs.Items.map(sub => pushToUser(sub.subscriber_id, payload))
        );
      }
    } catch (err) {
      console.error("Availability broadcast failed:", err.message);
    }
  }

  return respond(200, {
    is_available: result.rows[0].is_available,
    pref_audio: result.rows[0].pref_audio,
    pref_video: result.rows[0].pref_video,
  });
}

// ─── GET /mentor/stats ───────────────────────────────────────
// session: mentor_id, status, started_at, ended_at, mentor_earning

async function getStats(userId, event) {
  const period = event.queryStringParameters?.period || "this_week";
  const db = await getPool();

  let dateFilter;
  switch (period) {
    case "today":
      dateFilter = "AND s.ended_at >= CURRENT_DATE";
      break;
    case "this_week":
      dateFilter = "AND s.ended_at >= DATE_TRUNC('week', CURRENT_DATE)";
      break;
    case "this_month":
      dateFilter = "AND s.ended_at >= DATE_TRUNC('month', CURRENT_DATE)";
      break;
    case "all_time":
      dateFilter = "";
      break;
    default:
      return respond(400, { error: "Invalid period. Use: today, this_week, this_month, all_time" });
  }

  const result = await db.query(
    `SELECT
       COALESCE(SUM(s.mentor_earning), 0) AS total_earnings,
       COUNT(*)::int AS session_count,
       COALESCE(SUM(
         EXTRACT(EPOCH FROM (s.ended_at - s.started_at)) / 60
       ), 0)::int AS total_minutes
     FROM session s
     WHERE s.mentor_id = $1
       AND s.status = 'completed'
       ${dateFilter}`,
    [userId]
  );

  const row = result.rows[0];

  return respond(200, {
    period,
    earnings: parseFloat(row.total_earnings) || 0,
    session_count: row.session_count || 0,
    total_minutes: row.total_minutes || 0,
  });
}

// ─── GET /mentor/sessions ────────────────────────────────────
// session: id, mentor_id, mentee_id, status, started_at, ended_at, mentor_earning
// session_segment: session_id, type, rate_per_minute, duration_seconds
// user: first_name, last_name (mentee)
// mentee_profile: profile_photo_url (mentee avatar)
// review: session_id, rating
// user_mentorship → mentorship_category (mentee categories)

async function getSessions(userId, event) {
  const params = event.queryStringParameters || {};
  const limit = Math.min(parseInt(params.limit) || 10, 50);
  const offset = parseInt(params.offset) || 0;
  const status = params.status || "completed";

  const db = await getPool();

  let statusFilter = "";
  if (status !== "all") {
    statusFilter = `AND s.status = '${status}'`;
  }

  const result = await db.query(
    `SELECT
       s.id, s.mentee_id, s.status,
       s.started_at, s.ended_at, s.mentor_earning,
          mtp.first_name AS mentee_first_name,
       mtp.last_name AS mentee_last_name,
       mtp.profile_photo_url AS mentee_avatar,
       COALESCE(mps.block_screenshots, FALSE)    AS block_screenshots,
       COALESCE(mps.block_call_recording, FALSE) AS block_call_recording,
       array_agg(DISTINCT ss.type) FILTER (WHERE ss.type IS NOT NULL) AS modes,
       COALESCE(SUM(ss.duration_seconds), 0)::int AS total_duration_seconds,
       r.rating AS review_rating,
       array_agg(DISTINCT mc.name) FILTER (WHERE mc.name IS NOT NULL) AS mentee_categories
     FROM session s
     JOIN "user" u ON u.id = s.mentee_id
     LEFT JOIN mentee_profile mtp ON mtp.user_id = s.mentee_id
     LEFT JOIN mentee_privacy_settings mps ON mps.user_id = s.mentee_id
     LEFT JOIN session_segment ss ON ss.session_id = s.id
     LEFT JOIN review r ON r.session_id = s.id
     LEFT JOIN user_mentorship um ON um.user_id = s.mentee_id AND um.role = 'mentee'
     LEFT JOIN mentorship_category mc ON mc.id = um.mentorship_category_id
     WHERE s.mentor_id = $1
       ${statusFilter}
     GROUP BY s.id, mtp.first_name, mtp.last_name, mtp.profile_photo_url, r.rating,
              mps.block_screenshots, mps.block_call_recording
     ORDER BY s.started_at DESC
     LIMIT $2 OFFSET $3`,
    [userId, limit, offset]
  );

  const countResult = await db.query(
    `SELECT COUNT(*)::int AS total FROM session s WHERE s.mentor_id = $1 ${statusFilter}`,
    [userId]
  );

  const sessions = result.rows.map((row) => ({
    id: row.id,
    mentee: {
      id: row.mentee_id,
      name: [row.mentee_first_name, row.mentee_last_name].filter(Boolean).join(" "),
      avatar: toFullUrl(row.mentee_avatar),
      categories: row.mentee_categories || [],
      privacy: {
        block_screenshots: row.block_screenshots,
        block_call_recording: row.block_call_recording,
      },
    },
    status: row.status,
    modes: Array.isArray(row.modes) ? row.modes : (row.modes || '').replace(/[{}]/g, '').split(',').filter(Boolean),
    total_duration_seconds: row.total_duration_seconds,
    mentor_earning: row.mentor_earning ? parseFloat(row.mentor_earning) : 0,
    review_rating: row.review_rating ? parseInt(row.review_rating) : null,
    started_at: row.started_at,
    ended_at: row.ended_at,
  }));

  return respond(200, {
    sessions,
    pagination: {
      total: countResult.rows[0].total,
      limit,
      offset,
      has_more: offset + limit < countResult.rows[0].total,
    },
  });
}

// ─── GET /session/{session_id}/details ───────────────────────
// session: id, mentor_id, mentee_id, status, started_at, ended_at,
//   total_amount, platform_fee, mentor_earning
// session_segment: id, session_id, type, rate_per_minute, started_at, ended_at, duration_seconds
// review: session_id, mentor_id, mentee_id, rating (smallint), comment, created_at
// user: first_name, last_name (mentee)
// mentee_profile: profile_photo_url
// user_mentorship → mentorship_category (mentee categories)

async function getSessionDetails(userId, event) {
  const sessionId = event.pathParameters?.session_id || event.path.split("/")[2];
  const db = await getPool();

  const session = await db.query(
    `SELECT
       s.id, s.mentee_id, s.mentor_id, s.status,
       s.started_at, s.ended_at,
       s.total_amount, s.platform_fee, s.mentor_earning,
       s.billing_type,
       mtp.first_name AS mentee_first_name,
       mtp.last_name AS mentee_last_name,
       mtp.profile_photo_url AS mentee_avatar
     FROM session s
     JOIN "user" u ON u.id = s.mentee_id
     LEFT JOIN mentee_profile mtp ON mtp.user_id = s.mentee_id
     WHERE s.id = $1 AND s.mentor_id = $2
       AND s.status IN ('completed', 'cancelled', 'rejected', 'timed_out')`,
    [sessionId, userId]
  );

  if (session.rows.length === 0) {
    return respond(404, { error: "Session not found" });
  }

  const s = session.rows[0];

  // session_segment: id, type, rate_per_minute, started_at, ended_at, duration_seconds
  const segments = await db.query(
    `SELECT id, type, rate_per_minute, started_at, ended_at, duration_seconds
     FROM session_segment
     WHERE session_id = $1
     ORDER BY started_at ASC`,
    [sessionId]
  );

  const segmentDetails = segments.rows.map((seg) => {
    const durationMinutes = Math.ceil((seg.duration_seconds || 0) / 60);
    const totalCost = durationMinutes * parseFloat(seg.rate_per_minute);
    const mentorEarning = totalCost * 0.5;
    return {
      id: seg.id,
      type: seg.type,
      rate_per_minute: parseFloat(seg.rate_per_minute),
      started_at: seg.started_at,
      ended_at: seg.ended_at,
      duration_seconds: seg.duration_seconds,
      duration_minutes: durationMinutes,
      mentor_earning: mentorEarning,
    };
  });

  // review: rating (smallint), comment, created_at
  const reviewResult = await db.query(
    `SELECT rating, comment, created_at FROM review WHERE session_id = $1`,
    [sessionId]
  );

  // mentee categories
  const categoriesResult = await db.query(
    `SELECT mc.name FROM user_mentorship um
 JOIN mentorship_category mc ON mc.id = um.mentorship_category_id
 WHERE um.user_id = $1 AND um.role = 'mentee'`,
    [s.mentee_id]
  );

  const primarySegment = segmentDetails[0] || null;

  return respond(200, {
    id: s.id,
    status: s.status,
    started_at: s.started_at,
    ended_at: s.ended_at,
    session_type: primarySegment ? primarySegment.type : null,
    rate_per_minute: primarySegment ? primarySegment.rate_per_minute : null,
    billing_type: s.billing_type || null,
    mentee: {
      id: s.mentee_id,
      name: [s.mentee_first_name, s.mentee_last_name].filter(Boolean).join(" "),
      avatar: toFullUrl(s.mentee_avatar),
      categories: categoriesResult.rows.map((r) => r.name),
    },
    segments: segmentDetails,
    total_duration_seconds: segmentDetails.reduce((sum, seg) => sum + (seg.duration_seconds || 0), 0),
    total_duration_minutes: segmentDetails.reduce((sum, seg) => sum + seg.duration_minutes, 0),
    total_earning: s.mentor_earning ? parseFloat(s.mentor_earning) : 0,
    review: reviewResult.rows.length > 0
      ? {
          rating: parseInt(reviewResult.rows[0].rating),
          comment: reviewResult.rows[0].comment,
          created_at: reviewResult.rows[0].created_at,
        }
      : null,
  });
}

// ─── GET /mentor/transactions ────────────────────────────────
// transaction: id, user_id, type, direction, amount, session_id, reference_id, status, created_at
// NO description column on transaction table

async function getTransactions(userId, event) {
  const params = event.queryStringParameters || {};
  const limit = Math.min(parseInt(params.limit) || 20, 50);
  const offset = parseInt(params.offset) || 0;
  const type = params.type;

  const db = await getPool();

  let typeFilter = "";
  const queryValues = [userId];
  let paramIdx = 2;

  if (type) {
    const validTypes = type.split(",").map(t => t.trim()).filter(t =>
      ["session_earning", "mentor_payout"].includes(t)
    );
    if (validTypes.length > 0) {
      const placeholders = validTypes.map((_, i) => `$${paramIdx + i}`);
      typeFilter = `AND t.type IN (${placeholders.join(",")})`;
      queryValues.push(...validTypes);
      paramIdx += validTypes.length;
    }
  }

  const result = await db.query(
    `SELECT
       t.id, t.type, t.direction, t.amount,
       t.session_id, t.reference_id, t.status, t.notes, t.created_at,
       s.started_at AS session_started_at,
       s.billing_type,
         mtp.first_name AS other_first_name,
       mtp.last_name AS other_last_name,
       mtp.profile_photo_url AS other_avatar
     FROM transaction t
     JOIN wallet w ON w.id = t.wallet_id
     LEFT JOIN session s ON s.id = t.session_id
     LEFT JOIN mentee_profile mtp ON mtp.user_id = s.mentee_id

     WHERE t.user_id = $1 AND w.type = 'mentor'
       ${typeFilter}
     ORDER BY t.created_at DESC
     LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
    [...queryValues, limit, offset]
  );

  const countResult = await db.query(
    `SELECT COUNT(*)::int AS total
     FROM transaction t
     JOIN wallet w ON w.id = t.wallet_id
     WHERE t.user_id = $1 AND w.type = 'mentor' ${typeFilter}`,
    queryValues
  );

  const transactions = result.rows.map((row) => ({
    id: row.id,
    type: row.type,
    direction: row.direction,
    amount: parseFloat(row.amount),
    session_id: row.session_id,
    reference_id: row.reference_id,
    status: row.status,
    notes: row.notes || null,
    billing_type: row.billing_type || null,
    other_user_name: row.other_first_name
    ? [row.other_first_name, row.other_last_name].filter(Boolean).join(" ")
    : null,
  other_user_avatar: toFullUrl(row.other_avatar),
  session_started_at: row.session_started_at,
  created_at: row.created_at,
  }));

  return respond(200, {
    transactions,
    pagination: {
      total: countResult.rows[0].total,
      limit,
      offset,
      has_more: offset + limit < countResult.rows[0].total,
    },
  });
}

// ─── GET /mentor/reviews ─────────────────────────────────────
// review: id, session_id, mentor_id, mentee_id, rating (smallint), comment, created_at
// session: started_at
// user: first_name, last_name (mentee)
// mentee_profile: profile_photo_url
// session_segment: type

async function getReviews(userId, event) {
  const params = event.queryStringParameters || {};
  const limit = Math.min(parseInt(params.limit) || 10, 50);
  const offset = parseInt(params.offset) || 0;

  const db = await getPool();

  const result = await db.query(
    `SELECT
       r.id, r.rating, r.comment, r.created_at,
       r.session_id,
       s.started_at AS session_date,
      mtp.first_name AS mentee_first_name,
       mtp.last_name AS mentee_last_name,
       mtp.profile_photo_url AS mentee_avatar,
       COALESCE(mps.show_name_in_reviews, TRUE) AS show_name,
       array_agg(DISTINCT ss.type) FILTER (WHERE ss.type IS NOT NULL) AS modes
     FROM review r
     JOIN session s ON s.id = r.session_id
     JOIN "user" u ON u.id = r.mentee_id
     LEFT JOIN mentee_profile mtp ON mtp.user_id = r.mentee_id
     LEFT JOIN mentee_privacy_settings mps ON mps.user_id = r.mentee_id
     LEFT JOIN session_segment ss ON ss.session_id = s.id
     WHERE r.mentor_id = $1
     GROUP BY r.id, s.started_at, mtp.first_name, mtp.last_name, mtp.profile_photo_url, mps.show_name_in_reviews
     ORDER BY r.created_at DESC
     LIMIT $2 OFFSET $3`,
    [userId, limit, offset]
  );

  const countResult = await db.query(
    `SELECT COUNT(*)::int AS total FROM review WHERE mentor_id = $1`,
    [userId]
  );

  const reviews = result.rows.map((row) => ({
    id: row.id,
    rating: parseInt(row.rating),
    comment: row.comment,
    session_id: row.session_id,
    session_date: row.session_date,
    mentee: {
      name: row.show_name
        ? [row.mentee_first_name, row.mentee_last_name].filter(Boolean).join(" ")
        : null,
      avatar: row.show_name ? toFullUrl(row.mentee_avatar) : null,
    },
    modes: Array.isArray(row.modes) ? row.modes : (row.modes || '').replace(/[{}]/g, '').split(',').filter(Boolean),
    created_at: row.created_at,
  }));

  return respond(200, {
    reviews,
    summary: {
      total_reviews: countResult.rows[0].total,
    },
    pagination: {
      total: countResult.rows[0].total,
      limit,
      offset,
      has_more: offset + limit < countResult.rows[0].total,
    },
  });
}

// ─── GET /mentor/tier-progress ───────────────────────────────
// mentor_profile: unlocked_tier_id, avg_rating, total_reviews
// rate_tier: id, name, max_rate, required_sessions, required_minutes, required_rating
// session: mentor_id, status, started_at, ended_at

async function getTierProgress(userId) {
  const db = await getPool();

  const mentorResult = await db.query(
    `SELECT mp.unlocked_tier_id, mp.avg_rating, mp.total_reviews
     FROM mentor_profile mp WHERE mp.user_id = $1`,
    [userId]
  );

  if (mentorResult.rows.length === 0) {
    return respond(404, { error: "Mentor profile not found" });
  }

  const mentor = mentorResult.rows[0];

  const currentTierResult = await db.query(
    `SELECT id, name, max_rate FROM rate_tier WHERE id = $1`,
    [mentor.unlocked_tier_id]
  );

  const nextTierResult = await db.query(
    `SELECT id, name, max_rate, required_sessions, required_minutes, required_rating
     FROM rate_tier WHERE id = $1 + 1`,
    [mentor.unlocked_tier_id]
  );

  const statsResult = await db.query(
    `SELECT
       COUNT(*)::int AS total_sessions,
       COALESCE(SUM(EXTRACT(EPOCH FROM (ended_at - started_at)) / 60), 0)::int AS total_minutes
     FROM session
     WHERE mentor_id = $1 AND status = 'completed'`,
    [userId]
  );

  const currentTier = currentTierResult.rows[0];
  const nextTier = nextTierResult.rows[0];
  const stats = statsResult.rows[0];
  const currentRating = parseFloat(mentor.avg_rating) || 0;

  if (!nextTier) {
    return respond(200, {
      current_tier: {
        id: currentTier.id,
        name: currentTier.name,
        max_rate: currentTier.max_rate ? parseFloat(currentTier.max_rate) : 0,
      },
      next_tier: null,
      is_max_tier: true,
      requirements: [],
      met_count: 0,
      total_count: 0,
      progress_percent: 100,
    });
  }

  const requirements = [
    {
      type: "sessions",
      label: "Sessions",
      current: stats.total_sessions,
      target: nextTier.required_sessions,
      met: stats.total_sessions >= nextTier.required_sessions,
      percent: nextTier.required_sessions > 0
        ? Math.min(Math.round((stats.total_sessions / nextTier.required_sessions) * 100), 100)
        : 100,
    },
    {
      type: "minutes",
      label: "Minutes",
      current: stats.total_minutes,
      target: nextTier.required_minutes,
      met: stats.total_minutes >= nextTier.required_minutes,
      percent: nextTier.required_minutes > 0
        ? Math.min(Math.round((stats.total_minutes / nextTier.required_minutes) * 100), 100)
        : 100,
    },
    {
      type: "rating",
      label: "Rating",
      current: currentRating,
      target: parseFloat(nextTier.required_rating),
      met: currentRating >= parseFloat(nextTier.required_rating),
      percent: parseFloat(nextTier.required_rating) > 0
        ? Math.min(Math.round((currentRating / parseFloat(nextTier.required_rating)) * 100), 100)
        : 100,
    },
  ];

  const metCount = requirements.filter((r) => r.met).length;
  const minPercent = Math.min(...requirements.map((r) => r.percent));

  return respond(200, {
    current_tier: {
      id: currentTier.id,
      name: currentTier.name,
      max_rate: currentTier.max_rate ? parseFloat(currentTier.max_rate) : 0,
    },
    next_tier: {
      id: nextTier.id,
      name: nextTier.name,
      max_rate: nextTier.max_rate ? parseFloat(nextTier.max_rate) : 0,
    },
    is_max_tier: false,
    requirements,
    met_count: metCount,
    total_count: requirements.length,
    progress_percent: minPercent,
  });
}

async function getEarningsOverview(userId, event) {
  const params = event.queryStringParameters || {};
  const period = params.period || "weekly";
  const offset = parseInt(params.offset) || 0;

  if (!["daily", "weekly", "monthly"].includes(period)) {
    return respond(400, {
      error: "Invalid period. Use: daily, weekly, monthly",
    });
  }
  if (offset > 0) {
    return respond(400, { error: "Offset must be 0 or negative" });
  }

  const db = await getPool();

  // ── 1. Compute date range (IST-aware) ──────────────────────

  const { startDate, endDate, periodLabel } = computeDateRange(period, offset);

  // ── 2. Stats for the period ────────────────────────────────

  const { rows: [statsRow] } = await db.query(
    `SELECT
       COALESCE(SUM(s.mentor_earning), 0) AS total_earnings,
       COUNT(*)::int AS session_count,
       COALESCE(SUM(
         EXTRACT(EPOCH FROM (s.ended_at - s.started_at)) / 60
       ), 0) AS total_minutes
     FROM session s
     WHERE s.mentor_id = $1
       AND s.status = 'completed'
       AND (s.ended_at AT TIME ZONE 'Asia/Kolkata')::date
           BETWEEN $2::date AND $3::date`,
    [userId, startDate, endDate]
  );

  const total = parseFloat(statsRow.total_earnings) || 0;
  const sessionCount = statsRow.session_count || 0;
  const totalMinutes = parseFloat(statsRow.total_minutes) || 0;
  const totalSeconds = Math.round(totalMinutes * 60);
  const totalMinutesRounded = Math.round(totalMinutes * 10) / 10 || (totalMinutes > 0 ? 0.1 : 0);
  const totalHours = Math.round((totalMinutes / 60) * 100) / 100;
  const avgPerSession = sessionCount > 0
    ? Math.round(total / sessionCount)
    : 0;

  // ── 3. Chart bars (period-specific) ────────────────────────

  const chart = await getChartBars(db, userId, period, startDate, endDate);

  // ── 4. Transactions for the period (first page) ────────────

  const { rows: txRows } = await db.query(
    `SELECT
    t.id, t.type, t.direction, t.amount,
    t.session_id, t.reference_id, t.status, t.created_at,
    s.started_at AS session_started_at,
   mtp.first_name AS other_first_name,
    mtp.last_name AS other_last_name,
    mtp.profile_photo_url AS other_avatar,
    seg.modes AS session_modes,
    seg.duration_seconds AS session_duration_seconds
  FROM transaction t
  LEFT JOIN session s ON s.id = t.session_id
  LEFT JOIN mentee_profile mtp ON mtp.user_id = s.mentee_id
  LEFT JOIN LATERAL (
       SELECT
         array_agg(DISTINCT ss.type) AS modes,
         COALESCE(SUM(ss.duration_seconds), 0)::int AS duration_seconds
       FROM session_segment ss
       WHERE ss.session_id = t.session_id
     ) seg ON true
   WHERE t.user_id = $1
       AND t.wallet_id = (SELECT id FROM wallet WHERE user_id = $1 AND type = 'mentor')
       AND (t.created_at AT TIME ZONE 'Asia/Kolkata')::date
           BETWEEN $2::date AND $3::date
     ORDER BY t.created_at DESC
     LIMIT 20`,
    [userId, startDate, endDate]
  );

  const { rows: [{ total: txTotal }] } = await db.query(
    `SELECT COUNT(*)::int AS total
     FROM transaction t
     WHERE t.user_id = $1
       AND t.wallet_id = (SELECT id FROM wallet WHERE user_id = $1 AND type = 'mentor')
       AND (t.created_at AT TIME ZONE 'Asia/Kolkata')::date
           BETWEEN $2::date AND $3::date`,
    [userId, startDate, endDate]
  );

  const transactions = txRows.map((row) => ({
    id: row.id,
    type: row.type,
    direction: row.direction,
    amount: parseFloat(row.amount),
    session_id: row.session_id,
    reference_id: row.reference_id,
    status: row.status,
    other_user_name: row.other_first_name
    ? [row.other_first_name, row.other_last_name].filter(Boolean).join(" ")
    : null,
  other_user_avatar: toFullUrl(row.other_avatar),
  session_started_at: row.session_started_at,
    session_modes: row.session_modes || [],
    session_duration_seconds: row.session_duration_seconds || 0,
    created_at: row.created_at,
  }));

  // ── 5. Response ────────────────────────────────────────────

  return respond(200, {
    period,
    period_label: periodLabel,
    total,
    chart,
    stats: {
      session_count: sessionCount,
      total_seconds: totalSeconds,
      total_minutes: totalMinutesRounded,
      total_hours: totalHours,
      avg_per_session: avgPerSession,
    },
    transactions,
    has_more_transactions: txTotal > 20,
  });
}


// ─── Chart Bar Queries ───────────────────────────────────────

async function getChartBars(db, userId, period, startDate, endDate) {
  switch (period) {
    case "weekly":
      return getWeeklyBars(db, userId, startDate, endDate);
    case "monthly":
      return getMonthlyBars(db, userId, startDate, endDate);
    case "daily":
      return getDailyBars(db, userId, startDate);
    default:
      return [];
  }
}

// Weekly: 7 bars (Mon, Tue, Wed, Thu, Fri, Sat, Sun)
async function getWeeklyBars(db, userId, startDate, endDate) {
  const { rows } = await db.query(
    `WITH days AS (
       SELECT d::date AS day
       FROM generate_series($2::date, $3::date, '1 day'::interval) d
     ),
     daily_earnings AS (
       SELECT
         (s.ended_at AT TIME ZONE 'Asia/Kolkata')::date AS day,
         COALESCE(SUM(s.mentor_earning), 0) AS earnings
       FROM session s
       WHERE s.mentor_id = $1
         AND s.status = 'completed'
         AND (s.ended_at AT TIME ZONE 'Asia/Kolkata')::date
             BETWEEN $2::date AND $3::date
       GROUP BY 1
     )
     SELECT
       TO_CHAR(d.day, 'Dy') AS label,
       COALESCE(de.earnings, 0)::numeric AS value
     FROM days d
     LEFT JOIN daily_earnings de ON de.day = d.day
     ORDER BY d.day`,
    [userId, startDate, endDate]
  );

  return rows.map((r) => ({
    label: r.label,
    value: parseFloat(r.value) || 0,
  }));
}

// Monthly: 4–5 week bars (Wk 1, Wk 2, ...)
async function getMonthlyBars(db, userId, startDate, endDate) {
  // Calculate number of weeks in this month
  const start = new Date(startDate);
  const end = new Date(endDate);
  const totalDays = Math.ceil((end - start) / (1000 * 60 * 60 * 24)) + 1;
  const weekCount = Math.ceil(totalDays / 7);

  const { rows } = await db.query(
    `WITH week_buckets AS (
       SELECT generate_series(1, $4::int) AS week_num
     ),
     weekly_earnings AS (
       SELECT
         CEIL(
           EXTRACT(DAY FROM (s.ended_at AT TIME ZONE 'Asia/Kolkata')::date) / 7.0
         )::int AS week_num,
         COALESCE(SUM(s.mentor_earning), 0) AS earnings
       FROM session s
       WHERE s.mentor_id = $1
         AND s.status = 'completed'
         AND (s.ended_at AT TIME ZONE 'Asia/Kolkata')::date
             BETWEEN $2::date AND $3::date
       GROUP BY 1
     )
     SELECT
       'Wk ' || wb.week_num AS label,
       COALESCE(we.earnings, 0)::numeric AS value
     FROM week_buckets wb
     LEFT JOIN weekly_earnings we ON we.week_num = wb.week_num
     ORDER BY wb.week_num`,
    [userId, startDate, endDate, weekCount]
  );

  return rows.map((r) => ({
    label: r.label,
    value: parseFloat(r.value) || 0,
  }));
}

// Daily: 6 bars (4-hour time slots)
async function getDailyBars(db, userId, targetDate) {
  const slots = [
    { start: 0, end: 4, label: "12a" },
    { start: 4, end: 8, label: "4a" },
    { start: 8, end: 12, label: "8a" },
    { start: 12, end: 16, label: "12p" },
    { start: 16, end: 20, label: "4p" },
    { start: 20, end: 24, label: "8p" },
  ];

  const { rows } = await db.query(
    `SELECT
       EXTRACT(HOUR FROM (s.ended_at AT TIME ZONE 'Asia/Kolkata'))::int AS hour,
       COALESCE(SUM(s.mentor_earning), 0) AS earnings
     FROM session s
     WHERE s.mentor_id = $1
       AND s.status = 'completed'
       AND (s.ended_at AT TIME ZONE 'Asia/Kolkata')::date = $2::date
     GROUP BY 1`,
    [userId, targetDate]
  );

  // Map hours to 4-hour slots
  const slotTotals = new Array(6).fill(0);
  for (const row of rows) {
    const slotIndex = Math.floor(row.hour / 4);
    slotTotals[slotIndex] += parseFloat(row.earnings) || 0;
  }

  return slots.map((slot, i) => ({
    label: slot.label,
    value: slotTotals[i],
  }));
}


// ─── Date Range Helper ───────────────────────────────────────

function computeDateRange(period, offset) {
  // Use IST for date calculations (UTC + 5:30)
  const istOffsetMs = 5.5 * 60 * 60 * 1000;
  const istNow = new Date(Date.now() + istOffsetMs);

  const year = istNow.getUTCFullYear();
  const month = istNow.getUTCMonth();
  const date = istNow.getUTCDate();
  const dow = istNow.getUTCDay(); // 0 = Sunday

  const months = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];
  const monthsShort = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];

  const fmt = (d) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

  const fmtShort = (d) => `${d.getDate()} ${monthsShort[d.getMonth()]}`;

  switch (period) {
    case "daily": {
      const d = new Date(year, month, date + offset);
      const dateStr = fmt(d);

      // Friendly label
      let label;
      if (offset === 0) label = "Today";
      else if (offset === -1) label = "Yesterday";
      else label = fmtShort(d);

      return { startDate: dateStr, endDate: dateStr, periodLabel: label };
    }

    case "weekly": {
      // Monday = start of week (ISO standard)
      const mondayDiff = dow === 0 ? -6 : 1 - dow;
      const monday = new Date(year, month, date + mondayDiff + offset * 7);
      const sunday = new Date(
        monday.getFullYear(),
        monday.getMonth(),
        monday.getDate() + 6
      );

      return {
        startDate: fmt(monday),
        endDate: fmt(sunday),
        periodLabel: `${fmtShort(monday)} - ${fmtShort(sunday)}`,
      };
    }

    case "monthly": {
      const firstDay = new Date(year, month + offset, 1);
      const lastDay = new Date(year, month + offset + 1, 0);

      return {
        startDate: fmt(firstDay),
        endDate: fmt(lastDay),
        periodLabel: `${months[firstDay.getMonth()]} ${firstDay.getFullYear()}`,
      };
    }

    default:
      return { startDate: fmt(now), endDate: fmt(now), periodLabel: "Today" };
  }
}
async function getMentees(userId, event) {
  const params = event.queryStringParameters || {};
  const limit = Math.min(parseInt(params.limit) || 20, 50);
  const offset = parseInt(params.offset) || 0;

  const db = await getPool();

  // Get blocked user IDs (bidirectional)
  const { rows: blockRows } = await db.query(
    `SELECT blocked_id FROM block WHERE blocker_id = $1
     UNION
     SELECT blocker_id FROM block WHERE blocked_id = $1`,
    [userId]
  );
  const blockedIds = blockRows.map((r) => r.blocked_id);

  const blockedCondition = blockedIds.length > 0
    ? `AND s.mentee_id != ALL($4::uuid[])`
    : "";
  const blockedCountCondition = blockedIds.length > 0
    ? `AND mentee_id != ALL($2::uuid[])`
    : "";

  const queryParams1 = blockedIds.length > 0
    ? [userId, limit, offset, blockedIds]
    : [userId, limit, offset];
  const countParams = blockedIds.length > 0
    ? [userId, blockedIds]
    : [userId];

  // 1. Get unique mentees with aggregated session info + privacy snapshot
  const { rows } = await db.query(
    `SELECT
       s.mentee_id,
       mp.first_name,
       mp.last_name,
       mp.profile_photo_url,
       COALESCE(mps.mentor_chat_access, FALSE) AS mentor_chat_access,
       COALESCE(mps.block_screenshots, FALSE)  AS block_screenshots,
       COALESCE(mps.block_call_recording, FALSE) AS block_call_recording,
       COUNT(*)::int AS session_count,
       MAX(COALESCE(s.ended_at, s.started_at)) AS last_session_at
     FROM session s
     JOIN "user" u ON u.id = s.mentee_id
     LEFT JOIN mentee_profile mp ON mp.user_id = s.mentee_id
     LEFT JOIN mentee_privacy_settings mps ON mps.user_id = s.mentee_id
     WHERE s.mentor_id = $1
       AND s.status = 'completed'
       ${blockedCondition}
     GROUP BY s.mentee_id, mp.first_name, mp.last_name, mp.profile_photo_url,
              mps.mentor_chat_access, mps.block_screenshots, mps.block_call_recording
     ORDER BY last_session_at DESC
     LIMIT $2 OFFSET $3`,
    queryParams1
  );

  // 2. Total count for pagination
  const { rows: [countRow] } = await db.query(
    `SELECT COUNT(DISTINCT mentee_id)::int AS total
     FROM session
     WHERE mentor_id = $1 AND status = 'completed'
     ${blockedCountCondition}`,
    countParams
  );
  const total = countRow.total;

  // 3. For each mentee, fetch last activity from DynamoDB
  const mentees = await Promise.all(
    rows.map(async (row) => {
      const lastActivity = await getLastActivity(
        row.mentee_id,
        userId,
        db,
        row.mentor_chat_access,
      );

      return {
        mentee_id: row.mentee_id,
        name: [row.first_name, row.last_name].filter(Boolean).join(" "),
        avatar: toFullUrl(row.profile_photo_url),
        session_count: row.session_count,
        last_session_at: row.last_session_at,
        last_activity: lastActivity,
        privacy: {
          block_screenshots: row.block_screenshots,
          block_call_recording: row.block_call_recording,
        },
      };
    })
  );

  return respond(200, {
    mentees,
    total,
    has_more: offset + limit < total,
  });
}


// ─── Helper: Get Last Activity ───────────────────────────────
//
// Finds the most recent session between mentor & mentee,
// fetches the last meaningful message from DynamoDB.
// Skips "X ended the chat" to find actual content for preview.

async function getLastActivity(menteeId, mentorId, db, chatAccess = true) {
  const { rows: sessionRows } = await db.query(
    `SELECT id
     FROM session
     WHERE mentor_id = $1 AND mentee_id = $2 AND status = 'completed'
     ORDER BY COALESCE(ended_at, started_at) DESC
     LIMIT 1`,
    [mentorId, menteeId]
  );

  if (sessionRows.length === 0) {
    return { type: "system", content: "No activity yet" };
  }

  const lastSessionId = sessionRows[0].id;

  try {
    // Grab last 5 messages — walk backwards to skip "ended the chat"
    const result = await dynamoClient.send(new QueryCommand({
      TableName: "mentortalk-messages",
      KeyConditionExpression: "session_id = :sid",
      ExpressionAttributeValues: { ":sid": lastSessionId },
      ScanIndexForward: false, // newest first
      Limit: 5,
    }));

    if (!result.Items || result.Items.length === 0) {
      return { type: "system", content: chatAccess ? "Session ended" : "No activity yet" };
    }

    // When chat access is OFF, surface the latest system message verbatim
    // (including "X ended the chat") — content messages are off-limits.
    if (!chatAccess) {
      for (const msg of result.Items) {
        if ((msg.type || "text") === "system") {
          return { type: "system", content: msg.content || "Session ended" };
        }
      }
      return { type: "system", content: "No activity yet" };
    }

    for (const msg of result.Items) {
      const content = msg.content || "";
      const type = msg.type || "text";

      // Skip "X ended the chat" — not useful as inbox preview
      if (type === "system" && content.toLowerCase().includes("ended the chat")) {
        continue;
      }

      // Call system messages → show as call activity
      if (type === "system") {
        if (content.toLowerCase().includes("video call")) {
          return { type: "video_call", content };
        }
        if (content.toLowerCase().includes("audio call")) {
          return { type: "audio_call", content };
        }
        return { type: "system", content };
      }

      // Regular text — truncate for preview
      const preview = content.length > 80
        ? content.substring(0, 80) + "…"
        : content;

      return { type: "text", content: preview };
    }

    return { type: "system", content: "Session ended" };
  } catch (err) {
    console.error(`Failed to fetch last message for session ${lastSessionId}:`, err.message);
    return { type: "system", content: "Session ended" };
  }
}


// ─── GET /mentor/mentees/:mentee_id/messages ─────────────────
//
// Returns ALL messages across ALL sessions between this mentor
// and the specified mentee, merged into one chronological thread.
//
// System messages already in DynamoDB (preserved as-is):
//   - "Aarav ended the chat"         (type: "system")
//   - "Audio call started"           (type: "system")
//   - "Audio call ended — 3:42"      (type: "system")
//   - "Video call started"           (type: "system")
//   - "Video call ended — 1:12:00"   (type: "system")
//   - "Switched to audio"            (type: "system")
//   - "Switched to video"            (type: "system")
//
// Injected by this endpoint (START only, no END):
//   - "Session started · 18 Feb, 2:30 PM"  (type: "session_boundary")
//
// Thread reads like:
//   [Session started · 18 Feb, 2:30 PM]     ← injected
//   Hey, can you help with physics?          ← text
//   Sure, what topic?                        ← text
//   Audio call started                       ← DynamoDB system
//   Audio call ended — 38 min                ← DynamoDB system
//   Thank you so much!                       ← text
//   Aarav ended the chat                     ← DynamoDB system
//   [Session started · 19 Feb, 4:15 PM]     ← injected
//   Hi again, one more doubt...              ← text
//
// Query params:
//   limit:   max messages per page (default 100, max 200)
//   before:  ISO timestamp cursor — fetch messages older than this
//
// Response:
// {
//   "messages": [ ... ],
//   "has_more": true,
//   "next_before": "2026-02-15T14:30:00.000Z"
// }

async function getMenteeMessages(userId, event) {
  const pathParts = (event.path || "").split("/");
  const menteeId = pathParts[3]; // ["", "mentor", "mentees", "{id}", "messages"]

  if (!menteeId || menteeId === "undefined") {
    return respond(400, { error: "mentee_id is required" });
  }

  const params = event.queryStringParameters || {};
  const limit = Math.min(parseInt(params.limit) || 100, 200);
  const beforeCursor = params.before || null;

  const db = await getPool();

  // Fetch this mentee's privacy settings up front.
  const { rows: privacyRows } = await db.query(
    `SELECT mentor_chat_access, mentor_download_access
       FROM mentee_privacy_settings WHERE user_id = $1`,
    [menteeId]
  );
  const privacy = privacyRows[0] || { mentor_chat_access: false, mentor_download_access: false };

  // 1. Get all completed sessions between this pair
  const { rows: sessionRows } = await db.query(
    `SELECT id, status, started_at, ended_at,
            EXTRACT(EPOCH FROM (ended_at - started_at))::int AS duration_seconds
     FROM session
     WHERE mentor_id = $1 AND mentee_id = $2 AND status IN ('completed', 'active')
     ORDER BY started_at ASC`,
    [userId, menteeId]
  );

  if (sessionRows.length === 0) {
    return respond(200, { messages: [], has_more: false });
  }

  const activeSession = sessionRows.find((s) => s.status === 'active');
  const activeSessionId = activeSession?.id ?? null;

  // If cursor exists, skip sessions entirely after cursor time
  const sessionIds = sessionRows.map((r) => r.id);

  if (sessionIds.length === 0) {
    return respond(200, { messages: [], has_more: false });
  }

  // Session metadata for boundary injection
  const sessionMeta = {};
  for (const s of sessionRows) {
    sessionMeta[s.id] = {
      started_at: s.started_at,
      ended_at: s.ended_at,
      duration_seconds: s.duration_seconds,
    };
  }

  // 2. Query DynamoDB for messages across all sessions (parallel)
  let allMessages = [];

  await Promise.all(
    sessionIds.map(async (sessionId) => {
      try {
        let lastKey = undefined;

        do {
          const queryParams = {
            TableName: "mentortalk-messages",
            KeyConditionExpression: "session_id = :sid",
            ExpressionAttributeValues: { ":sid": sessionId },
            ScanIndexForward: true,
          };

          if (lastKey) queryParams.ExclusiveStartKey = lastKey;

          const result = await dynamoClient.send(new QueryCommand(queryParams));

          for (const item of result.Items || []) {
            const msgType = item.type || "text";
            const isActiveSession = sessionId === activeSessionId;

            // Chat access gate: past-session non-system messages are dropped
            // when the mentee has not granted mentor_chat_access. Active session
            // is always fully visible.
            if (!isActiveSession && !privacy.mentor_chat_access && msgType !== "system") {
              continue;
            }

            const msg = {
              message_id: item.message_id,
              session_id: sessionId,
              sender_id: item.sender_id,
              content: item.content,
              type: msgType,
              created_at: item.created_at,
              client_message_id: item.client_message_id || null,
              system_event: item.system_event || null,
              metadata: item.metadata || null,
            };

            if (item.media_url) {
              // Download access gate: don't presign past-session media when
              // mentor_download_access is OFF.
              const allowDownload = isActiveSession || privacy.mentor_download_access;
              if (allowDownload) {
                msg.media_url = await getSignedUrl(s3Client, new GetObjectCommand({
                  Bucket: BUCKET_NAME,
                  Key: item.media_url,
                }), { expiresIn: 3600 });
              } else {
                msg.media_url = null;
              }
            }
            if (item.media_metadata) {
              try {
                msg.media_metadata = typeof item.media_metadata === 'string'
                  ? JSON.parse(item.media_metadata)
                  : item.media_metadata;
              } catch {
                msg.media_metadata = item.media_metadata;
              }
            }

            allMessages.push(msg);
          }

          lastKey = result.LastEvaluatedKey;
        } while (lastKey);
      } catch (err) {
        console.error(`Failed to query messages for session ${sessionId}:`, err.message);
      }
    })
  );



  // 4. Sort chronologically
  allMessages.sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
  );

  // 5. Apply before cursor
  if (beforeCursor) {
    const cursorTime = new Date(beforeCursor).getTime();
    allMessages = allMessages.filter(
      (m) => new Date(m.created_at).getTime() < cursorTime
    );
  }

  // 6. Paginate — take last N (most recent page first)
  const hasMore = allMessages.length > limit;
  if (hasMore) {
    allMessages = allMessages.slice(allMessages.length - limit);
  }

  // 7. Cursor for loading older messages
  const nextBefore =
    hasMore && allMessages.length > 0 ? allMessages[0].created_at : null;

  return respond(200, {
    messages: allMessages,
    has_more: hasMore,
    next_before: nextBefore,
  });
}


// ─── Helper: Format date in IST ──────────────────────────────

function formatDateIST(dateStr) {
  const d = new Date(dateStr);
  const ist = new Date(d.getTime() + 5.5 * 60 * 60 * 1000);

  const day = ist.getUTCDate();
  const months = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];
  const month = months[ist.getUTCMonth()];

  let hours = ist.getUTCHours();
  const minutes = ist.getUTCMinutes().toString().padStart(2, "0");
  const ampm = hours >= 12 ? "PM" : "AM";
  hours = hours % 12 || 12;

  return `${day} ${month}, ${hours}:${minutes} ${ampm}`;
}
async function profilePhotoPresign(userId, event) {
  const body = JSON.parse(event.body || "{}");
  const { file_name, content_type } = body;

  if (!file_name || !content_type) {
    return respond(400, { error: "file_name and content_type required" });
  }

  const allowedTypes = ["image/jpeg", "image/png", "image/webp"];
  if (!allowedTypes.includes(content_type)) {
    return respond(400, { error: "Only JPEG, PNG, and WebP images allowed" });
  }

  const ext = file_name.split(".").pop().toLowerCase();
  const s3Key = `profile-photos/${userId}/${crypto.randomUUID()}.${ext}`;

  const command = new PutObjectCommand({
    Bucket: BUCKET_NAME,
    Key: s3Key,
    ContentType: content_type,
  });

  const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn: 300 });

  return respond(200, {
    upload_url: uploadUrl,
    s3_key: s3Key,
    expires_in: 300,
  });
}

// ─── GET /mentor/quick-replies ───────────────────────────────

async function getQuickReplies(userId) {
  const db = await getPool();
  const result = await db.query(
    `SELECT id, content, sort_order, created_at, updated_at
     FROM mentor_quick_reply
     WHERE user_id = $1
     ORDER BY sort_order ASC, created_at ASC`,
    [userId]
  );

  return respond(200, { replies: result.rows });
}

// ─── POST /mentor/quick-replies ──────────────────────────────

async function createQuickReply(userId, event) {
  const body = JSON.parse(event.body || "{}");
  const { content } = body;

  if (!content || !content.trim()) {
    return respond(400, { error: "content is required" });
  }

  // Cap at 50 replies per mentor
  const db = await getPool();
  const countResult = await db.query(
    `SELECT COUNT(*)::int AS count FROM mentor_quick_reply WHERE user_id = $1`,
    [userId]
  );
  if (countResult.rows[0].count >= 50) {
    return respond(400, { error: "Maximum 50 quick replies allowed" });
  }

  // Get next sort_order
  const maxOrder = await db.query(
    `SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order
     FROM mentor_quick_reply WHERE user_id = $1`,
    [userId]
  );

  const result = await db.query(
    `INSERT INTO mentor_quick_reply (user_id, content, sort_order)
     VALUES ($1, $2, $3)
     RETURNING id, content, sort_order, created_at, updated_at`,
    [userId, content.trim(), maxOrder.rows[0].next_order]
  );

  return respond(201, result.rows[0]);
}

// ─── PUT /mentor/quick-replies/:id ───────────────────────────

async function updateQuickReply(userId, event) {
  const replyId = (event.path || "").split("/").pop();
  const body = JSON.parse(event.body || "{}");
  const { content, sort_order } = body;

  if (!content && sort_order === undefined) {
    return respond(400, { error: "content or sort_order required" });
  }

  const db = await getPool();

  const updates = [];
  const values = [];
  let idx = 1;

  if (content !== undefined) {
    if (!content.trim()) return respond(400, { error: "content cannot be empty" });
    updates.push(`content = $${idx++}`);
    values.push(content.trim());
  }
  if (sort_order !== undefined) {
    updates.push(`sort_order = $${idx++}`);
    values.push(sort_order);
  }

  updates.push(`updated_at = NOW()`);
  values.push(replyId, userId);

  const result = await db.query(
    `UPDATE mentor_quick_reply
     SET ${updates.join(", ")}
     WHERE id = $${idx++} AND user_id = $${idx}
     RETURNING id, content, sort_order, created_at, updated_at`,
    values
  );

  if (result.rows.length === 0) {
    return respond(404, { error: "Quick reply not found" });
  }

  return respond(200, result.rows[0]);
}

// ─── DELETE /mentor/quick-replies/:id ────────────────────────

async function deleteQuickReply(userId, event) {
  const replyId = (event.path || "").split("/").pop();
  const db = await getPool();

  const result = await db.query(
    `DELETE FROM mentor_quick_reply
     WHERE id = $1 AND user_id = $2
     RETURNING id`,
    [replyId, userId]
  );

  if (result.rows.length === 0) {
    return respond(404, { error: "Quick reply not found" });
  }

  return respond(200, { deleted: true });
}