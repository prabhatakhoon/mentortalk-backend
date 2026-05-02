import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";
import {
  S3Client,
  DeleteObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
} from "@aws-sdk/client-apigatewaymanagementapi";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import pg from "pg";
import { sendFcmNotification } from "./fcmHelper.js";

const { Pool } = pg;
const secretsClient = new SecretsManagerClient({ region: "ap-south-1" });
const s3Client = new S3Client({ region: "ap-south-1" });
const dynamoClient = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: "ap-south-1" }),
);
const BUCKET_NAME = "mentortalk-storage-prod";
const WS_ENDPOINT = process.env.WS_ENDPOINT;

let pool = null;
let apiKeyConfig = null;

// ============================================================
// Infrastructure
// ============================================================

const getDbCredentials = async () => {
  const response = await secretsClient.send(
    new GetSecretValueCommand({ SecretId: "mentortalk/db-app-credentials" }),
  );
  return JSON.parse(response.SecretString);
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

const getApiKeyConfig = async () => {
  if (apiKeyConfig) return apiKeyConfig;
  const response = await secretsClient.send(
    new GetSecretValueCommand({ SecretId: "mentortalk/api-keys" }),
  );
  apiKeyConfig = JSON.parse(response.SecretString);
  return apiKeyConfig;
};

const validateAdminKey = async (event) => {
  const apiKey = event.headers?.["x-api-key"] || event.headers?.["X-Api-Key"];
  if (!apiKey) return false;
  const config = await getApiKeyConfig();
  const keyInfo = config[apiKey];
  return keyInfo && keyInfo.app === "admin";
};

// ============================================================
// FCM Push Notification
// ============================================================

// Google OAuth2 access token for FCM v1 API
const getAccessToken = async (creds) => {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", typ: "JWT" }),
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      iss: creds.client_email,
      scope: "https://www.googleapis.com/auth/firebase.messaging",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    }),
  ).toString("base64url");

  // Sign with private key
  const crypto = await import("crypto");
  const sign = crypto.createSign("RSA-SHA256");
  sign.update(`${header}.${payload}`);
  const signature = sign.sign(creds.private_key, "base64url");

  const jwt = `${header}.${payload}.${signature}`;

  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });

  const tokenData = await tokenResponse.json();
  return tokenData.access_token;
};

// ============================================================
// WebSocket Push Helper
// ============================================================

async function pushToUser(userId, payload, fcmOptions = null) {
  const conn = await dynamoClient.send(
    new GetCommand({
      TableName: "mentortalk-connections",
      Key: { user_id: userId },
    }),
  );

  if (conn.Item) {
    const apiClient = new ApiGatewayManagementApiClient({
      endpoint: WS_ENDPOINT,
    });
    try {
      await apiClient.send(
        new PostToConnectionCommand({
          ConnectionId: conn.Item.connection_id,
          Data: Buffer.from(JSON.stringify(payload)),
        }),
      );
      console.log(`Pushed to user ${userId} via WebSocket`);
    } catch (err) {
      console.error(`Failed to push to user ${userId}:`, err.message);
    }
  }

  if (fcmOptions) {
    await sendFcmNotification(userId, fcmOptions);
  }
}

// ============================================================
// Handlers
// ============================================================

