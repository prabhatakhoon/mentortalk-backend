/**
 * mentortalk-mentee-profile
 *
 * Mentee profile Lambda — reads, updates, and manages profile photos.
 *
 * Routes:
 *   GET    /mentee/profile                → account page summary
 *   GET    /mentee/profile/edit-profile   → full edit profile data
 *   PUT    /mentee/profile/edit-profile   → save profile edits
 *   POST   /mentee/profile/photo/presign  → presigned S3 upload URL
 *   POST   /mentee/profile/photo/confirm  → confirm upload, save s3_key to DB
 *   DELETE /mentee/profile/photo          → remove photo from S3 + DB
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
import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand, GetCommand } from "@aws-sdk/lib-dynamodb";

const dynamoClient = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: "ap-south-1" })
);
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import jwt from "jsonwebtoken";

const secretsClient = new SecretsManagerClient({ region: "ap-south-1" });
const s3Client = new S3Client({ region: "ap-south-1" });
const BUCKET_NAME = "mentortalk-storage-prod";

let jwtSecret = null;

function resolvePhotoUrl(photoKey) {
  if (!photoKey) return null;
  if (photoKey.startsWith("http")) return photoKey;
  const cdnBase = process.env.CDN_BASE_URL;
  if (cdnBase) return `${cdnBase}/${photoKey}`;
  return null;
}

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

function parseBody(event) {
  try {
    return typeof event.body === "string"
      ? JSON.parse(event.body)
      : event.body || {};
  } catch {
    return {};
  }
}


// ============================================================
// HANDLERS
// ============================================================

/**
 * GET /mentee/profile
 */
async function getProfile(db, userId) {
  const result = await db.query(
    `SELECT
       mp.username,
       w.balance AS wallet_balance,
       mp.profile_photo_url,
       mp.first_name,
       mp.last_name,
       u.phone_number
     FROM mentee_profile mp
     JOIN "user" u ON u.id = mp.user_id
     LEFT JOIN wallet w ON w.user_id = mp.user_id AND w.type = 'mentee'
     WHERE mp.user_id = $1`,
    [userId]
  );
  if (result.rows.length === 0) {
    return res(404, { message: "Profile not found" });
  }

  const profile = result.rows[0];

  const displayName = [profile.first_name, profile.last_name]
    .filter(Boolean)
    .join(" ");

  // Generate presigned GET URL if photo exists
  const photoUrl = resolvePhotoUrl(profile.profile_photo_url);

  return res(200, {
    username: profile.username,
    display_name: displayName || profile.first_name,
    wallet_balance: profile.wallet_balance ?? 0,
    phone_number: profile.phone_number,
    profile_photo_url: photoUrl,
  });
}

/**
 * GET /mentee/profile/edit-profile
 */
async function getEditProfile(db, userId) {
  const [profileResult, mentorshipResult, educationResult] = await Promise.all([
    db.query(
      `SELECT
         mp.username,
         mp.profile_photo_url,
         mp.first_name,
         mp.last_name,
         u.phone_number
       FROM mentee_profile mp
       JOIN "user" u ON u.id = mp.user_id
       WHERE mp.user_id = $1`,
      [userId]
    ),
    db.query(
      `SELECT mentorship_category_id, mentorship_option_id
       FROM user_mentorship
       WHERE user_id = $1 AND role = 'mentee'`,
      [userId]
    ),
    db.query(
      `SELECT id, institution_name, degree, field_of_study, start_year, end_year
       FROM education WHERE user_id = $1 AND role = 'mentee'
       ORDER BY start_year DESC NULLS LAST, created_at DESC`,
      [userId]
    ),
  ]);

  if (profileResult.rows.length === 0) {
    return res(404, { message: "Profile not found" });
  }

  const profile = profileResult.rows[0];

  const categoryIds = new Set();
  const optionIds = [];
  for (const row of mentorshipResult.rows) {
    categoryIds.add(row.mentorship_category_id);
    if (row.mentorship_option_id) {
      optionIds.push(row.mentorship_option_id);
    }
  }

  const displayName = [profile.first_name, profile.last_name]
    .filter(Boolean)
    .join(" ");

  const photoUrl = resolvePhotoUrl(profile.profile_photo_url);

  return res(200, {
    phone_number: profile.phone_number ?? "",
    display_name: displayName || profile.first_name || "",
    username: profile.username ?? "",
    profile_photo_url: photoUrl,
    selected_categories: {
      category_ids: [...categoryIds],
      option_ids: optionIds,
    },
    education: educationResult.rows.map((e) => ({
      id: e.id,
      institution_name: e.institution_name,
      degree: e.degree,
      field_of_study: e.field_of_study,
      start_year: e.start_year,
      end_year: e.end_year,
    })),
  });
}

