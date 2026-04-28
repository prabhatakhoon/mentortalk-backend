/**
 * mentortalk-mentee-discover
 *
 * Mentor discovery Lambda — popular mentors, search, filtering & sorting.
 *
 * Routes:
 *   GET  /mentee/discover/popular-mentors  → mentors matching mentee's categories
 *   GET  /mentee/discover/search-mentors   → search/list mentors by name and/or categories
 *   GET  /mentee/discover/categories       → mentee's selected + remaining categories
 *   GET  /mentee/discover/mentor-profile   → full mentor profile detail page
 *   POST /mentee/discover/follow             → toggle follow (add/remove)
 *
 * ────────────────────────────────────────────────────────────────
 * Shared query params (popular-mentors & search-mentors):
 *
 *   sort_by    — rating_desc (default) | sessions_desc | price_asc | price_desc
 *   gender     — all (default) | male | female
 *   categories — comma-separated category IDs (e.g. jee,neet,cuet)
 *                Overrides default behaviour when provided.
 *   limit      — max results (default 10/20, max 50)
 *   offset     — pagination offset (default 0)
 *
 * Additional query params (search-mentors only):
 *   q          — search query (name, ILIKE)
 *
 * NOTE: All discover endpoints enforce is_available = true so only
 *       mentors who have opted-in appear in results.
 *
 * Popularity score = 0.6 × (avg_rating / 5.0) + 0.4 × (sessions / max_sessions)
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

const secretsClient = new SecretsManagerClient({ region: "ap-south-1" });
const s3Client = new S3Client({ region: "ap-south-1" });
const BUCKET_NAME = "mentortalk-storage-prod";

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, BatchGetCommand } from "@aws-sdk/lib-dynamodb";

const dynamoClient = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: "ap-south-1" })
);

let jwtSecret = null;

const getJwtSecret = async () => {
  if (jwtSecret) return jwtSecret;
  const response = await secretsClient.send(
    new GetSecretValueCommand({ SecretId: "mentortalk/jwt-secret" })
  );
  jwtSecret = JSON.parse(response.SecretString).secret;
  return jwtSecret;
};

// ============================================================
// DATABASE CONNECTION (reused across warm Lambda invocations)
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
// SHARED HELPERS
// ============================================================

/**
 * Resolve a profile photo URL:
 *   - http/https → pass through (public link)
 *   - S3 key → generate presigned URL (1 hour)
 *   - null/empty → null
 */
async function resolvePhotoUrl(photoUrl, mentorId) {
  if (!photoUrl) return null;
  if (photoUrl.startsWith("http")) return photoUrl;
  const cdnBase = process.env.CDN_BASE_URL;
  if (cdnBase) return `${cdnBase}/${photoUrl}`;
  return null;
}

/**
 * Format a DB row into the standard mentor response object.
 */
async function formatMentorRow(row) {
  const photoUrl = await resolvePhotoUrl(row.profile_photo_url, row.mentor_id);
  const displayName = [row.first_name, row.last_name]
    .filter(Boolean)
    .join(" ");

  // categories comes as a Postgres text[] — parse into JS array.
  const rawCats = row.categories;
  const categories = Array.isArray(rawCats)
    ? rawCats.filter(Boolean)
    : typeof rawCats === "string"
      ? rawCats.replace(/[{}]/g, "").split(",").filter(Boolean)
      : [];

      return {
        id: row.mentor_id,
        display_name: displayName || row.first_name || "Mentor",
        profile_photo_url: photoUrl,
        categories,
        rating: parseFloat(Number(row.avg_rating).toFixed(1)),
        total_sessions: parseInt(row.total_sessions),
        rate_per_minute: parseInt(row.rate_per_minute),
        is_available: row.is_available ?? false,
        intro_rate_eligible: row.intro_rate_eligible ?? false,
      };
}

// ============================================================
// BLOCK FILTER HELPER
// ============================================================

async function getBlockedIds(db, userId) {
  const { rows } = await db.query(
    `SELECT blocked_id FROM block WHERE blocker_id = $1
     UNION
     SELECT blocker_id FROM block WHERE blocked_id = $1`,
    [userId]
  );
  return rows.map(r => r.blocked_id || r.blocker_id);
}

async function getMenteeIntroEligible(db, userId) {
  const { rows } = await db.query(
    `SELECT
       COALESCE(mps.intro_session_used, TRUE) AS intro_used,
       COALESCE(pc.intro_rate_enabled, FALSE) AS intro_enabled
     FROM (SELECT 1) AS dummy
     LEFT JOIN mentee_promo_status mps ON mps.user_id = $1
     LEFT JOIN promo_config pc ON pc.id = 1`,
    [userId]
  );
  if (rows.length === 0) return false;
  return !rows[0].intro_used && rows[0].intro_enabled;
}