const handlers = {
  // ──────────────────────────────────────────────────────────
  // POST /admin/applications/:id/review
  // ──────────────────────────────────────────────────────────
  reviewApplication: async (applicationId, body) => {
    const {
      action,
      comments,
      pending_fixes,
      reviewer_id,
      cooldown_days,
      rate_per_minute,
    } = body;
    const db = await getPool();

    // Validate action
    const validActions = ["approve", "reject", "request_changes"];
    if (!validActions.includes(action)) {
      return {
        statusCode: 400,
        body: {
          error: "Invalid action. Must be: approve, reject, or request_changes",
        },
      };
    }

    if (!reviewer_id) {
      return { statusCode: 400, body: { error: "reviewer_id is required" } };
    }

    if (action === "approve" && !rate_per_minute) {
      return {
        statusCode: 400,
        body: { error: "rate_per_minute is required when approving" },
      };
    }

    if (rate_per_minute && (isNaN(rate_per_minute) || rate_per_minute <= 0)) {
      return {
        statusCode: 400,
        body: { error: "rate_per_minute must be a positive number" },
      };
    }

    // Verify reviewer exists and is admin
    const reviewer = await db.query(
      `SELECT id FROM "user" WHERE id = $1 AND is_admin = true`,
      [reviewer_id],
    );
    if (reviewer.rows.length === 0) {
      return { statusCode: 403, body: { error: "Reviewer is not an admin" } };
    }

    // Get application
    const app = await db.query(
      `SELECT * FROM mentorship_application WHERE id = $1`,
      [applicationId],
    );

    if (app.rows.length === 0) {
      return { statusCode: 404, body: { error: "Application not found" } };
    }

    const appData = app.rows[0];

    const allowedStatuses = ["under_review", "action_required"];

    // Admin can approve rejected applications (override)
    if (action === "approve") {
      allowedStatuses.push("rejected");
    }

    if (!allowedStatuses.includes(appData.submission_status)) {
      return {
        statusCode: 400,
        body: {
          error: `Cannot ${action} application in '${appData.submission_status}' status`,
        },
      };
    }

    const reviewerId = reviewer_id;

    let notificationTitle = "";
    let notificationBody = "";

    // Execute action
    if (action === "approve") {
      await db.query(
        `UPDATE mentorship_application
         SET submission_status = 'approved',
             pending_fixes = '{}',
             updated_at = NOW()
         WHERE id = $1`,
        [applicationId],
      );

      // Delete Aadhaar PDF from S3 (UIDAI compliance)
      await deleteAadhaarPdf(appData.user_id);

      // Mark aadhaar as verified
      await db.query(
        `UPDATE identity_verification
         SET aadhaar_verified = true, aadhaar_pdf_url = NULL, updated_at = NOW()
         WHERE user_id = $1`,
        [appData.user_id],
      );

      await db.query(
        `UPDATE education SET is_verified = true, updated_at = NOW() WHERE user_id = $1 AND role = 'mentor'`,
        [appData.user_id],
      );

      // Set pay rate on mentor profile (create if doesn't exist)
      if (rate_per_minute) {
        await db.query(
          `INSERT INTO mentor_profile (user_id, rate_per_minute)
          VALUES ($1, $2)
          ON CONFLICT (user_id)
          DO UPDATE SET rate_per_minute = $2, updated_at = NOW()`,
          [appData.user_id, rate_per_minute],
        );
      }

      // Create mentor wallet (zero balance)
      await db.query(
        `INSERT INTO wallet (id, user_id, type, balance)
         VALUES (gen_random_uuid(), $1, 'mentor', 0)
         ON CONFLICT (user_id, type) DO NOTHING`,
        [appData.user_id],
      );

      // Seed default quick replies for new mentor
      await db.query(
        `INSERT INTO mentor_quick_reply (user_id, content, sort_order) VALUES
          ($1, 'Let me explain this step by step, follow along', 0),
          ($1, 'Can you share a screenshot of the question?', 1),
          ($1, 'Well done! Do you have any other doubts?', 2),
          ($1, 'We''re running low on time, recharge to continue or let me know your last doubt!', 3)`,
        [appData.user_id],
      );

      notificationTitle = "Application Approved!";
      notificationBody =
        "Congratulations! Your mentor application has been approved. Welcome aboard!";
    } else if (action === "reject") {
      const cooldown = cooldown_days || 30;
      const cooldownUntil = new Date();
      cooldownUntil.setDate(cooldownUntil.getDate() + cooldown);

      await db.query(
        `UPDATE mentorship_application
         SET submission_status = 'rejected',
             attempt_number = attempt_number + 1,
             cooldown_until = $2,
             pending_fixes = '{}',
             updated_at = NOW()
         WHERE id = $1`,
        [applicationId, cooldownUntil.toISOString()],
      );

      notificationTitle = "Application Update";
      notificationBody =
        "Your mentor application needs attention. Please check the app for details.";
    } else if (action === "request_changes") {
      if (!pending_fixes || pending_fixes.length === 0) {
        return {
          statusCode: 400,
          body: { error: "pending_fixes required for request_changes" },
        };
      }

      const validSubsteps = [
        "personal_details",
        "aadhaar",
        "selfie",
        "categories",
        "education",
        "experience",
        "notes",
      ];
      const invalid = pending_fixes.filter((s) => !validSubsteps.includes(s));
      if (invalid.length > 0) {
        return {
          statusCode: 400,
          body: { error: `Invalid substeps: ${invalid.join(", ")}` },
        };
      }

      await db.query(
        `UPDATE mentorship_application
         SET submission_status = 'action_required',
             pending_fixes = $2,
             updated_at = NOW()
         WHERE id = $1`,
        [applicationId, pending_fixes],
      );

      notificationTitle = "Action Required";
      notificationBody = `Please update the following: ${pending_fixes.join(", ")}. Check the app for admin comments.`;
    }

    // Insert review history
    await db.query(
      `INSERT INTO review_history (application_id, reviewer_id, action, comments)
       VALUES ($1, $2, $3::review_action, $4)`,
      [
        applicationId,
        reviewerId,
        action,
        comments ? JSON.stringify(comments) : null,
      ],
    );

    // Send push notification
    await sendFcmNotification(appData.user_id, {
      title: notificationTitle,
      body: notificationBody,
      data: { type: "onboarding_update" },
    });

    return {
      statusCode: 200,
      body: {
        message: `Application ${action}${action === "approve" ? "d" : action === "reject" ? "ed" : "d"}`,
        action,
        application_id: applicationId,
      },
    };
  },

  // ──────────────────────────────────────────────────────────
  // POST /admin/applications/:id/verify-aadhaar
  // ──────────────────────────────────────────────────────────
  verifyAadhaar: async (applicationId) => {
    const db = await getPool();

    const app = await db.query(
      `SELECT user_id FROM mentorship_application WHERE id = $1`,
      [applicationId],
    );

    if (app.rows.length === 0) {
      return { statusCode: 404, body: { error: "Application not found" } };
    }

    const userId = app.rows[0].user_id;

    // Delete from S3
    await deleteAadhaarPdf(userId);

    // Update DB
    await db.query(
      `UPDATE identity_verification
       SET aadhaar_verified = true, aadhaar_pdf_url = NULL, updated_at = NOW()
       WHERE user_id = $1`,
      [userId],
    );

    return {
      statusCode: 200,
      body: { message: "Aadhaar verified and PDF deleted" },
    };
  },

  // ──────────────────────────────────────────────────────────
  // GET /admin/applications/:id/files
  // ──────────────────────────────────────────────────────────
  getFiles: async (applicationId) => {
    const db = await getPool();

    const app = await db.query(
      `SELECT user_id FROM mentorship_application WHERE id = $1`,
      [applicationId],
    );
    if (app.rows.length === 0) {
      return { statusCode: 404, body: { error: "Application not found" } };
    }

    const userId = app.rows[0].user_id;

    const identity = await db.query(
      `SELECT aadhaar_pdf_url, selfie_url, aadhaar_verified
       FROM identity_verification WHERE user_id = $1`,
      [userId],
    );

    const education = await db.query(
      `SELECT id, institution_name, degree, document_url
       FROM education WHERE user_id = $1 AND role = 'mentor' AND document_url IS NOT NULL`,
      [userId],
    );

    const identityData = identity.rows[0] || {};
    const files = {};

    // Presign aadhaar PDF
    if (identityData.aadhaar_pdf_url) {
      const command = new GetObjectCommand({
        Bucket: BUCKET_NAME,
        Key: identityData.aadhaar_pdf_url,
      });
      files.aadhaar_url = await getSignedUrl(s3Client, command, {
        expiresIn: 3600,
      });
    }

    // Presign selfie
    if (identityData.selfie_url) {
      const command = new GetObjectCommand({
        Bucket: BUCKET_NAME,
        Key: identityData.selfie_url,
      });
      files.selfie_url = await getSignedUrl(s3Client, command, {
        expiresIn: 3600,
      });
    }

    // Presign education documents
    files.education_docs = [];
    for (const edu of education.rows) {
      const command = new GetObjectCommand({
        Bucket: BUCKET_NAME,
        Key: edu.document_url,
      });
      files.education_docs.push({
        id: edu.id,
        institution: edu.institution_name,
        degree: edu.degree,
        url: await getSignedUrl(s3Client, command, { expiresIn: 3600 }),
      });
    }

    files.aadhaar_verified = identityData.aadhaar_verified || false;

    return { statusCode: 200, body: files };
  },

  // ──────────────────────────────────────────────────────────
  // POST /admin/notifications/send
  // ──────────────────────────────────────────────────────────
  sendNotification: async (body) => {
    const { user_id, title, message } = body;

    if (!user_id || !title || !message) {
      return {
        statusCode: 400,
        body: { error: "user_id, title, and message are required" },
      };
    }

    const sent = await sendFcmNotification(user_id, {
      title,
      body: message,
      data: { type: "onboarding_update" },
    });

    return {
      statusCode: sent ? 200 : 500,
      body: {
        message: sent ? "Notification sent" : "Failed to send notification",
      },
    };
  },

  // ──────────────────────────────────────────────────────────
  // GET /admin/users?q=search
  // ──────────────────────────────────────────────────────────
  searchUsers: async (queryParams) => {
    const db = await getPool();
    const q = (queryParams.q || "").trim();
    const limit = Math.min(parseInt(queryParams.limit || "20"), 50);
    const offset = parseInt(queryParams.offset || "0");

    if (!q) {
      return {
        statusCode: 400,
        body: { error: "Search query 'q' is required" },
      };
    }

    // Search by UUID, phone, or name across both profiles
    const isUuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(q);
    const isPhone = /^\+?\d{10,15}$/.test(q.replace(/\s/g, ""));

    let whereClause;
    let params;

    if (isUuid) {
      whereClause = `u.id = $1`;
      params = [q, limit, offset];
    } else if (isPhone) {
      whereClause = `u.phone_number LIKE '%' || $1 || '%'`;
      params = [q.replace(/\s/g, ""), limit, offset];
    } else {
      whereClause = `(
        CONCAT(mp.first_name, ' ', mp.last_name) ILIKE '%' || $1 || '%'
        OR CONCAT(menp.first_name, ' ', menp.last_name) ILIKE '%' || $1 || '%'
        OR menp.username ILIKE '%' || $1 || '%'
      )`;
      params = [q, limit, offset];
    }

    const result = await db.query(
      `SELECT
         u.id,
         u.phone_number,
         u.role,
         u.account_status,
         u.banned_at,
         u.ban_reason,
         u.created_at,
         COALESCE(
           NULLIF(TRIM(CONCAT(mp.first_name, ' ', mp.last_name)), ''),
           NULLIF(TRIM(CONCAT(menp.first_name, ' ', menp.last_name)), '')
         ) AS display_name,
         menp.username,
         COALESCE(mp.profile_photo_url, menp.profile_photo_url) AS photo_url
       FROM "user" u
       LEFT JOIN mentor_profile mp ON mp.user_id = u.id
       LEFT JOIN mentee_profile menp ON menp.user_id = u.id
       WHERE ${whereClause}
       ORDER BY u.created_at DESC
       LIMIT $2 OFFSET $3`,
      params,
    );

    return {
      statusCode: 200,
      body: {
        users: result.rows.map((r) => ({
          id: r.id,
          phone_number: r.phone_number,
          role: r.role,
          account_status: r.account_status,
          display_name: r.display_name?.trim() || null,
          username: r.username || null,
          photo_url: r.photo_url || null,
          banned_at: r.banned_at || null,
          ban_reason: r.ban_reason || null,
          created_at: r.created_at,
        })),
        total: result.rows.length,
      },
    };
  },

  // ──────────────────────────────────────────────────────────
  // GET /admin/users/:id
  // ──────────────────────────────────────────────────────────
  getUser: async (userId) => {
    const db = await getPool();

    const [userResult, sessionResult, walletResult, reportResult] =
      await Promise.all([
        db.query(
          `SELECT
           u.id,
           u.phone_number,
           u.role,
           u.account_status,
           u.banned_at,
           u.ban_reason,
           u.created_at,
           COALESCE(
             NULLIF(TRIM(CONCAT(mp.first_name, ' ', mp.last_name)), ''),
             NULLIF(TRIM(CONCAT(menp.first_name, ' ', menp.last_name)), '')
           ) AS display_name,
           menp.username,
           COALESCE(mp.profile_photo_url, menp.profile_photo_url) AS photo_url,
           mp.rate_per_minute,
           mp.is_available,
           mp.avg_rating,
           mp.total_reviews
         FROM "user" u
         LEFT JOIN mentor_profile mp ON mp.user_id = u.id
         LEFT JOIN mentee_profile menp ON menp.user_id = u.id
         WHERE u.id = $1`,
          [userId],
        ),
        db.query(
          `SELECT
           COUNT(*)::int AS total_sessions,
           COUNT(*) FILTER (WHERE status = 'completed')::int AS completed_sessions,
           COALESCE(SUM(total_amount) FILTER (WHERE status = 'completed'), 0) AS total_amount
         FROM session
         WHERE mentor_id = $1 OR mentee_id = $1`,
          [userId],
        ),
        db.query(`SELECT type, balance FROM wallet WHERE user_id = $1`, [
          userId,
        ]),
        db.query(
          `SELECT COUNT(*)::int AS reports_received
         FROM report WHERE reported_id = $1`,
          [userId],
        ),
      ]);

    if (userResult.rows.length === 0) {
      return { statusCode: 404, body: { error: "User not found" } };
    }

    const user = userResult.rows[0];
    const sessions = sessionResult.rows[0];
    const wallets = {};
    for (const w of walletResult.rows) {
      wallets[w.type] = parseFloat(w.balance);
    }

    return {
      statusCode: 200,
      body: {
        id: user.id,
        phone_number: user.phone_number,
        role: user.role,
        account_status: user.account_status,
        display_name: user.display_name?.trim() || null,
        username: user.username || null,
        photo_url: user.photo_url || null,
        banned_at: user.banned_at || null,
        ban_reason: user.ban_reason || null,
        created_at: user.created_at,
        rate_per_minute: user.rate_per_minute
          ? parseFloat(user.rate_per_minute)
          : null,
        is_available: user.is_available || null,
        avg_rating: user.avg_rating ? parseFloat(user.avg_rating) : null,
        total_reviews: user.total_reviews || 0,
        sessions: {
          total: sessions.total_sessions,
          completed: sessions.completed_sessions,
          total_amount: parseFloat(sessions.total_amount),
        },
        wallets,
        reports_received: reportResult.rows[0].reports_received,
      },
    };
  },

  // ──────────────────────────────────────────────────────────
  // POST /admin/users/:id/ban
  // ──────────────────────────────────────────────────────────
  banUser: async (userId, body) => {
    const { reason, reviewer_id } = body;
    const db = await getPool();

    if (!reason) {
      return { statusCode: 400, body: { error: "reason is required" } };
    }

    const user = await db.query(
      `SELECT id, account_status FROM "user" WHERE id = $1`,
      [userId],
    );

    if (user.rows.length === 0) {
      return { statusCode: 404, body: { error: "User not found" } };
    }

    if (user.rows[0].account_status === "banned") {
      return { statusCode: 400, body: { error: "User is already banned" } };
    }

    // Ban + increment token_version to invalidate all existing JWTs
    await db.query(
      `UPDATE "user"
       SET account_status = 'banned',
           banned_at = NOW(),
           ban_reason = $2,
           token_version = token_version + 1,
           updated_at = NOW()
       WHERE id = $1`,
      [userId, reason],
    );

    // Terminate any active session
    const activeSession = await db.query(
      `SELECT id FROM session
       WHERE (mentor_id = $1 OR mentee_id = $1) AND status = 'active'
       LIMIT 1`,
      [userId],
    );

    if (activeSession.rows.length > 0) {
      await db.query(
        `UPDATE session
         SET status = 'completed', ended_at = NOW()
         WHERE id = $1`,
        [activeSession.rows[0].id],
      );
    }

    // Send push notification
    await sendFcmNotification(userId, {
      title: "Account Suspended",
      body: "Your account has been suspended. Contact support for details.",
      data: { type: "account_banned" },
    });

    // Audit log
    await db.query(
      `INSERT INTO admin_action_log (admin_id, target_user_id, action, reason)
     VALUES ($1, $2, 'ban', $3)`,
      [reviewer_id, userId, reason],
    );

    return {
      statusCode: 200,
      body: { message: "User banned", user_id: userId },
    };
  },

  // ──────────────────────────────────────────────────────────
  // POST /admin/users/:id/unban
  // ──────────────────────────────────────────────────────────
  unbanUser: async (userId, body) => {
    const db = await getPool();

    const user = await db.query(
      `SELECT id, account_status FROM "user" WHERE id = $1`,
      [userId],
    );

    if (user.rows.length === 0) {
      return { statusCode: 404, body: { error: "User not found" } };
    }

    if (user.rows[0].account_status !== "banned") {
      return { statusCode: 400, body: { error: "User is not banned" } };
    }

    await db.query(
      `UPDATE "user"
       SET account_status = 'active',
           banned_at = NULL,
           ban_reason = NULL,
           token_version = token_version + 1,
           updated_at = NOW()
       WHERE id = $1`,
      [userId],
    );

    // Audit log
    await db.query(
      `INSERT INTO admin_action_log (admin_id, target_user_id, action, reason)
       VALUES ($1, $2, 'unban', $3)`,
      [body.reviewer_id || null, userId, body.reason || null],
    );

    return {
      statusCode: 200,
      body: { message: "User unbanned", user_id: userId },
    };
  },

  // ──────────────────────────────────────────────────────────
  // GET /admin/reports?status=pending
  // ──────────────────────────────────────────────────────────
  getReports: async (queryParams) => {
    const db = await getPool();
    const status = queryParams.status || "pending";
    const limit = Math.min(parseInt(queryParams.limit || "20"), 50);
    const offset = parseInt(queryParams.offset || "0");

    const validStatuses = ["pending", "reviewed", "dismissed", "all"];
    if (!validStatuses.includes(status)) {
      return { statusCode: 400, body: { error: "Invalid status filter" } };
    }

    const statusFilter = status === "all" ? "" : "AND r.status = $4";
    const params = status === "all" ? [limit, offset] : [limit, offset, status];

    // Adjust param indices based on whether status filter is used
    const limitIdx = 1;
    const offsetIdx = 2;
    const statusIdx = 3;

    const query = `
      SELECT
        r.id,
        r.reason,
        r.description,
        r.status,
        r.admin_action,
        r.admin_notes,
        r.created_at,
        r.reviewed_at,
        r.reporter_id,
        COALESCE(
          CONCAT(rp_mentor.first_name, ' ', rp_mentor.last_name),
          CONCAT(rp_mentee.first_name, ' ', rp_mentee.last_name)
        ) AS reporter_name,
        ru_reporter.role AS reporter_role,
        r.reported_id,
        COALESCE(
          CONCAT(rd_mentor.first_name, ' ', rd_mentor.last_name),
          CONCAT(rd_mentee.first_name, ' ', rd_mentee.last_name)
        ) AS reported_name,
        ru_reported.role AS reported_role,
        ru_reported.account_status AS reported_account_status,
        (SELECT COUNT(*)::int FROM report WHERE reported_id = r.reported_id) AS reported_total_reports
      FROM report r
      JOIN "user" ru_reporter ON ru_reporter.id = r.reporter_id
      LEFT JOIN mentor_profile rp_mentor ON rp_mentor.user_id = r.reporter_id
      LEFT JOIN mentee_profile rp_mentee ON rp_mentee.user_id = r.reporter_id
      JOIN "user" ru_reported ON ru_reported.id = r.reported_id
      LEFT JOIN mentor_profile rd_mentor ON rd_mentor.user_id = r.reported_id
      LEFT JOIN mentee_profile rd_mentee ON rd_mentee.user_id = r.reported_id
      ${status !== "all" ? `WHERE r.status = $3` : ""}
      ORDER BY r.created_at DESC
      LIMIT $1 OFFSET $2
    `;

    const result = await db.query(query, params);

    const countQuery =
      status === "all"
        ? `SELECT COUNT(*)::int AS total FROM report`
        : `SELECT COUNT(*)::int AS total FROM report WHERE status = $1`;
    const countResult = await db.query(
      countQuery,
      status === "all" ? [] : [status],
    );

    return {
      statusCode: 200,
      body: {
        reports: result.rows.map((r) => ({
          id: r.id,
          reason: r.reason,
          description: r.description,
          status: r.status,
          admin_action: r.admin_action,
          admin_notes: r.admin_notes,
          created_at: r.created_at,
          reviewed_at: r.reviewed_at,
          reporter: {
            id: r.reporter_id,
            name: r.reporter_name?.trim() || null,
            role: r.reporter_role,
          },
          reported: {
            id: r.reported_id,
            name: r.reported_name?.trim() || null,
            role: r.reported_role,
            account_status: r.reported_account_status,
            total_reports: r.reported_total_reports,
          },
        })),
        total: countResult.rows[0].total,
        has_more: offset + limit < countResult.rows[0].total,
      },
    };
  },

  // ──────────────────────────────────────────────────────────
  // POST /admin/reports/:id/action
  // ──────────────────────────────────────────────────────────
  actionReport: async (reportId, body) => {
    const { action, admin_notes, reviewer_id, ban_reason } = body;
    const db = await getPool();

    if (!action || !reviewer_id) {
      return {
        statusCode: 400,
        body: { error: "action and reviewer_id are required" },
      };
    }

    const validActions = ["dismiss", "warn", "ban"];
    if (!validActions.includes(action)) {
      return {
        statusCode: 400,
        body: { error: "Invalid action. Must be: dismiss, warn, or ban" },
      };
    }

    const report = await db.query(`SELECT * FROM report WHERE id = $1`, [
      reportId,
    ]);

    if (report.rows.length === 0) {
      return { statusCode: 404, body: { error: "Report not found" } };
    }

    const reportData = report.rows[0];

    if (reportData.status !== "pending") {
      return {
        statusCode: 400,
        body: { error: "Report has already been reviewed" },
      };
    }

    // Map action to DB enum values
    const statusMap = {
      dismiss: "dismissed",
      warn: "reviewed",
      ban: "reviewed",
    };
    const adminActionMap = { dismiss: null, warn: "warning", ban: "banned" };

    await db.query(
      `UPDATE report
       SET status = $2::report_status,
           admin_action = $3::admin_action,
           admin_notes = $4,
           reviewed_at = NOW(),
           reviewed_by = $5
       WHERE id = $1`,
      [
        reportId,
        statusMap[action],
        adminActionMap[action],
        admin_notes || null,
        reviewer_id,
      ],
    );

    // Audit log
    await db.query(
      `INSERT INTO admin_action_log (admin_id, target_user_id, action, reason, metadata)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        reviewer_id,
        reportData.reported_id,
        `report_${action}`,
        admin_notes || null,
        JSON.stringify({ report_id: reportId, reason: reportData.reason }),
      ],
    );

    // If action is ban, trigger the ban flow
    if (action === "ban") {
      if (!ban_reason) {
        return {
          statusCode: 400,
          body: { error: "ban_reason is required when action is ban" },
        };
      }

      const banResult = await handlers.banUser(reportData.reported_id, {
        reason: ban_reason,
        reviewer_id,
      });

      if (banResult.statusCode !== 200) {
        return banResult;
      }
    }

    // If action is warn, send notification
    if (action === "warn") {
      await sendFcmNotification(reportData.reported_id, {
        title: "Account Warning",
        body: "Your account has received a warning due to a report. Please review our community guidelines.",
        data: { type: "account_warning" },
      });
    }

    return {
      statusCode: 200,
      body: {
        message: `Report ${action === "dismiss" ? "dismissed" : action === "warn" ? "warned" : "banned"}`,
        report_id: reportId,
      },
    };
  },

  // ──────────────────────────────────────────────────────────
  // POST /admin/presign
  // ──────────────────────────────────────────────────────────
  getPresignedUrl: async (body) => {
    const { s3_key } = body;

    if (!s3_key) {
      return { statusCode: 400, body: { error: "s3_key is required" } };
    }

    const command = new GetObjectCommand({
      Bucket: BUCKET_NAME,
      Key: s3_key,
    });
    const url = await getSignedUrl(s3Client, command, { expiresIn: 3600 });

    return { statusCode: 200, body: { url } };
  },

  // ──────────────────────────────────────────────────────────
  // GET /admin/support/tickets?status=open
  // ──────────────────────────────────────────────────────────
  getTickets: async (queryParams) => {
    const db = await getPool();
    const status = queryParams.status || "open";
    const limit = Math.min(parseInt(queryParams.limit || "20"), 50);
    const offset = parseInt(queryParams.offset || "0");

    if (!["open", "resolved", "all"].includes(status)) {
      return { statusCode: 400, body: { error: "Invalid status" } };
    }

    const statusFilter = status === "all" ? "" : "WHERE t.status = $3";
    const params = status === "all" ? [limit, offset] : [limit, offset, status];

    const result = await db.query(
      `SELECT
         t.id, t.ticket_number, t.user_id, t.status, t.created_at, t.resolved_at,
         u.phone_number, u.role,
         COALESCE(
           NULLIF(TRIM(CONCAT(mp.first_name, ' ', mp.last_name)), ''),
           NULLIF(TRIM(CONCAT(menp.first_name, ' ', menp.last_name)), '')
         ) AS user_name,
         COALESCE(mp.profile_photo_url, menp.profile_photo_url) AS user_avatar
       FROM support_ticket t
       JOIN "user" u ON u.id = t.user_id
       LEFT JOIN mentor_profile mp ON mp.user_id = t.user_id
       LEFT JOIN mentee_profile menp ON menp.user_id = t.user_id
       ${statusFilter}
       ORDER BY t.created_at ${status === "resolved" ? "DESC" : "ASC"}
       LIMIT $1 OFFSET $2`,
      params,
    );

    const tickets = [];
    for (const row of result.rows) {
      const lastMsg = await db.query(
        `SELECT content, sender_type, created_at FROM support_message
         WHERE ticket_id = $1 AND type = 'text' ORDER BY created_at DESC LIMIT 1`,
        [row.id],
      );

      const unread = await db.query(
        `SELECT COUNT(*)::int AS count FROM support_message
         WHERE ticket_id = $1 AND sender_type = 'user'
           AND created_at > COALESCE(
             (SELECT MAX(created_at) FROM support_message WHERE ticket_id = $1 AND sender_type = 'admin'),
             '1970-01-01')`,
        [row.id],
      );

      tickets.push({
        id: row.id,
        ticket_number: row.ticket_number,
        user_id: row.user_id,
        status: row.status,
        created_at: row.created_at,
        resolved_at: row.resolved_at,
        user: {
          name: row.user_name?.trim() || null,
          phone: row.phone_number,
          role: row.role,
          avatar: row.user_avatar || null,
        },
        last_message: lastMsg.rows[0]
          ? {
              content: lastMsg.rows[0].content,
              sender_type: lastMsg.rows[0].sender_type,
              created_at: lastMsg.rows[0].created_at,
            }
          : null,
        unread_count: unread.rows[0].count,
      });
    }

    const countQuery =
      status === "all"
        ? `SELECT COUNT(*)::int AS total FROM support_ticket`
        : `SELECT COUNT(*)::int AS total FROM support_ticket WHERE status = $1`;
    const countResult = await db.query(
      countQuery,
      status === "all" ? [] : [status],
    );

    return {
      statusCode: 200,
      body: {
        tickets,
        total: countResult.rows[0].total,
        has_more: offset + limit < countResult.rows[0].total,
      },
    };
  },

  // ──────────────────────────────────────────────────────────
  // GET /admin/support/tickets/:id/messages
  // ──────────────────────────────────────────────────────────
  getTicketMessages: async (ticketId, queryParams) => {
    const db = await getPool();
    const limit = Math.min(parseInt(queryParams.limit || "50"), 100);
    const before = queryParams.before || null;

    const ticket = await db.query(
      `SELECT t.id, t.user_id, t.status,
              COALESCE(NULLIF(TRIM(CONCAT(mp.first_name, ' ', mp.last_name)), ''), NULLIF(TRIM(CONCAT(menp.first_name, ' ', menp.last_name)), '')) AS user_name,
              u.phone_number, u.role
       FROM support_ticket t
       JOIN "user" u ON u.id = t.user_id
       LEFT JOIN mentor_profile mp ON mp.user_id = t.user_id
       LEFT JOIN mentee_profile menp ON menp.user_id = t.user_id
       WHERE t.id = $1`,
      [ticketId],
    );

    if (ticket.rows.length === 0)
      return { statusCode: 404, body: { error: "Ticket not found" } };

    const query = before
      ? `SELECT id, sender_type, sender_id, content, type, created_at FROM support_message WHERE ticket_id = $1 AND created_at < $2 ORDER BY created_at DESC LIMIT $3`
      : `SELECT id, sender_type, sender_id, content, type, created_at FROM support_message WHERE ticket_id = $1 ORDER BY created_at DESC LIMIT $2`;
    const queryParams2 = before ? [ticketId, before, limit] : [ticketId, limit];

    const result = await db.query(query, queryParams2);

    return {
      statusCode: 200,
      body: {
        ticket: {
          id: ticket.rows[0].id,
          status: ticket.rows[0].status,
          user_name: ticket.rows[0].user_name?.trim() || null,
          phone: ticket.rows[0].phone_number,
          role: ticket.rows[0].role,
        },
        messages: result.rows.map((row) => ({
          message_id: row.id,
          sender_id: row.sender_type === "system" ? "system" : row.sender_id,
          sender_type: row.sender_type,
          content: row.content,
          type: row.type,
          created_at: row.created_at,
        })),
        count: result.rows.length,
        has_more: result.rows.length === limit,
      },
    };
  },

  // ──────────────────────────────────────────────────────────
  // POST /admin/support/tickets/:id/messages
  // ──────────────────────────────────────────────────────────
  replyToTicket: async (ticketId, body) => {
    const { content, reviewer_id } = body;
    const db = await getPool();

    if (!content || !content.trim())
      return { statusCode: 400, body: { error: "content is required" } };
    if (!reviewer_id)
      return { statusCode: 400, body: { error: "reviewer_id is required" } };

    const ticket = await db.query(
      `SELECT id, user_id, status, ticket_number FROM support_ticket WHERE id = $1`,
      [ticketId],
    );
    if (ticket.rows.length === 0)
      return { statusCode: 404, body: { error: "Ticket not found" } };
    if (ticket.rows[0].status !== "open")
      return {
        statusCode: 400,
        body: { error: "Cannot reply to a resolved ticket" },
      };

    const userId = ticket.rows[0].user_id;

    const msg = await db.query(
      `INSERT INTO support_message (user_id, ticket_id, sender_type, sender_id, content, type)
       VALUES ($1, $2, 'admin', $3, $4, 'text')
       RETURNING id, sender_type, sender_id, content, type, created_at`,
      [userId, ticketId, reviewer_id, content.trim()],
    );

    const row = msg.rows[0];

    await pushToUser(
      userId,
      {
        type: "support_message",
        message_id: row.id,
        sender_id: row.sender_id,
        sender_type: "admin",
        content: row.content,
        message_type: "text",
        created_at: row.created_at.toISOString(),
      },
      {
        title: "MentorTalk Support",
        body:
          content.trim().length > 100
            ? content.trim().substring(0, 97) + "..."
            : content.trim(),
        data: { type: "support_reply" },
      },
    );

    return {
      statusCode: 201,
      body: {
        message_id: row.id,
        content: row.content,
        created_at: row.created_at,
      },
    };
  },

  // ──────────────────────────────────────────────────────────
  // POST /admin/support/tickets/:id/resolve
  // ──────────────────────────────────────────────────────────
  resolveTicket: async (ticketId, body) => {
    const { reviewer_id } = body;
    const db = await getPool();

    if (!reviewer_id)
      return { statusCode: 400, body: { error: "reviewer_id is required" } };

    const ticket = await db.query(
      `SELECT id, user_id, status, ticket_number FROM support_ticket WHERE id = $1`,
      [ticketId],
    );
    if (ticket.rows.length === 0)
      return { statusCode: 404, body: { error: "Ticket not found" } };
    if (ticket.rows[0].status !== "open")
      return { statusCode: 400, body: { error: "Ticket is already resolved" } };

    const userId = ticket.rows[0].user_id;

    await db.query(
      `UPDATE support_ticket SET status = 'resolved', resolved_at = NOW(), resolved_by = $2 WHERE id = $1`,
      [ticketId, reviewer_id],
    );

    const ticketNumber = ticket.rows[0].ticket_number;

    const sysMsg = await db.query(
      `INSERT INTO support_message (user_id, ticket_id, sender_type, content, type)
       VALUES ($1, $2, 'system', $3, 'system')
       RETURNING id, created_at`,
      [userId, ticketId, `Ticket resolved · #${ticketNumber}`],
    );

    await pushToUser(
      userId,
      {
        type: "support_message",
        message_id: sysMsg.rows[0].id,
        sender_id: "system",
        sender_type: "system",
        content: `Ticket resolved · #${ticketNumber}`,
        message_type: "system",
        created_at: sysMsg.rows[0].created_at.toISOString(),
      },
      {
        title: "MentorTalk Support",
        body: "Your support ticket has been resolved",
        data: { type: "support_reply" },
      },
    );

    return {
      statusCode: 200,
      body: { message: "Ticket resolved", ticket_id: ticketId },
    };
  },
};