/**
 * PUT /mentee/profile/edit-profile
 */
async function updateEditProfile(db, userId, body) {
  const { display_name, username } = body;

  if (!display_name || !username) {
    return res(400, { message: "display_name and username are required" });
  }

  // Check username uniqueness
  const usernameCheck = await db.query(
    `SELECT user_id FROM mentee_profile
     WHERE username = $1 AND user_id != $2`,
    [username.trim(), userId]
  );

  if (usernameCheck.rows.length > 0) {
    return res(409, { message: "Username already taken" });
  }

  const nameParts = display_name.trim().split(/\s+/);
  const firstName = nameParts[0] || "";
  const lastName = nameParts.slice(1).join(" ") || null;

  await db.query(
    `UPDATE mentee_profile
     SET first_name = $1,
         last_name = $2,
         username = $3,
         updated_at = NOW()
     WHERE user_id = $4`,
    [firstName, lastName, username.trim(), userId]
  );

  return res(200, { success: true });
}

/**
 * POST /mentee/profile/photo/presign
 */
async function photoPresign(userId, body) {
  const contentType = body.content_type || "image/jpeg";
  const ext = contentType === "image/png" ? "png" : "jpg";
  const s3Key = `profile-photos/${userId}/${crypto.randomUUID()}.${ext}`;

  const command = new PutObjectCommand({
    Bucket: BUCKET_NAME,
    Key: s3Key,
    ContentType: contentType,
  });

  const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn: 300 });

  return res(200, { upload_url: uploadUrl, s3_key: s3Key });
}

/**
 * POST /mentee/profile/photo/confirm
 */
async function photoConfirm(db, userId, body) {
  const { s3_key } = body;

  if (!s3_key) {
    return res(400, { message: "s3_key is required" });
  }

  const old = await db.query(
    `SELECT profile_photo_url FROM mentee_profile WHERE user_id = $1`,
    [userId]
  );
  const oldKey = old.rows[0]?.profile_photo_url;

  await db.query(
    `UPDATE mentee_profile
     SET profile_photo_url = $1, updated_at = NOW()
     WHERE user_id = $2`,
    [s3_key, userId]
  );

  if (oldKey && oldKey !== s3_key) {
    try {
      await s3Client.send(new DeleteObjectCommand({ Bucket: BUCKET_NAME, Key: oldKey }));
    } catch (e) {
      console.warn("[S3] Failed to delete old photo:", e.message);
    }
  }

  return res(200, { message: "Photo confirmed" });
}

/**
 * DELETE /mentee/profile/photo
 */
async function photoDelete(db, userId) {
  const result = await db.query(
    `SELECT profile_photo_url FROM mentee_profile WHERE user_id = $1`,
    [userId]
  );

  if (result.rows.length === 0) {
    return res(404, { message: "Profile not found" });
  }

  const s3Key = result.rows[0].profile_photo_url;

  if (s3Key) {
    try {
      await s3Client.send(
        new DeleteObjectCommand({ Bucket: BUCKET_NAME, Key: s3Key })
      );
    } catch (e) {
      console.error("[S3] Delete error:", e);
    }
  }

  await db.query(
    `UPDATE mentee_profile
     SET profile_photo_url = NULL, updated_at = NOW()
     WHERE user_id = $1`,
    [userId]
  );

  return res(200, { message: "Photo deleted" });
}


// ============================================================
// CHAT INBOX + THREAD
// ============================================================

/**
 * GET /mentee/chats
 *
 * List of mentors this mentee has chatted with.
 * Mirror of mentor Lambda's getMentees, flipped.
 */
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