// ============================================================
// BATCH PRESENCE CHECK
// ============================================================



async function batchCheckPresence(mentorIds) {
  if (!mentorIds || mentorIds.length === 0) return {};

  const presenceMap = {};
  // BatchGetItem supports max 100 keys per call
  const chunks = [];
  for (let i = 0; i < mentorIds.length; i += 100) {
    chunks.push(mentorIds.slice(i, i + 100));
  }

  for (const chunk of chunks) {
    try {
      const result = await dynamoClient.send(new BatchGetCommand({
        RequestItems: {
          "mentortalk-presence": {
            Keys: chunk.map(id => ({ user_id: id })),
            ProjectionExpression: "user_id, #s",
            ExpressionAttributeNames: { "#s": "status" },
          },
        },
      }));

      const items = result.Responses?.["mentortalk-presence"] || [];
      for (const item of items) {
        presenceMap[item.user_id] = item.status;
      }
    } catch (e) {
      console.error("[PRESENCE] Batch check failed:", e.message);
    }
  }

  return presenceMap;
}

// ============================================================
// VALID SORT OPTIONS
// ============================================================

const VALID_SORTS = {
  rating_desc: "avg_rating DESC, total_sessions DESC",
  sessions_desc: "total_sessions DESC, avg_rating DESC",
  price_asc: "rate_per_minute ASC, avg_rating DESC",
  price_desc: "rate_per_minute DESC, avg_rating DESC",
};

/**
 * Parse shared filter/sort params used by both endpoints.
 */
function parseFilterParams(queryParams) {
  const sortBy = VALID_SORTS[queryParams.sort_by]
    ? queryParams.sort_by
    : "rating_desc";
  const gender = ["male", "female"].includes(
    (queryParams.gender || "").toLowerCase()
  )
    ? queryParams.gender.toLowerCase()
    : "all";
  const categories = (queryParams.categories || "")
    .split(",")
    .map((c) => c.trim().toLowerCase())
    .filter((c) => c.length > 0);
  const type = ["chat", "audio_call"].includes(queryParams.type)
    ? queryParams.type
    : null;

    const languages = (queryParams.languages || "")
    .split(",")
    .map((l) => l.trim().toLowerCase())
    .filter((l) => l.length > 0);

  return { sortBy, gender, categories, type, languages };
}

// ============================================================
// HANDLERS
// ============================================================

/**
 * GET /mentee/discover/popular-mentors
 *
 * 1. Determine which categories to use (explicit `categories` param, or mentee's onboarding picks)
 * 2. Find available mentors in those categories
 * 3. Apply gender filter + sort
 * 4. Rank by popularity score (rating + session count)
 * 5. Return with presigned photo URLs
 */