// ============================================================
// Helpers
// ============================================================

const deleteAadhaarPdf = async (userId) => {
  const db = await getPool();
  const identity = await db.query(
    `SELECT aadhaar_pdf_url FROM identity_verification WHERE user_id = $1`,
    [userId],
  );

  const pdfUrl = identity.rows[0]?.aadhaar_pdf_url;
  if (pdfUrl) {
    try {
      await s3Client.send(
        new DeleteObjectCommand({ Bucket: BUCKET_NAME, Key: pdfUrl }),
      );
      console.log(`[S3] Deleted aadhaar PDF: ${pdfUrl}`);
    } catch (e) {
      console.error(`[S3] Delete error:`, e);
    }
  }
};

// ============================================================
// Router
// ============================================================

export const handler = async (event) => {
  try {
    const path = event.path || event.rawPath || "";
    const method =
      event.httpMethod || event.requestContext?.http?.method || "GET";
    const body =
      typeof event.body === "string"
        ? JSON.parse(event.body || "{}")
        : event.body || {};

    // Validate admin API key
    const isAdmin = await validateAdminKey(event);
    if (!isAdmin) {
      return respond({ statusCode: 401, body: { error: "Unauthorized" } });
    }

    let result;

    // GET /admin/applications/:id/files
    const filesMatch = path.match(/\/admin\/applications\/([\w-]+)\/files$/);
    if (filesMatch && method === "GET") {
      result = await handlers.getFiles(filesMatch[1]);
      return respond(result);
    }

    // POST /admin/applications/:id/review
    const reviewMatch = path.match(/\/admin\/applications\/([\w-]+)\/review$/);
    if (reviewMatch && method === "POST") {
      result = await handlers.reviewApplication(reviewMatch[1], body);
      return respond(result);
    }

    // POST /admin/applications/:id/verify-aadhaar
    const aadhaarMatch = path.match(
      /\/admin\/applications\/([\w-]+)\/verify-aadhaar$/,
    );
    if (aadhaarMatch && method === "POST") {
      result = await handlers.verifyAadhaar(aadhaarMatch[1]);
      return respond(result);
    }

    // POST /admin/notifications/send
    if (path.includes("/admin/notifications/send") && method === "POST") {
      result = await handlers.sendNotification(body);
      return respond(result);
    }

    // POST /admin/presign
    if (path.includes("/admin/presign") && method === "POST") {
      result = await handlers.getPresignedUrl(body);
      return respond(result);
    }

    // GET /admin/users?q=search
    if (path.match(/\/admin\/users\/?$/) && method === "GET") {
      const queryParams = event.queryStringParameters || {};
      result = await handlers.searchUsers(queryParams);
      return respond(result);
    }

    // GET /admin/users/:id
    const userDetailMatch = path.match(/\/admin\/users\/([\w-]+)$/);
    if (
      userDetailMatch &&
      method === "GET" &&
      !path.includes("/ban") &&
      !path.includes("/unban")
    ) {
      result = await handlers.getUser(userDetailMatch[1]);
      return respond(result);
    }

    // POST /admin/users/:id/ban
    const banMatch = path.match(/\/admin\/users\/([\w-]+)\/ban$/);
    if (banMatch && method === "POST") {
      result = await handlers.banUser(banMatch[1], body);
      return respond(result);
    }

    // POST /admin/users/:id/unban
    const unbanMatch = path.match(/\/admin\/users\/([\w-]+)\/unban$/);
    if (unbanMatch && method === "POST") {
      result = await handlers.unbanUser(unbanMatch[1], body);
      return respond(result);
    }

    // GET /admin/reports
    if (path.match(/\/admin\/reports\/?$/) && method === "GET") {
      const queryParams = event.queryStringParameters || {};
      result = await handlers.getReports(queryParams);
      return respond(result);
    }

    // POST /admin/reports/:id/action
    const reportActionMatch = path.match(/\/admin\/reports\/([\w-]+)\/action$/);
    if (reportActionMatch && method === "POST") {
      result = await handlers.actionReport(reportActionMatch[1], body);
      return respond(result);
    }

    // GET /admin/support/tickets
    if (path.match(/\/admin\/support\/tickets\/?$/) && method === "GET") {
      const queryParams = event.queryStringParameters || {};
      result = await handlers.getTickets(queryParams);
      return respond(result);
    }

    // GET /admin/support/tickets/:id/messages
    const ticketMsgsMatch = path.match(
      /\/admin\/support\/tickets\/([\w-]+)\/messages$/,
    );
    if (ticketMsgsMatch && method === "GET") {
      const queryParams = event.queryStringParameters || {};
      result = await handlers.getTicketMessages(
        ticketMsgsMatch[1],
        queryParams,
      );
      return respond(result);
    }

    // POST /admin/support/tickets/:id/messages
    if (ticketMsgsMatch && method === "POST") {
      result = await handlers.replyToTicket(ticketMsgsMatch[1], body);
      return respond(result);
    }

    // POST /admin/support/tickets/:id/resolve
    const resolveMatch = path.match(
      /\/admin\/support\/tickets\/([\w-]+)\/resolve$/,
    );
    if (resolveMatch && method === "POST") {
      result = await handlers.resolveTicket(resolveMatch[1], body);
      return respond(result);
    }

    return respond({ statusCode: 404, body: { error: "Not found" } });
  } catch (error) {
    console.error("Error:", error);
    return respond({
      statusCode: 500,
      body: { error: "Internal server error" },
    });
  }
};

const respond = (result) => ({
  statusCode: result.statusCode,
  headers: {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  },
  body: JSON.stringify(result.body),
});