async function getChats(db, userId, queryParams) {
  const menteeIntroEligible = await getMenteeIntroEligible(db, userId);

  const limit = Math.min(parseInt(queryParams.limit || "20"), 50);
  const offset = parseInt(queryParams.offset || "0");

  // Get blocked user IDs
  const { rows: blockRows } = await db.query(
    `SELECT blocked_id FROM block WHERE blocker_id = $1
     UNION
     SELECT blocker_id FROM block WHERE blocked_id = $1`,
    [userId]
  );
  const blockedIds = blockRows.map((r) => r.blocked_id);

  const blockedCondition = blockedIds.length > 0
    ? `AND s.mentor_id != ALL($4::uuid[])`
    : "";
  const blockedCountCondition = blockedIds.length > 0
    ? `AND mentor_id != ALL($2::uuid[])`
    : "";

  const queryParams1 = blockedIds.length > 0
    ? [userId, limit, offset, blockedIds]
    : [userId, limit, offset];
  const countParams = blockedIds.length > 0
    ? [userId, blockedIds]
    : [userId];

  const { rows } = await db.query(
    `SELECT
       s.mentor_id,
       mp.first_name,
       mp.last_name,
       mp.pref_audio,
       mp.intro_rate_enabled,
       mp.pref_video,
      mp.profile_photo_url,
       mp.rate_per_minute,
       mp.is_available,
       COUNT(*)::int AS session_count,
       MAX(COALESCE(s.ended_at, s.started_at)) AS last_session_at
     FROM session s
     JOIN mentor_profile mp ON mp.user_id = s.mentor_id
     WHERE s.mentee_id = $1
       AND s.status = 'completed'
       ${blockedCondition}
     GROUP BY s.mentor_id, mp.first_name, mp.last_name, mp.profile_photo_url, mp.pref_audio, mp.pref_video, mp.intro_rate_enabled,      
  mp.rate_per_minute, mp.is_available
     ORDER BY last_session_at DESC
     LIMIT $2 OFFSET $3`,
    queryParams1
  );

  const { rows: [countRow] } = await db.query(
    `SELECT COUNT(DISTINCT mentor_id)::int AS total
     FROM session
     WHERE mentee_id = $1 AND status = 'completed'
     ${blockedCountCondition}`,
    countParams
  );

  const total = countRow.total;

  const chats = await Promise.all(
    rows.map(async (row) => {
      const [lastActivity, presenceResult] = await Promise.all([
        getLastActivity(row.mentor_id, userId, db),
        dynamoClient.send(new GetCommand({
          TableName: "mentortalk-presence",
          Key: { user_id: row.mentor_id },
        })),
      ]);

      const avatar = resolvePhotoUrl(row.profile_photo_url);

      return {
        mentor_id: row.mentor_id,
        name: [row.first_name, row.last_name].filter(Boolean).join(" ") || "Mentor",
        avatar,
        session_count: row.session_count,
        last_session_at: row.last_session_at,
        last_activity: lastActivity,
        pref_audio: row.pref_audio ?? true,
        pref_video: row.pref_video ?? true,
        intro_rate_eligible: menteeIntroEligible && (row.intro_rate_enabled ?? true),
        rate_per_minute: parseFloat(row.rate_per_minute) || 0,
        is_available: row.is_available ?? false,
        presence: (row.is_available && presenceResult.Item?.status === "online") ? "online" : (presenceResult.Item?.status ===
"in_session" && row.is_available) ? "in_session" : "offline",
        last_seen: presenceResult.Item?.last_seen || null,
      };
    })
  );

  return res(200, {
    chats,
    total,
    has_more: offset + limit < total,
  });
}

/**
 * GET /mentee/mentors/:mentor_id/messages
 *
 * Merged thread across all sessions with a specific mentor.
 * Mirror of mentor Lambda's getMenteeMessages, flipped.
 */