async function getPopularMentors(db, userId, queryParams, blockedIds = [], menteeIntroEligible = false) {
  const limit = Math.min(Math.max(parseInt(queryParams.limit || "10"), 1), 50);
  const offset = Math.max(parseInt(queryParams.offset || "0"), 0);
  const { sortBy, gender, categories, type, languages } = parseFilterParams(queryParams);

  let catIds = categories;

  if (catIds.length === 0) {
    const menteeCategories = await db.query(
      `SELECT DISTINCT mentorship_category_id
       FROM user_mentorship
       WHERE user_id = $1 AND role = 'mentee'`,
      [userId]
    );
    catIds = menteeCategories.rows.map((r) => r.mentorship_category_id);
  }

  if (catIds.length === 0) {
    // No categories selected — show all available mentors
    catIds = null;
  }

  const params = [catIds];
  let paramIndex = 2;

  let blockedCondition = "";
  if (blockedIds.length > 0) {
    blockedCondition = `AND um.user_id != ALL($${paramIndex}::uuid[])`;
    params.push(blockedIds);
    paramIndex++;
  }

  let genderCondition = "";
  if (gender !== "all") {
    genderCondition = `AND u.gender = $${paramIndex}`;
    params.push(gender);
    paramIndex++;
  }

  let languageCondition = "";
  if (languages.length > 0) {
    languageCondition = `AND EXISTS (SELECT 1 FROM user_language ul WHERE ul.user_id = mm.mentor_id AND ul.language_code = ANY($${paramIndex}::varchar[]))`;
    params.push(languages);
    paramIndex++;
  }

  params.push(limit);
  const limitIdx = paramIndex++;
  params.push(offset);
  const offsetIdx = paramIndex++;

  const orderClause =
    sortBy === "rating_desc"
      ? "popularity_score DESC, avg_rating DESC"
      : VALID_SORTS[sortBy];

  const result = await db.query(
    `WITH mentee_cats AS (
       SELECT unnest($1::varchar[]) AS cat_id
     ),

 matching_mentors AS (
       SELECT DISTINCT mp2.user_id AS mentor_id
       FROM mentor_profile mp2
       JOIN "user" u ON u.id = mp2.user_id
       WHERE u.role = 'mentor'
         AND u.account_status = 'active'
         AND u.phone_number != '+910000000000'
         ${catIds ? `AND EXISTS (SELECT 1 FROM user_mentorship um WHERE um.user_id = mp2.user_id AND um.role = 'mentor' AND um.mentorship_category_id IN (SELECT cat_id FROM mentee_cats))` : ''}
         ${blockedCondition}
     ),
     mentor_data AS (
       SELECT
         mm.mentor_id,
         mp.first_name,
         mp.last_name,
         mp.profile_photo_url,
         mp.rate_per_minute,
        mp.is_available,
         mp.intro_discount_percent,
         COALESCE(mp.avg_rating, 0)     AS avg_rating,

         COALESCE(mp.total_reviews, 0)  AS total_reviews,

         (SELECT COUNT(*)
          FROM session s
          WHERE s.mentor_id = mm.mentor_id
            AND s.status = 'completed'
         ) AS total_sessions,

         (SELECT ARRAY_AGG(mc.name ORDER BY mc.name)
          FROM user_mentorship um2
          JOIN mentorship_category mc ON mc.id = um2.mentorship_category_id
          WHERE um2.user_id = mm.mentor_id AND um2.role = 'mentor'
         ) AS categories

       FROM matching_mentors mm
       JOIN "user" u ON u.id = mm.mentor_id
       JOIN mentor_profile mp ON mp.user_id = mm.mentor_id
       WHERE mp.is_available = true
         ${type === 'audio_call' ? 'AND mp.pref_audio = true' : ''}
         ${genderCondition}
         ${languageCondition}
     ),


     scored AS (
       SELECT
         *,
         (0.6 * (avg_rating / 5.0))
           + (0.4 * (total_sessions::numeric / GREATEST(MAX(total_sessions) OVER(), 1)))
           AS popularity_score
       FROM mentor_data
     )

     SELECT
       mentor_id,
       first_name,
       last_name,
       profile_photo_url,
       categories,
       avg_rating,
       total_sessions,
       rate_per_minute,
        is_available,
       intro_discount_percent,
       popularity_score,
       COUNT(*) OVER() AS total_count
     FROM scored
     ORDER BY ${orderClause}
     LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
    params
  );

  if (result.rows.length === 0) {
    return res(200, { mentors: [], total: 0 });
  }

  const total = parseInt(result.rows[0].total_count);
  const mentors = await Promise.all(result.rows.map(formatMentorRow));

  for (let i = 0; i < mentors.length; i++) {
    const row = result.rows[i];
    const eligible = menteeIntroEligible && row.intro_discount_percent != null;
    mentors[i].intro_rate_eligible = eligible;
    mentors[i].intro_discount_percent = row.intro_discount_percent;
    mentors[i].intro_rate_per_minute = eligible
      ? parseFloat(row.rate_per_minute) * (1 - row.intro_discount_percent / 100)
      : null;
  }

  // Batch presence check — add is_online to each mentor
  const mentorIds = result.rows.map(r => r.mentor_id);
  console.log("[PRESENCE] Checking IDs:", mentorIds);
  const presenceMap = await batchCheckPresence(mentorIds);
  console.log("[PRESENCE] Map:", JSON.stringify(presenceMap));
  for (const mentor of mentors) {
    mentor.is_online = mentor.is_available && presenceMap[mentor.id] === "online";
    console.log(`[PRESENCE] ${mentor.display_name}: available=${mentor.is_available}, presence=${presenceMap[mentor.id]}, is_online=${mentor.is_online}`);
  }

  return res(200, { mentors, total });
}

/**
 * GET /mentee/discover/search-mentors
 *
 * Flexible mentor query — name search, multi-category filter, gender, sorting.
 *
 * Query params:
 *   q          — optional search term (ILIKE on name)
 *   categories — optional comma-separated category IDs (e.g. 'jee,neet')
 *   sort_by    — rating_desc | sessions_desc | price_asc | price_desc
 *   gender     — all | male | female
 *   limit      — max results (default 20, max 50)
 *   offset     — pagination offset (default 0)
 *
 * At least one of `q` or `categories` must be provided.
 *
 * Usage:
 *   ?q=Aar                                          → name search across all mentors
 *   ?categories=jee                                 → all JEE mentors (paginated)
 *   ?categories=jee,neet                            → JEE + NEET mentors
 *   ?q=Pr&categories=neet                           → search within NEET mentors
 *   ?categories=jee&sort_by=price_asc&gender=female → filtered + sorted
 */
async function searchMentors(db, queryParams, blockedIds = [], menteeIntroEligible = false) {
  const q = (queryParams.q || "").trim();
  const { sortBy, gender, categories, languages } = parseFilterParams(queryParams);
  const limit = Math.min(Math.max(parseInt(queryParams.limit || "20"), 1), 50);
  const offset = Math.max(parseInt(queryParams.offset || "0"), 0);

  // Also support legacy single `category` param
  const legacyCat = (queryParams.category || "").trim().toLowerCase();
  const catIds =
    categories.length > 0 ? categories : legacyCat ? [legacyCat] : [];

  if (q.length === 0 && catIds.length === 0) {
    return res(400, {
      message: "At least one of 'q' or 'categories' is required",
    });
  }

  // Build dynamic query parts
  const conditions = [
    `u.role = 'mentor'`,
    `u.account_status = 'active'`,
    `u.phone_number != '+910000000000'`,
  ];
  const joins = [`JOIN mentor_profile mp ON mp.user_id = u.id`];
  const params = [];
  let paramIndex = 1;

  // Optional name search
  if (q.length > 0) {
    const searchPattern = `%${q}%`;
    params.push(searchPattern);
    conditions.push(`(
      mp.first_name ILIKE $${paramIndex}
      OR mp.last_name ILIKE $${paramIndex}
      OR CONCAT(mp.first_name, ' ', mp.last_name) ILIKE $${paramIndex}
    )`);
    paramIndex++;
  }

  // Optional multi-category filter
  if (catIds.length > 0) {
    params.push(catIds);
    joins.push(
      `JOIN user_mentorship um ON um.user_id = u.id AND um.mentorship_category_id = ANY($${paramIndex}::varchar[])`
    );
    paramIndex++;
  }
// Optional gender filter
if (gender !== "all") {
  params.push(gender);
  conditions.push(`u.gender = $${paramIndex}`);
  paramIndex++;
}

// Optional language filter
if (languages.length > 0) {
  params.push(languages);
  conditions.push(`EXISTS (SELECT 1 FROM user_language ul WHERE ul.user_id = u.id AND ul.language_code = ANY($${paramIndex}::varchar[]))`);
  paramIndex++;
}

// Block filter
  if (blockedIds.length > 0) {
    params.push(blockedIds);
    conditions.push(`u.id != ALL($${paramIndex}::uuid[])`);
    paramIndex++;
  }

  // Pagination params
  params.push(limit);
  const limitIdx = paramIndex++;
  params.push(offset);
  const offsetIdx = paramIndex++;

  // Determine ORDER BY
  const orderClause = VALID_SORTS[sortBy];

  const result = await db.query(
    `SELECT
     u.id AS mentor_id,
       mp.first_name,
       mp.last_name,
       mp.profile_photo_url,
       mp.rate_per_minute,
      mp.is_available,
       mp.intro_discount_percent,
       COALESCE(mp.avg_rating, 0)    AS avg_rating,
       COALESCE(mp.total_reviews, 0) AS total_reviews,

       (SELECT COUNT(*)
        FROM session s
        WHERE s.mentor_id = u.id
          AND s.status = 'completed'
       ) AS total_sessions,

       -- All categories for this mentor
       (SELECT ARRAY_AGG(mc.name ORDER BY mc.name)
        FROM user_mentorship um2
        JOIN mentorship_category mc ON mc.id = um2.mentorship_category_id
        WHERE um2.user_id = u.id AND um2.role = 'mentor'
       ) AS categories,

       COUNT(*) OVER() AS total_count

     FROM "user" u
     ${joins.join("\n     ")}
     WHERE ${conditions.join("\n       AND ")}
    GROUP BY u.id, mp.first_name, mp.last_name,
              mp.profile_photo_url, mp.rate_per_minute, mp.is_available,
             mp.avg_rating, mp.total_reviews, mp.intro_discount_percent
     ORDER BY ${orderClause}
     LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
    params
  );

  if (result.rows.length === 0) {
    return res(200, { mentors: [], total: 0 });
  }

  const total = parseInt(result.rows[0].total_count);
  const mentors = await Promise.all(result.rows.map(formatMentorRow));

  for (let i = 0; i < mentors.length; i++) {
    const row = result.rows[i];
    const eligible = menteeIntroEligible && row.intro_discount_percent != null;
    mentors[i].intro_rate_eligible = eligible;
    mentors[i].intro_discount_percent = row.intro_discount_percent;
    mentors[i].intro_rate_per_minute = eligible
      ? parseFloat(row.rate_per_minute) * (1 - row.intro_discount_percent / 100)
      : null;
  }

  // Batch presence check
  const mentorIds = result.rows.map(r => r.mentor_id);
  const presenceMap = await batchCheckPresence(mentorIds);
  for (const mentor of mentors) {
    mentor.is_online = mentor.is_available && presenceMap[mentor.id] === "online";
  }

  return res(200, { mentors, total });
}

/**
 * GET /mentee/discover/categories
 *
 * Returns the mentee's selected categories first, then remaining categories.
 * Used to build the chip row: Popular | [user cats] | [other cats]
 *
 * Response:
 *   {
 *     selected: [{ id: "jee", name: "JEE" }, ...],
 *     others:   [{ id: "ssc", name: "SSC" }, ...]
 *   }
 */
async function getCategories(db, userId) {
  const allCats = await db.query(
    `SELECT id, name FROM mentorship_category ORDER BY name`
  );

  const menteeCats = await db.query(
    `SELECT DISTINCT mentorship_category_id AS id
     FROM user_mentorship
     WHERE user_id = $1 AND role = 'mentee'`,
    [userId]
  );

  const selectedIds = new Set(menteeCats.rows.map((r) => r.id));

  const selected = [];
  const others = [];

  for (const cat of allCats.rows) {
    const item = { id: cat.id, name: cat.name };
    if (selectedIds.has(cat.id)) {
      selected.push(item);
    } else {
      others.push(item);
    }
  }

  return res(200, { selected, others });
}

// ============================================================
// LANGUAGE CODE → NAME MAP
// ============================================================

const LANGUAGE_MAP = {
  en: "English",
  hi: "Hindi",
  mr: "Marathi",
  bn: "Bengali",
  te: "Telugu",
  ta: "Tamil",
  kn: "Kannada",
  ml: "Malayalam",
  gu: "Gujarati",
  pa: "Punjabi",
  or: "Odia",
  as: "Assamese",
  ur: "Urdu",
  sa: "Sanskrit",
};