async function getMentorMessages(db, userId, mentorId, queryParams) {
  const limit = Math.min(parseInt(queryParams.limit || "100"), 200);
  const beforeCursor = queryParams.before || null;

  const { rows: sessionRows } = await db.query(
    `SELECT id, started_at, ended_at
     FROM session
     WHERE mentee_id = $1 AND mentor_id = $2 AND status IN ('completed', 'active')
     ORDER BY started_at ASC`,
    [userId, mentorId]
  );

  if (sessionRows.length === 0) {
    return res(200, { messages: [], has_more: false });
  }

  const sessionIds = sessionRows.map((r) => r.id);

  if (sessionIds.length === 0) {
    return res(200, { messages: [], has_more: false });
  }

  const sessionMeta = {};
  for (const s of sessionRows) {
    sessionMeta[s.id] = { started_at: s.started_at, ended_at: s.ended_at };
  }

  // Query DynamoDB for messages across all sessions
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
            const msg = {
              message_id: item.message_id,
              session_id: sessionId,
              sender_id: item.sender_id,
              content: item.content,
              type: item.type || "text",
              created_at: item.created_at,
              client_message_id: item.client_message_id || null,
            };

            if (item.media_url) {
              msg.media_url = await getSignedUrl(s3Client, new GetObjectCommand({
                Bucket: BUCKET_NAME,
                Key: item.media_url,
              }), { expiresIn: 3600 });
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


  // Sort chronologically
  allMessages.sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
  );

  // Apply before cursor
  if (beforeCursor) {
    const cursorTime = new Date(beforeCursor).getTime();
    allMessages = allMessages.filter(
      (m) => new Date(m.created_at).getTime() < cursorTime
    );
  }

  // Paginate — take last N
  const hasMore = allMessages.length > limit;
  if (hasMore) {
    allMessages = allMessages.slice(allMessages.length - limit);
  }

  const nextBefore =
    hasMore && allMessages.length > 0 ? allMessages[0].created_at : null;

  return res(200, {
    messages: allMessages,
    has_more: hasMore,
    next_before: nextBefore,
  });
}

/**
 * Helper: Get last activity from DynamoDB for a mentor-mentee pair.
 * Skips "ended the chat" messages for a meaningful preview.
 */
async function getLastActivity(mentorId, menteeId, db) {
  const { rows: sessionRows } = await db.query(
    `SELECT id FROM session
     WHERE mentor_id = $1 AND mentee_id = $2 AND status = 'completed'
     ORDER BY COALESCE(ended_at, started_at) DESC
     LIMIT 1`,
    [mentorId, menteeId]
  );

  if (sessionRows.length === 0) {
    return { type: "system", content: "No messages yet" };
  }

  try {
    const result = await dynamoClient.send(new QueryCommand({
      TableName: "mentortalk-messages",
      KeyConditionExpression: "session_id = :sid",
      ExpressionAttributeValues: { ":sid": sessionRows[0].id },
      ScanIndexForward: false,
      Limit: 5,
    }));

    if (!result.Items || result.Items.length === 0) {
      return { type: "system", content: "Session ended" };
    }

    for (const msg of result.Items) {
      const content = msg.content || "";
      const type = msg.type || "text";

      if (type === "system" && content.toLowerCase().includes("ended the chat")) {
        continue;
      }

      if (type === "system") {
        if (content.toLowerCase().includes("video call")) return { type: "video_call", content };
        if (content.toLowerCase().includes("audio call")) return { type: "audio_call", content };
        return { type: "system", content };
      }

      // Media messages — show type label as preview
      if (type === "audio") {
        const meta = msg.media_metadata
          ? (typeof msg.media_metadata === 'string' ? JSON.parse(msg.media_metadata) : msg.media_metadata)
          : {};
        const dur = meta.duration_seconds ? `${Math.ceil(meta.duration_seconds)}s` : '';
        return { type: "audio", content: `🎤 Voice message ${dur}`.trim() };
      }
      if (type === "image") {
        return { type: "image", content: "📷 Photo" };
      }
      if (type === "file") {
        const meta = msg.media_metadata
          ? (typeof msg.media_metadata === 'string' ? JSON.parse(msg.media_metadata) : msg.media_metadata)
          : {};
        return { type: "file", content: `📎 ${meta.file_name || 'File'}` };
      }

      const preview = content.length > 80 ? content.substring(0, 80) + "…" : content;
      return { type: "text", content: preview };
    }

    return { type: "system", content: "Session ended" };
  } catch (err) {
    console.error(`Failed to fetch last message:`, err.message);
    return { type: "system", content: "Session ended" };
  }
}

/**
 * Helper: Format date in IST (e.g., "18 Feb, 2:30 PM")
 */
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
// ============================================================
// REVIEWS
// ============================================================