// ============================================================
// GET /mentee/discover/mentor-profile?mentor_id=xxx
//
// Returns full mentor profile for the detail page.
// Combines data from: user, mentor_profile, education,
// experience, user_language, user_mentorship, session,
// identity_verification, 
// ============================================================

async function getMentorProfile(db, userId, queryParams, menteeIntroEligible = false) {
  const mentorId = (queryParams.mentor_id || "").trim();

  if (!mentorId) {
    return res(400, { message: "mentor_id is required" });
  }

  // ── 1. Core profile ──
  const coreResult = await db.query(
    `SELECT
       u.id AS mentor_id,
       mp.first_name,
       mp.last_name,
       u.gender,
       mp.profile_photo_url,
       mp.bio,
       mp.rate_per_minute,
       mp.is_available,
       mp.pref_audio,
       mp.pref_video,
       mp.avg_rating,
        mp.total_reviews,
       mp.intro_discount_percent,

       -- Completed sessions count
       (SELECT COUNT(*)
        FROM session s
        WHERE s.mentor_id = u.id
          AND s.status = 'completed'
       ) AS total_sessions,

       -- Verified (aadhaar_verified = true in identity_verification)
       EXISTS(
         SELECT 1 FROM identity_verification iv
         WHERE iv.user_id = u.id AND iv.aadhaar_verified = true
       ) AS is_verified,

       -- Followed by current mentee
       EXISTS(
         SELECT 1 FROM follow f
         WHERE f.mentor_id = u.id AND f.mentee_id = $2
       ) AS is_following

     FROM "user" u
     JOIN mentor_profile mp ON mp.user_id = u.id
     WHERE u.id = $1`,
    [mentorId, userId]
  );

  if (coreResult.rows.length === 0) {
    return res(404, { message: "Mentor not found" });
  }

  const row = coreResult.rows[0];

  // ── 2. Categories ──
  const catResult = await db.query(
    `SELECT mc.name
     FROM user_mentorship um
     JOIN mentorship_category mc ON mc.id = um.mentorship_category_id
     WHERE um.user_id = $1 AND um.role = 'mentor'
     ORDER BY mc.name`,
    [mentorId]
  );
  const categories = catResult.rows.map((r) => r.name);

  // ── 3. Languages ──
  const langResult = await db.query(
    `SELECT language_code FROM user_language WHERE user_id = $1 AND role = 'mentor'`,
    [mentorId]
  );
  const languages = langResult.rows
    .map((r) => LANGUAGE_MAP[r.language_code.trim()] || r.language_code.trim())
    .filter(Boolean);

  // ── 4. Education ──
  const eduResult = await db.query(
    `SELECT institution_name, degree, field_of_study, start_year, end_year, is_verified
     FROM education
     WHERE user_id = $1 AND role = 'mentor'
     ORDER BY start_year DESC NULLS LAST`,
    [mentorId]
  );
  const education = eduResult.rows.map((e) => ({
    institution_name: e.institution_name,
    degree: e.degree,
    field_of_study: e.field_of_study || null,
    start_year: e.start_year,
    end_year: e.end_year,
    is_verified: e.is_verified,
  }));

  // ── 5. Experience ──
  const expResult = await db.query(
    `SELECT title, organization, is_current, start_month, start_year,
            end_month, end_year, description, is_verified
     FROM experience
     WHERE user_id = $1
     ORDER BY start_year DESC, start_month DESC`,
    [mentorId]
  );
  const experience = expResult.rows.map((e) => ({
    title: e.title,
    organization: e.organization,
    is_current: e.is_current,
    start_month: e.start_month,
    start_year: e.start_year,
    end_month: e.end_month || null,
    end_year: e.end_year || null,
    description: e.description || null,
    is_verified: e.is_verified,
  }));

  // ── 6. Resolve photo ──
  const photoUrl = await resolvePhotoUrl(row.profile_photo_url, mentorId);

  // ── 7. Build display name ──
  const displayName = [row.first_name, row.last_name]
    .filter(Boolean)
    .join(" ");

  // ── 8. Calculate experience duration (in years) ──
  let totalExperienceYears = null;
  if (experience.length > 0) {
    const now = new Date();
    let totalMonths = 0;
    for (const exp of experience) {
      const startDate = new Date(exp.start_year, (exp.start_month || 1) - 1);
      const endDate = exp.is_current
        ? now
        : new Date(exp.end_year || now.getFullYear(), (exp.end_month || 12) - 1);
      const months =
        (endDate.getFullYear() - startDate.getFullYear()) * 12 +
        (endDate.getMonth() - startDate.getMonth());
      totalMonths += Math.max(months, 0);
    }
    totalExperienceYears = Math.max(Math.round(totalMonths / 12 * 10) / 10, 0);
  }

    // ── 9. Check real-time presence ──
    let isOnline = false;
    try {
      const presence = await dynamoClient.send(new GetCommand({
        TableName: "mentortalk-presence",
        Key: { user_id: mentorId },
      }));
      isOnline = presence.Item?.status === "online";
    } catch (e) {
      console.error("[PRESENCE] Check failed:", e.message);
    }

  return res(200, {
    id: mentorId,
    display_name: displayName || row.first_name || "Mentor",
    profile_photo_url: photoUrl,
    gender: row.gender || null,
    bio: row.bio || null,
    rate_per_minute: parseInt(row.rate_per_minute) || 0,
    is_available: row.is_available ?? false,
    intro_rate_eligible: menteeIntroEligible && row.intro_discount_percent != null,
    intro_discount_percent: row.intro_discount_percent,
    intro_rate_per_minute: (menteeIntroEligible && row.intro_discount_percent != null)
      ? parseFloat(row.rate_per_minute) * (1 - row.intro_discount_percent / 100)
      : null,
    pref_audio: row.pref_audio ?? true,
    pref_video: row.pref_video ?? true,
    avg_rating: parseFloat(Number(row.avg_rating).toFixed(1)),
    total_reviews: parseInt(row.total_reviews) || 0,
    total_sessions: parseInt(row.total_sessions) || 0,
    is_verified: row.is_verified ?? false,
    is_following: row.is_following ?? false,
    categories,
    languages,
    education,
    experience,
    total_experience_years: totalExperienceYears,
    is_online: row.is_available && isOnline,
  });
}

// ============================================================
// POST /mentee/discover/follow
//
// Toggle follow: if row exists → DELETE, else → INSERT.
// Body: { "mentor_id": "uuid" }
// Response: { "is_following": true/false }
// ============================================================

async function toggleFollow(db, userId, body) {
  const mentorId = (body.mentor_id || "").trim();

  if (!mentorId) {
    return res(400, { message: "mentor_id is required" });
  }

  const existing = await db.query(
    `SELECT 1 FROM follow WHERE mentee_id = $1 AND mentor_id = $2`,
    [userId, mentorId]
  );

  if (existing.rows.length > 0) {
    await db.query(
      `DELETE FROM follow WHERE mentee_id = $1 AND mentor_id = $2`,
      [userId, mentorId]
    );
    return res(200, { is_following: false });
  } else {
    await db.query(
      `INSERT INTO follow (mentee_id, mentor_id) VALUES ($1, $2)`,
      [userId, mentorId]
    );
    return res(200, { is_following: true });
  }
}

// ============================================================
// GET /mentee/discover/following
//
// Returns list of mentors the mentee follows.
// Query: ?limit=20&offset=0
// ============================================================

async function getFollowing(db, userId, queryParams, menteeIntroEligible = false) {
  const limit = Math.min(Math.max(parseInt(queryParams.limit || "20"), 1), 50);
  const offset = Math.max(parseInt(queryParams.offset || "0"), 0);

  const result = await db.query(
    `SELECT
       f.mentor_id,
       mp.first_name,
       mp.last_name,
       mp.profile_photo_url,
       mp.rate_per_minute,
         mp.is_available,
       mp.intro_discount_percent,
       COALESCE(mp.avg_rating, 0) AS avg_rating,
       COALESCE(mp.total_reviews, 0) AS total_reviews,
       (SELECT COUNT(*) FROM session s WHERE s.mentor_id = f.mentor_id AND s.status = 'completed') AS total_sessions,
     (SELECT ARRAY_AGG(mc.name ORDER BY mc.name)
        FROM user_mentorship um
        JOIN mentorship_category mc ON mc.id = um.mentorship_category_id
        WHERE um.user_id = f.mentor_id AND um.role = 'mentor'
       ) AS categories,
       EXISTS(
         SELECT 1 FROM identity_verification iv
         WHERE iv.user_id = f.mentor_id AND iv.aadhaar_verified = true
       ) AS is_verified,
       COUNT(*) OVER() AS total_count
     FROM follow f
     JOIN "user" u ON u.id = f.mentor_id
     JOIN mentor_profile mp ON mp.user_id = f.mentor_id
    WHERE f.mentee_id = $1
       AND u.account_status = 'active'
       AND u.phone_number != '+910000000000'
     ORDER BY f.created_at DESC
     LIMIT $2 OFFSET $3`,
    [userId, limit, offset]
  );

  if (result.rows.length === 0) {
    return res(200, { mentors: [], total: 0 });
  }

  const total = parseInt(result.rows[0].total_count);
  const mentors = await Promise.all(result.rows.map(async (row) => {
    const formatted = await formatMentorRow(row);
    formatted.is_verified = row.is_verified ?? false;
    return formatted;
  }));

  for (let i = 0; i < mentors.length; i++) {
    const row = result.rows[i];
    const eligible = menteeIntroEligible && row.intro_discount_percent != null;
    mentors[i].intro_rate_eligible = eligible;
    mentors[i].intro_discount_percent = row.intro_discount_percent;
    mentors[i].intro_rate_per_minute = eligible
      ? parseFloat(row.rate_per_minute) * (1 - row.intro_discount_percent / 100)
      : null;
  }

 // Batch presence check
 const mentorIds = result.rows.map(r => r.mentor_id);
 const presenceMap = await batchCheckPresence(mentorIds);
 for (const mentor of mentors) {
   mentor.is_online = mentor.is_available && presenceMap[mentor.id] === "online";
 }

 return res(200, { mentors, total });
}
// ============================================================
// GET /mentee/discover/mentor-profile/reviews?mentor_id=xxx&limit=15&offset=0
// ============================================================