/**
 * GET /mentee/reviews
 *
 * Paginated list of reviews this mentee has given.
 * Mirrors GET /mentor/reviews but with mentor as participant.
 */
async function getReviews(db, userId, queryParams) {
  const limit = Math.min(parseInt(queryParams.limit || "15"), 50);
  const offset = parseInt(queryParams.offset || "0");

  // Paginated reviews with mentor info
  const { rows: reviews } = await db.query(
    `SELECT
       r.id,
       r.rating,
       r.comment,
       r.session_id,
       s.started_at AS session_date,
       r.created_at,
       mp.first_name AS mentor_first_name,
       mp.last_name  AS mentor_last_name,
       mp.profile_photo_url AS mentor_photo_url
     FROM review r
     JOIN session s ON s.id = r.session_id
     JOIN mentor_profile mp ON mp.user_id = r.mentor_id
     WHERE r.mentee_id = $1
     ORDER BY r.created_at DESC
     LIMIT $2 OFFSET $3`,
    [userId, limit, offset]
  );

  // Summary
  const { rows: [summaryRow] } = await db.query(
    `SELECT
       COUNT(*)::int AS total_reviews,
       COALESCE(AVG(rating), 0) AS avg_rating
     FROM review
     WHERE mentee_id = $1`,
    [userId]
  );

  const total = summaryRow.total_reviews;

  // Presign mentor avatars
  const items = await Promise.all(
    reviews.map(async (r) => {
      const mentorAvatar = resolvePhotoUrl(r.mentor_photo_url);

      const mentorName = [r.mentor_first_name, r.mentor_last_name]
        .filter(Boolean)
        .join(" ") || "Mentor";

      return {
        id: r.id,
        rating: parseFloat(r.rating),
        comment: r.comment || null,
        session_id: r.session_id,
        session_date: r.session_date,
        mentor: {
          name: mentorName,
          avatar: mentorAvatar,
        },
        modes: r.modes || [],
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
// REPORT & BLOCK
// ============================================================

/**
 * POST /mentee/report
 */
async function submitReport(db, userId, body, app) {
  const { reported_id, reason, description } = body;

  if (!reported_id || !reason) {
    return res(400, { message: "reported_id and reason are required" });
  }

  const validReasons = [
    "inappropriate_behavior",
    "spam_scam",
    "unprofessional_conduct",
    "abusive_language",
    "harassment",
    "other",
  ];

  if (!validReasons.includes(reason)) {
    return res(400, { message: `Invalid reason. Must be one of: ${validReasons.join(", ")}` });
  }

  if (reported_id === userId) {
    return res(400, { message: "Cannot report yourself" });
  }

  // Check reported user exists
  const userCheck = await db.query(
    `SELECT id FROM "user" WHERE id = $1`,
    [reported_id]
  );
  if (userCheck.rows.length === 0) {
    return res(404, { message: "Reported user not found" });
  }

  // Check for duplicate pending report
  const existing = await db.query(
    `SELECT id FROM report
     WHERE reporter_id = $1 AND reported_id = $2 AND status = 'pending'`,
    [userId, reported_id]
  );
  if (existing.rows.length > 0) {
    return res(409, { message: "You already have a pending report for this user" });
  }

  await db.query(
    `INSERT INTO report (reporter_id, reported_id, reason, description, app)
     VALUES ($1, $2, $3, $4, $5)`,
    [userId, reported_id, reason, description || null, app]
  );

  return res(200, { message: "Report submitted" });
}

/**
 * POST /mentee/block
 */
async function blockUser(db, userId, body) {
  const { blocked_id } = body;

  if (!blocked_id) {
    return res(400, { message: "blocked_id is required" });
  }

  if (blocked_id === userId) {
    return res(400, { message: "Cannot block yourself" });
  }

  // Check user exists
  const userCheck = await db.query(
    `SELECT id FROM "user" WHERE id = $1`,
    [blocked_id]
  );
  if (userCheck.rows.length === 0) {
    return res(404, { message: "User not found" });
  }

  // Upsert (ignore if already blocked)
  await db.query(
    `INSERT INTO block (blocker_id, blocked_id)
     VALUES ($1, $2)
     ON CONFLICT (blocker_id, blocked_id) DO NOTHING`,
    [userId, blocked_id]
  );

  return res(200, { message: "User blocked" });
}

/**
 * DELETE /mentee/block/:userId
 */
async function unblockUser(db, userId, blockedId) {
  await db.query(
    `DELETE FROM block WHERE blocker_id = $1 AND blocked_id = $2`,
    [userId, blockedId]
  );

  return res(200, { message: "User unblocked" });
}

/**
 * GET /mentee/block
 */
async function getBlockedUsers(db, userId) {
  const { rows } = await db.query(
    `SELECT
       b.blocked_id,
       b.created_at AS blocked_at,
       COALESCE(
         CONCAT(mp.first_name, ' ', mp.last_name),
         CONCAT(menp.first_name, ' ', menp.last_name)
       ) AS display_name,
       COALESCE(mp.profile_photo_url, menp.profile_photo_url) AS photo_url
     FROM block b
     LEFT JOIN mentor_profile mp ON mp.user_id = b.blocked_id
     LEFT JOIN mentee_profile menp ON menp.user_id = b.blocked_id
     WHERE b.blocker_id = $1
     ORDER BY b.created_at DESC`,
    [userId]
  );

  return res(200, {
    blocked_users: rows.map((r) => ({
      user_id: r.blocked_id,
      display_name: r.display_name?.trim() || null,
      photo_url: resolvePhotoUrl(r.photo_url) || null,
      blocked_at: r.blocked_at,
    })),
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

    // All profile endpoints require auth
    const userId = await getUserId(event);
    if (!userId) return res(401, { message: "Unauthorized" });

    const db = await getClient();

    // Photo routes (most specific first)
    if (method === "POST" && path.endsWith("/photo/presign")) {
      const body = parseBody(event);
      return await photoPresign(userId, body);
    }

    if (method === "POST" && path.endsWith("/photo/confirm")) {
      const body = parseBody(event);
      return await photoConfirm(db, userId, body);
    }

    if (method === "DELETE" && path.endsWith("/photo")) {
      return await photoDelete(db, userId);
    }

    // Edit profile routes
    if (method === "GET" && path.endsWith("/edit-profile")) {
      return await getEditProfile(db, userId);
    }

    if (method === "PUT" && path.endsWith("/edit-profile")) {
      const body = parseBody(event);
      return await updateEditProfile(db, userId, body);
    }

    // Account page profile
  // Chat inbox
  if (method === "GET" && path.endsWith("/chats")) {
    const queryParams = event.queryStringParameters || {};
    return await getChats(db, userId, queryParams);
  }

  // Mentor message thread
  if (method === "GET" && path.match(/\/mentee\/mentors\/[^/]+\/messages/)) {
    const pathParts = (event.path || "").split("/");
    const mentorId = pathParts[3]; // ["", "mentee", "mentors", "{id}", "messages"]
    if (!mentorId || mentorId === "undefined") {
      return res(400, { message: "mentor_id is required" });
    }
    const queryParams = event.queryStringParameters || {};
    return await getMentorMessages(db, userId, mentorId, queryParams);
  }

    // Reviews
    if (method === "GET" && path.endsWith("/reviews")) {
      const queryParams = event.queryStringParameters || {};
      return await getReviews(db, userId, queryParams);
    }

 // Report
 if (method === "POST" && path.endsWith("/report")) {
  const body = parseBody(event);
  return await submitReport(db, userId, body, 'mentee');
}

// Block
if (method === "POST" && path.endsWith("/block")) {
  const body = parseBody(event);
  return await blockUser(db, userId, body);
}

// Unblock
if (method === "DELETE" && path.match(/\/mentee\/block\/[^/]+$/)) {
  const pathParts = path.split("/");
  const blockedId = pathParts[pathParts.length - 1];
  return await unblockUser(db, userId, blockedId);
}

// Blocked users list
if (method === "GET" && path.endsWith("/block")) {
  return await getBlockedUsers(db, userId);
}

// Account page profile
if (method === "GET" && path.endsWith("/profile")) {
  return await getProfile(db, userId);
}

// Following list
if (method === "GET" && path.endsWith("/following")) {
  return await getFollowing(db, userId, queryParams);
}

return res(404, { message: "Not found" });
  } catch (error) {
    console.error("[ERROR] Unhandled:", error);
    return res(500, { message: "Internal server error" });
  }
};