async function getMentorReviews(db, queryParams) {
  const mentorId = (queryParams.mentor_id || "").trim();
  if (!mentorId) {
    return res(400, { message: "mentor_id is required" });
  }

  const limit = Math.min(parseInt(queryParams.limit || "15"), 50);
  const offset = parseInt(queryParams.offset || "0");

  const { rows: reviews } = await db.query(
    `SELECT
       r.id,
       r.rating,
       r.comment,
       r.session_id,
       s.started_at AS session_date,
       r.created_at,
       mp.first_name AS mentee_first_name,
       mp.last_name  AS mentee_last_name,
       mp.profile_photo_url AS mentee_photo_url
     FROM review r
     JOIN session s ON s.id = r.session_id
     JOIN mentee_profile mp ON mp.user_id = r.mentee_id
     WHERE r.mentor_id = $1
     ORDER BY r.created_at DESC
     LIMIT $2 OFFSET $3`,
    [mentorId, limit, offset]
  );

  const { rows: [summaryRow] } = await db.query(
    `SELECT
       COUNT(*)::int AS total_reviews,
       COALESCE(AVG(rating), 0) AS avg_rating
     FROM review
     WHERE mentor_id = $1`,
    [mentorId]
  );

  const total = summaryRow.total_reviews;

  const items = await Promise.all(
    reviews.map(async (r) => {
      const avatar = await resolvePhotoUrl(r.mentee_photo_url, r.session_id);
      const name = [r.mentee_first_name, r.mentee_last_name]
        .filter(Boolean)
        .join(" ") || "Mentee";

      return {
        id: r.id,
        rating: parseFloat(r.rating),
        comment: r.comment || null,
        session_id: r.session_id,
        session_date: r.session_date,
        mentee: { name, avatar },
        modes: [],
        created_at: r.created_at,
      };
    })
  );

  return res(200, {
    reviews: items,
    summary: {
      total_reviews: total,
      avg_rating: parseFloat(parseFloat(summaryRow.avg_rating).toFixed(1)),
    },
    pagination: {
      total,
      limit,
      offset,
      has_more: offset + limit < total,
    },
  });
}

// ============================================================
// GET /mentee/discover/banners
// ============================================================

async function getBanners(db) {
  const result = await db.query(
    `SELECT id, image_url, action
     FROM banner
     WHERE is_active = true
       AND (starts_at IS NULL OR starts_at <= NOW())
       AND (ends_at IS NULL OR ends_at > NOW())
     ORDER BY position ASC`
  );

  const banners = await Promise.all(
    result.rows.map(async (row) => ({
      id: row.id,
      image_url: await resolvePhotoUrl(row.image_url, row.id),
      action: row.action,
    }))
  );

  return res(200, { banners });
}

// ============================================================
// ROUTER
// ============================================================

export const handler = async (event) => {
  try {
    const path = event.path || event.rawPath || "";
    const method =
      event.httpMethod || event.requestContext?.http?.method || "";
    const queryParams = event.queryStringParameters || {};

    console.log(`[ROUTER] ${method} ${path}`);

    // All discover endpoints require auth
    const userId = await getUserId(event);
    if (!userId) return res(401, { message: "Unauthorized" });

    const db = await getClient();
      const blockedIds = await getBlockedIds(db, userId);
    const menteeIntroEligible = await getMenteeIntroEligible(db, userId);

    // Banners
    if (method === "GET" && path.endsWith("/banners")) {
      return await getBanners(db);
    }
    // Popular mentors
    if (method === "GET" && path.endsWith("/popular-mentors")) {
  return await getPopularMentors(db, userId, queryParams, blockedIds, menteeIntroEligible);    }

    // Search mentors
    if (method === "GET" && path.endsWith("/search-mentors")) {
           return await searchMentors(db, queryParams, blockedIds, menteeIntroEligible);

    }

    // Mentee's categories (for chip ordering)
    if (method === "GET" && path.endsWith("/categories")) {
      return await getCategories(db, userId);
    }

        // Mentor profile reviews
        if (method === "GET" && path.endsWith("/mentor-profile/reviews")) {
          return await getMentorReviews(db, queryParams);
        }

    // Mentor profile (full detail page)
    if (method === "GET" && path.endsWith("/mentor-profile")) {
      return await getMentorProfile(db, userId, queryParams, menteeIntroEligible);
    }

    // Toggle follow
    if (method === "POST" && path.endsWith("/follow")) {
      const body = typeof event.body === "string"
        ? JSON.parse(event.body)
        : event.body || {};
      return await toggleFollow(db, userId, body);
    }

    // Following list
    if (method === "GET" && path.endsWith("/following")) {
      return await getFollowing(db, userId, queryParams, menteeIntroEligible);
    }
```

---

### 6. API Gateway

Add a new route in API Gateway (or rename existing):
```
    return res(404, { message: "Not found" });
  } catch (error) {
    console.error("[ERROR] Unhandled:", error);
    return res(500, { message: "Internal server error" });
  }
};