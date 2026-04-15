import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import pg from "pg";
import jwt from "jsonwebtoken";

const { Pool } = pg;
const secretsClient = new SecretsManagerClient({ region: "ap-south-1" });
const s3Client = new S3Client({ region: "ap-south-1" });
const BUCKET_NAME = "mentortalk-storage-prod";

let pool = null;
let jwtSecret = null;

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

const removeEditableSubstep = async (userId, substep) => {
  const db = await getPool();
  await db.query(
    `UPDATE mentorship_application
     SET pending_fixes = array_remove(pending_fixes, $1)
     WHERE user_id = $2
     AND $1 = ANY(pending_fixes)`,
    [substep, userId]
  );
};

// ============================================================
// Handlers
// ============================================================

const handlers = {
  // ──────────────────────────────────────────────────────────
  // GET /onboarding/status
  // ──────────────────────────────────────────────────────────
  getStatus: async (userId) => {
    const db = await getPool();

    const [app, identity, user, languages, mentorshipRows, education, experience] =
      await Promise.all([
        db.query(`SELECT * FROM mentorship_application WHERE user_id = $1`, [userId]),
        db.query(
          `SELECT aadhaar_pdf_url, aadhaar_verified, aadhaar_uploaded_at,
                  selfie_url, selfie_uploaded_at
           FROM identity_verification WHERE user_id = $1`,
          [userId]
        ),
        db.query(
          `SELECT mp.first_name, mp.last_name, u.dob, u.gender
           FROM "user" u
           LEFT JOIN mentor_profile mp ON mp.user_id = u.id
           WHERE u.id = $1`,
          [userId]
        ),

        db.query(
          `SELECT language_code FROM user_language WHERE user_id = $1 AND role = 'mentor'`,
          [userId]
        ),
        db.query(
          `SELECT mentorship_category_id, mentorship_option_id FROM user_mentorship WHERE user_id = $1 AND role = 'mentor'`,
          [userId]
        ),
        db.query(
          `SELECT id, institution_name, degree, field_of_study,
                  start_year, end_year, document_url, is_verified,
                  created_at, updated_at
           FROM education WHERE user_id = $1 AND role = 'mentor'
           ORDER BY start_year DESC NULLS LAST, created_at DESC`,
          [userId]
        ),
        db.query(
          `SELECT id, title, organization, is_current,
                  start_month, start_year, end_month, end_year,
                  description, is_verified, created_at, updated_at
           FROM experience WHERE user_id = $1
           ORDER BY is_current DESC, start_year DESC, start_month DESC`,
          [userId]
        ),
      ]);

    if (app.rows.length === 0) {
      return { statusCode: 404, body: { error: "Application not found" } };
    }

    const appData = app.rows[0];

    // Fetch latest admin comments from review_history
    const latestReview = await db.query(
      `SELECT comments FROM review_history 
       WHERE application_id = $1 AND comments IS NOT NULL
       ORDER BY created_at DESC LIMIT 1`,
      [appData.id]
    );
    const adminComments = latestReview.rows[0]?.comments
      ? (typeof latestReview.rows[0].comments === 'string'
         ? JSON.parse(latestReview.rows[0].comments)
         : latestReview.rows[0].comments)
      : {};

    const identityData = identity.rows[0] || {};
    const userData = user.rows[0] || {};
    const selectedCategories = [...new Set(mentorshipRows.rows.map(r => r.mentorship_category_id))];
    const selectedOptions = mentorshipRows.rows
      .filter(r => r.mentorship_option_id)
      .map(r => r.mentorship_option_id);

    const overallStatus =
      appData.submission_status ||
      (appData.step1_status === "done" && appData.step2_status === "done"
        ? "ready"
        : "in_progress");

    const currentStep = appData.step1_status === "done" ? 2 : 1;

    // Presign selfie URL if exists
    let selfieUrl = null;
    if (identityData.selfie_url) {
      const command = new GetObjectCommand({
        Bucket: BUCKET_NAME,
        Key: identityData.selfie_url,
      });
      selfieUrl = await getSignedUrl(s3Client, command, { expiresIn: 3600 });
    }

    // Check personal details completeness
    const personalDetailsComplete =
      !!userData.first_name && !!userData.last_name && !!userData.dob && !!userData.gender;

    return {
      statusCode: 200,
      body: {
        status: overallStatus,
        step: currentStep,
        step1_status: appData.step1_status,
        step2_status: appData.step2_status,
        editable_substeps: appData.pending_fixes || [],
        admin_comments: adminComments,
        personal_details: {
          first_name: userData.first_name || null,
          last_name: userData.last_name || null,
          dob: userData.dob ? userData.dob.toISOString().split("T")[0] : null,
          gender: userData.gender || null,
          languages: languages.rows.map((r) => r.language_code.trim()),
          is_complete: personalDetailsComplete && languages.rows.length > 0,
        },
        identity: {
          aadhaar_uploaded: !!identityData.aadhaar_pdf_url || !!identityData.aadhaar_verified,
          aadhaar_verified: !!identityData.aadhaar_verified,
          aadhaar_pdf_url: identityData.aadhaar_pdf_url || null,
          selfie_url: selfieUrl,
          selfie_uploaded: !!identityData.selfie_url,
        },
        mentorship: {
          selected_categories: selectedCategories,
          selected_options: selectedOptions,
        },
        education: education.rows.map((e) => ({
          id: e.id,
          institution_name: e.institution_name,
          degree: e.degree,
          field_of_study: e.field_of_study,
          start_year: e.start_year,
          end_year: e.end_year,
          document_url: e.document_url,
          is_verified: e.is_verified,
        })),
        experience: experience.rows.map((e) => ({
          id: e.id,
          title: e.title,
          organization: e.organization,
          is_current: e.is_current,
          start_month: e.start_month,
          start_year: e.start_year,
          end_month: e.end_month,
          end_year: e.end_year,
          description: e.description,
          is_verified: e.is_verified,
        })),
        notes: appData.notes || null,
        application: appData.submitted_at
          ? {
              id: String(appData.id),
              submitted_at: appData.submitted_at,
              reviewed_at: appData.reviewed_at || null,
              reviewed_by: appData.reviewed_by || null,
            }
          : null,
          rejection: appData.submission_status === 'rejected'
          ? {
              attempt_count: appData.attempt_number,
              max_attempts: appData.max_attempts,
              attempts_remaining: Math.max(0, appData.max_attempts - appData.attempt_number),
              can_reapply: appData.attempt_number < appData.max_attempts,
              cooldown_until: appData.cooldown_until || null,
            }
          : null,
      },
    };
  },

  submissionStatus: async (userId) => {
    const db = await getPool();
    const result = await db.query(
      `SELECT submission_status FROM mentorship_application WHERE user_id = $1`,
      [userId]
    );
    if (result.rows.length === 0) {
      return { statusCode: 200, body: { status: "new" } };
    }
    return { statusCode: 200, body: { status: result.rows[0].submission_status } };
  },

  // ──────────────────────────────────────────────────────────
  // PUT /onboarding/identity/personal-details
  // ──────────────────────────────────────────────────────────
  savePersonalDetails: async (userId, body) => {
    const { first_name, last_name, dob, gender, languages } = body;
    const db = await getPool();

    if (!first_name || !last_name || !dob || !gender) {
      return {
        statusCode: 400,
        body: { error: "first_name, last_name, dob, and gender are required" },
      };
    }

    const validGenders = ["male", "female", "other"];
    if (!validGenders.includes(gender)) {
      return { statusCode: 400, body: { error: "Invalid gender value" } };
    }

     // DOB + gender stay on user table
     await db.query(
      `UPDATE "user"
       SET dob = $1, gender = $2, updated_at = NOW()
       WHERE id = $3`,
      [dob, gender, userId]
    );

    // Names go to mentor_profile
    await db.query(
      `UPDATE mentor_profile
       SET first_name = $1, last_name = $2, updated_at = NOW()
       WHERE user_id = $3`,
      [first_name.trim(), last_name.trim(), userId]
    );

    // Replace languages
    if (Array.isArray(languages) && languages.length > 0) {
      await db.query(`DELETE FROM user_language WHERE user_id = $1 AND role = 'mentor'`, [userId]);
      const values = languages
        .map((_, i) => `($1, $${i + 2}, 'mentor')`)
        .join(", ");
      const params = [userId, ...languages.map((l) => l.trim().toLowerCase())];
      await db.query(
        `INSERT INTO user_language (user_id, language_code, role) VALUES ${values}`,
        params
      );
    }

    await removeEditableSubstep(userId, "personal_details");

    return { statusCode: 200, body: { message: "Personal details saved" } };
  },

  // ──────────────────────────────────────────────────────────
  // POST /onboarding/identity/aadhaar/presign
  // ──────────────────────────────────────────────────────────
  aadhaarPresign: async (userId, body) => {
    const { file_name } = body;
    const s3Key = `aadhaar/${userId}/${Date.now()}-${file_name || "aadhaar.pdf"}`;
    const command = new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: s3Key,
      ContentType: "application/pdf",
    });
    const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn: 900 });

    return {
      statusCode: 200,
      body: { upload_url: uploadUrl, s3_key: s3Key },
    };
  },

  // ──────────────────────────────────────────────────────────
  // POST /onboarding/identity/aadhaar/confirm
  // ──────────────────────────────────────────────────────────
  aadhaarConfirm: async (userId, body) => {
    const { s3_key } = body;
    if (!s3_key) {
      return { statusCode: 400, body: { error: "s3_key is required" } };
    }

    const db = await getPool();

    // Upsert identity_verification row
    await db.query(
      `INSERT INTO identity_verification (user_id, aadhaar_pdf_url, aadhaar_uploaded_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (user_id) DO UPDATE
       SET aadhaar_pdf_url = $2, aadhaar_uploaded_at = NOW(), updated_at = NOW()`,
      [userId, s3_key]
    );

    await removeEditableSubstep(userId, "aadhaar");

    return { statusCode: 200, body: { message: "Aadhaar uploaded" } };
  },

  // ──────────────────────────────────────────────────────────
  // POST /onboarding/identity/selfie/presign
  // ──────────────────────────────────────────────────────────
  selfiePresign: async (userId) => {
    const s3Key = `selfies/${userId}/selfie.jpg`;
    const command = new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: s3Key,
      ContentType: "image/jpeg",
    });
    const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn: 900 });

    return { statusCode: 200, body: { upload_url: uploadUrl, s3_key: s3Key } };
  },

  // ──────────────────────────────────────────────────────────
  // POST /onboarding/identity/selfie/confirm
  // ──────────────────────────────────────────────────────────
  selfieConfirm: async (userId, body) => {
    const { s3_key } = body;
    const db = await getPool();

    await db.query(
      `UPDATE identity_verification
       SET selfie_url = $1, selfie_uploaded_at = NOW(), updated_at = NOW()
       WHERE user_id = $2`,
      [s3_key, userId]
    );
    await removeEditableSubstep(userId, "selfie");

    return { statusCode: 200, body: { message: "Selfie uploaded" } };
  },

  // ──────────────────────────────────────────────────────────
  // POST /onboarding/identity/complete
  // ──────────────────────────────────────────────────────────
  identityComplete: async (userId) => {
    const db = await getPool();

    // Verify personal details
    const user = await db.query(
      `SELECT mp.first_name, mp.last_name, u.dob, u.gender
       FROM "user" u
       LEFT JOIN mentor_profile mp ON mp.user_id = u.id
       WHERE u.id = $1`,
      [userId]
    );
    const u = user.rows[0];
    if (!u || !u.first_name || !u.last_name || !u.dob || !u.gender) {
      return { statusCode: 400, body: { error: "Personal details incomplete" } };
    }

    // Verify languages
    const langs = await db.query(
      `SELECT COUNT(*) as count FROM user_language WHERE user_id = $1 AND role='mentor'`,
      [userId]
    );
    if (parseInt(langs.rows[0].count) === 0) {
      return { statusCode: 400, body: { error: "At least one language required" } };
    }

    // Verify aadhaar uploaded
    const identity = await db.query(
      `SELECT aadhaar_pdf_url, selfie_url FROM identity_verification WHERE user_id = $1`,
      [userId]
    );
    if (identity.rows.length === 0 || !identity.rows[0].aadhaar_pdf_url) {
      return { statusCode: 400, body: { error: "Aadhaar not uploaded" } };
    }
    if (!identity.rows[0].selfie_url) {
      return { statusCode: 400, body: { error: "Selfie not uploaded" } };
    }

    await db.query(
      `UPDATE mentorship_application
       SET step1_status = 'done', step2_status = 'in_progress'
       WHERE user_id = $1`,
      [userId]
    );

    return { statusCode: 200, body: { message: "Step 1 complete" } };
  },

  // ──────────────────────────────────────────────────────────
  // GET /onboarding/categories
  // ──────────────────────────────────────────────────────────
  getCategories: async () => {
    const db = await getPool();

    const catResult = await db.query(
      `SELECT * FROM mentorship_category WHERE is_active = true ORDER BY sort_order`
    );
    const optResult = await db.query(
      `SELECT * FROM mentorship_option WHERE is_active = true ORDER BY sort_order`
    );

    console.log('Cat count:', catResult.rows.length);
    console.log('Opt count:', optResult.rows.length);
    console.log('Sample cat id:', catResult.rows[0]?.id, typeof catResult.rows[0]?.id);
    console.log('Sample opt category_id:', optResult.rows[0]?.category_id, typeof optResult.rows[0]?.category_id);
    console.log('Filter test:', optResult.rows.filter(opt => opt.category_id === catResult.rows[0]?.id).length);

    const versionResult = await db.query(
      `SELECT version FROM cache_metadata WHERE table_name = 'mentorship_category'`
    );

    const categories = catResult.rows.map((cat) => ({
      id: cat.id,
      name: cat.name,
      options: optResult.rows
      .filter((opt) => opt.category_id === cat.id)
        .map((opt) => ({
          id: opt.id,
          name: opt.name,
          category_id: opt.category_id,
          sort_order: opt.sort_order,
          is_active: opt.is_active,
          group_label: opt.group_label || null,
        })),
    }));

    return {
      statusCode: 200,
      body: { categories, version: versionResult.rows[0]?.version || 1 },
    };
  },

  getLanguages: async () => {
    const db = await getPool();
    const result = await db.query(
      `SELECT code, name, native_name, script 
       FROM language 
       WHERE is_active = true 
       ORDER BY sort_order`
    );
    return {
      statusCode: 200,
      body: { languages: result.rows },
    };
  },

  // ──────────────────────────────────────────────────────────
  // POST /onboarding/mentorship/categories
  // ──────────────────────────────────────────────────────────
  saveCategories: async (userId, body, role = 'mentor') => {
    const { selected_categories } = body;
    const db = await getPool();

    const categoryIds = selected_categories.category_ids || [];
    const optionIds = selected_categories.option_ids || [];

    await db.query(`DELETE FROM user_mentorship WHERE user_id = $1 AND role = $2`, [userId, role]);

    // Look up each option's actual category from DB
    let optionToCategoryMap = {};
    if (optionIds.length > 0) {
      const optResult = await db.query(
        `SELECT id, category_id FROM mentorship_option WHERE id = ANY($1)`,
        [optionIds]
      );
      for (const row of optResult.rows) {
        optionToCategoryMap[row.id] = row.category_id;
      }
    }

    const rows = [];
    for (const catId of categoryIds) {
      // Find options that belong to this category (from DB lookup)
      const catOptions = optionIds.filter(
        optId => optionToCategoryMap[optId] === catId
      );

      if (catOptions.length > 0) {
        for (const optId of catOptions) {
          rows.push({ catId, optId });
        }
      } else {
        rows.push({ catId, optId: null });
      }
    }

    if (rows.length > 0) {
      const values = rows
      .map((_, i) => `($1, $${i * 2 + 2}, $${i * 2 + 3}, '${role}')`)
      .join(", ");
      const params = [userId, ...rows.flatMap(r => [r.catId, r.optId])];
      await db.query(
        `INSERT INTO user_mentorship (user_id, mentorship_category_id, mentorship_option_id, role) VALUES ${values}`,
        params
      );
    }

    await removeEditableSubstep(userId, "categories");
    return { statusCode: 200, body: { message: "Categories saved" } };
  },

  // ──────────────────────────────────────────────────────────
  // Education CRUD
  // ──────────────────────────────────────────────────────────

  // GET /onboarding/education
  getEducation: async (userId, role = 'mentor') => {
    const db = await getPool();
    const result = await db.query(
      `SELECT id, institution_name, degree, field_of_study,
              start_year, end_year, document_url, is_verified,
              created_at, updated_at
       FROM education WHERE user_id = $1 AND role = $2
       ORDER BY start_year DESC NULLS LAST, created_at DESC`,
      [userId, role]
    );

    return {
      statusCode: 200,
      body: {
        education: result.rows.map((e) => ({
          id: e.id,
          institution_name: e.institution_name,
          degree: e.degree,
          field_of_study: e.field_of_study,
          start_year: e.start_year,
          end_year: e.end_year,
          document_url: e.document_url,
          is_verified: e.is_verified,
        })),
      },
    };
  },

  // POST /onboarding/education
  addEducation: async (userId, body, role = 'mentor') => {
    const { institution_name, degree, field_of_study, start_year, end_year, document_url } = body;
    const db = await getPool();

    if (!institution_name || !degree) {
      return {
        statusCode: 400,
        body: { error: "institution_name and degree are required" },
      };
    }

    const result = await db.query(
      `INSERT INTO education (user_id, institution_name, degree, field_of_study, start_year, end_year, document_url, role)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING id`,
       [userId, institution_name.trim(), degree.trim(), field_of_study?.trim() || null, start_year || null, end_year || null, document_url || null, role]
     );

    await removeEditableSubstep(userId, "education");

    return {
      statusCode: 201,
      body: { id: result.rows[0].id, message: "Education added" },
    };
  },

  // PUT /onboarding/education/:id
  updateEducation: async (userId, educationId, body, role = 'mentor') => {
    const { institution_name, degree, field_of_study, start_year, end_year, document_url } = body;
    const db = await getPool();

    if (!institution_name || !degree) {
      return {
        statusCode: 400,
        body: { error: "institution_name and degree are required" },
      };
    }

    const result = await db.query(
      `UPDATE education
       SET institution_name = $1, degree = $2, field_of_study = $3,
           start_year = $4, end_year = $5, document_url = $6, updated_at = NOW()
       WHERE id = $7 AND user_id = $8 AND role = $9
       RETURNING id`,
      [institution_name.trim(), degree.trim(), field_of_study?.trim() || null, start_year || null, end_year || null, document_url || null, educationId, userId, role]
    );

    if (result.rows.length === 0) {
      return { statusCode: 404, body: { error: "Education not found" } };
    }

    return { statusCode: 200, body: { message: "Education updated" } };
  },

  // DELETE /onboarding/education/:id
  deleteEducation: async (userId, educationId, role = 'mentor') => {
    const db = await getPool();

    // Get document_url to delete from S3 if exists
    const edu = await db.query(
      `SELECT document_url FROM education WHERE id = $1 AND user_id = $2 AND role = $3`,
      [educationId, userId, role]
    );

    if (edu.rows.length === 0) {
      return { statusCode: 404, body: { error: "Education not found" } };
    }

    // Delete S3 document if exists
    if (edu.rows[0].document_url) {
      try {
        await s3Client.send(
          new DeleteObjectCommand({
            Bucket: BUCKET_NAME,
            Key: edu.rows[0].document_url,
          })
        );
      } catch (e) {
        console.error("S3 delete error:", e);
      }
    }

    await db.query(`DELETE FROM education WHERE id = $1 AND user_id = $2 AND role = $3`, [
      educationId,
      userId,
      role,
    ]);

    return { statusCode: 200, body: { message: "Education deleted" } };
  },

  // POST /onboarding/education/presign
  educationPresign: async (userId, body) => {
    const { file_name } = body;
    const s3Key = `education/${userId}/${Date.now()}-${file_name || "document.pdf"}`;
    const command = new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: s3Key,
      ContentType: "application/pdf",
    });
    const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn: 900 });

    return {
      statusCode: 200,
      body: { upload_url: uploadUrl, s3_key: s3Key },
    };
  },

  // ──────────────────────────────────────────────────────────
  // Experience CRUD
  // ──────────────────────────────────────────────────────────

  // GET /onboarding/experience
  getExperience: async (userId) => {
    const db = await getPool();
    const result = await db.query(
      `SELECT id, title, organization, is_current,
              start_month, start_year, end_month, end_year,
              description, is_verified, created_at, updated_at
       FROM experience WHERE user_id = $1
       ORDER BY is_current DESC, start_year DESC, start_month DESC`,
      [userId]
    );

    return {
      statusCode: 200,
      body: {
        experience: result.rows.map((e) => ({
          id: e.id,
          title: e.title,
          organization: e.organization,
          is_current: e.is_current,
          start_month: e.start_month,
          start_year: e.start_year,
          end_month: e.end_month,
          end_year: e.end_year,
          description: e.description,
          is_verified: e.is_verified,
        })),
      },
    };
  },

  // POST /onboarding/experience
  addExperience: async (userId, body) => {
    const { title, organization, is_current, start_month, start_year, end_month, end_year, description } = body;
    const db = await getPool();

    if (!title || !organization || !start_month || !start_year) {
      return {
        statusCode: 400,
        body: { error: "title, organization, start_month, and start_year are required" },
      };
    }

    const result = await db.query(
      `INSERT INTO experience (user_id, title, organization, is_current, start_month, start_year, end_month, end_year, description)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id`,
      [userId, title.trim(), organization.trim(), is_current || false, start_month, start_year, end_month || null, end_year || null, description?.trim() || null]
    );

    await removeEditableSubstep(userId, "experience");

    return {
      statusCode: 201,
      body: { id: result.rows[0].id, message: "Experience added" },
    };
  },

  // PUT /onboarding/experience/:id
  updateExperience: async (userId, experienceId, body) => {
    const { title, organization, is_current, start_month, start_year, end_month, end_year, description } = body;
    const db = await getPool();

    if (!title || !organization || !start_month || !start_year) {
      return {
        statusCode: 400,
        body: { error: "title, organization, start_month, and start_year are required" },
      };
    }

    const result = await db.query(
      `UPDATE experience
       SET title = $1, organization = $2, is_current = $3,
           start_month = $4, start_year = $5, end_month = $6,
           end_year = $7, description = $8, updated_at = NOW()
       WHERE id = $9 AND user_id = $10
       RETURNING id`,
      [title.trim(), organization.trim(), is_current || false, start_month, start_year, end_month || null, end_year || null, description?.trim() || null, experienceId, userId]
    );

    if (result.rows.length === 0) {
      return { statusCode: 404, body: { error: "Experience not found" } };
    }

    return { statusCode: 200, body: { message: "Experience updated" } };
  },

  // DELETE /onboarding/experience/:id
  deleteExperience: async (userId, experienceId) => {
    const db = await getPool();

    const result = await db.query(
      `DELETE FROM experience WHERE id = $1 AND user_id = $2 RETURNING id`,
      [experienceId, userId]
    );

    if (result.rows.length === 0) {
      return { statusCode: 404, body: { error: "Experience not found" } };
    }

    return { statusCode: 200, body: { message: "Experience deleted" } };
  },

  // ──────────────────────────────────────────────────────────
  // POST /onboarding/mentorship/notes
  // ──────────────────────────────────────────────────────────
  saveNotes: async (userId, body) => {
    const { notes } = body;
    const db = await getPool();

    await db.query(
      `UPDATE mentorship_application SET notes = $1, updated_at = NOW() WHERE user_id = $2`,
      [notes?.trim() || null, userId]
    );
    await removeEditableSubstep(userId, "notes");

    return { statusCode: 200, body: { message: "Notes saved" } };
  },

  // ──────────────────────────────────────────────────────────
  // POST /onboarding/mentorship/complete
  // ──────────────────────────────────────────────────────────
  mentorshipComplete: async (userId) => {
    const db = await getPool();

    // Verify categories selected
    const cats = await db.query(
      `SELECT COUNT(*) as count FROM user_mentorship WHERE user_id = $1 AND role = 'mentor'`,
      [userId]
    );
    if (parseInt(cats.rows[0].count) === 0) {
      return { statusCode: 400, body: { error: "Categories not selected" } };
    }

    // Verify at least 1 education entry
    const edu = await db.query(
      `SELECT COUNT(*) as count FROM education WHERE user_id = $1 AND role = 'mentor'`,
      [userId]
    );
    if (parseInt(edu.rows[0].count) === 0) {
      return { statusCode: 400, body: { error: "At least one education entry required" } };
    }

    await db.query(
      `UPDATE mentorship_application SET step2_status = 'done', updated_at = NOW() WHERE user_id = $1`,
      [userId]
    );

    return { statusCode: 200, body: { message: "Step 2 complete" } };
  },

  // ──────────────────────────────────────────────────────────
  // POST /onboarding/submit
  // ──────────────────────────────────────────────────────────
  submit: async (userId) => {
    const db = await getPool();

    const app = await db.query(
      `SELECT * FROM mentorship_application WHERE user_id = $1`,
      [userId]
    );

    if (app.rows.length === 0) {
      return { statusCode: 404, body: { error: "Application not found" } };
    }

    if (app.rows[0].step1_status !== "done" || app.rows[0].step2_status !== "done") {
      return { statusCode: 400, body: { error: "Complete all steps first" } };
    }

    const currentStatus = app.rows[0].submission_status;

    if (currentStatus === "under_review" || currentStatus === "approved") {
      return { statusCode: 400, body: { error: "Cannot submit in current state" } };
    }

    if (currentStatus === "rejected" && app.rows[0].cooldown_until) {
      if (new Date(app.rows[0].cooldown_until) > new Date()) {
        return { statusCode: 400, body: { error: "Cooldown period active" } };
      }
    }

    if (currentStatus === "action_required") {
      const substeps = app.rows[0].pending_fixes || [];
      if (substeps.length > 0) {
        return { statusCode: 400, body: { error: "Fix all flagged items first" } };
      }
    }

    await db.query(
      `UPDATE mentorship_application
       SET submission_status = 'under_review',
           submitted_at = NOW(),
           pending_fixes = '{}',
           updated_at = NOW()
       WHERE user_id = $1`,
      [userId]
    );

    return {
      statusCode: 200,
      body: { message: "Application submitted", status: "under_review" },
    };
  },

  // ──────────────────────────────────────────────────────────
  // Legacy endpoints kept for backward compat
  // ──────────────────────────────────────────────────────────

  // GET /onboarding/documents/types
  getDocumentTypes: async () => {
    const db = await getPool();
    const result = await db.query(
      `SELECT * FROM document_type WHERE is_active = true ORDER BY sort_order`
    );
    const versionResult = await db.query(
      `SELECT version FROM cache_metadata WHERE table_name = 'document_type'`
    );

    return {
      statusCode: 200,
      body: {
        document_types: result.rows.map((dt) => ({
          id: dt.id,
          name: dt.name,
          allow_multiple: dt.allow_multiple,
        })),
        version: versionResult.rows[0]?.version || 1,
      },
    };
  },
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
    const authHeader =
      event.headers?.Authorization || event.headers?.authorization;

    // ── Public endpoints ──────────────────────────────────
    if (path.includes("/categories") && method === "GET" && !path.includes("/mentorship/categories")) {
      const result = await handlers.getCategories();
      return respond(result);
    }

    if (path.includes("/languages") && method === "GET") {
      const result = await handlers.getLanguages();
      return respond(result);
    }

    if (path.includes("/documents/types") && method === "GET") {
      const result = await handlers.getDocumentTypes();
      return respond(result);
    }

    // ── Protected endpoints ───────────────────────────────
    const decoded = await verifyToken(authHeader);
    const userId = decoded.sub;
    const role = decoded.app || 'mentor';

    let result;

    // Status
    if (path.includes("/submission-status") && method === "GET") {
      result = await handlers.submissionStatus(userId);
    }
    else if (path.includes("/status") && method === "GET") {
      result = await handlers.getStatus(userId);

    // Identity - Personal Details
    } else if (path.includes("/identity/personal-details") && method === "PUT") {
      result = await handlers.savePersonalDetails(userId, body);

    // Identity - Aadhaar
    } else if (path.includes("/identity/aadhaar/presign") && method === "POST") {
      result = await handlers.aadhaarPresign(userId, body);
    } else if (path.includes("/identity/aadhaar/confirm") && method === "POST") {
      result = await handlers.aadhaarConfirm(userId, body);

    // Identity - Selfie
    } else if (path.includes("/identity/selfie/presign") && method === "POST") {
      result = await handlers.selfiePresign(userId);
    } else if (path.includes("/identity/selfie/confirm") && method === "POST") {
      result = await handlers.selfieConfirm(userId, body);

    // Identity - Complete
    } else if (path.includes("/identity/complete") && method === "POST") {
      result = await handlers.identityComplete(userId);

    // Mentorship - Categories
  } else if (path.includes("/mentorship/categories") && method === "POST") {
    result = await handlers.saveCategories(userId, body, role);

    // Mentorship - Notes
    } else if (path.includes("/mentorship/notes") && method === "POST") {
      result = await handlers.saveNotes(userId, body);

    // Mentorship - Complete
    } else if (path.includes("/mentorship/complete") && method === "POST") {
      result = await handlers.mentorshipComplete(userId);

    // Education CRUD
    } else if (path.includes("/education/presign") && method === "POST") {
      result = await handlers.educationPresign(userId, body);
    } else if (path.match(/\/education\/?$/) && method === "GET") {
      result = await handlers.getEducation(userId, role);
    } else if (path.match(/\/education\/?$/) && method === "POST") {
      result = await handlers.addEducation(userId, body, role);
    } else if (path.match(/\/education\/[\w-]+$/) && method === "PUT") {
      const educationId = path.split("/").pop();
      result = await handlers.updateEducation(userId, educationId, body, role);
    } else if (path.match(/\/education\/[\w-]+$/) && method === "DELETE") {
      const educationId = path.split("/").pop();
      result = await handlers.deleteEducation(userId, educationId, role);

    // Experience CRUD
    } else if (path.match(/\/experience\/?$/) && method === "GET") {
      result = await handlers.getExperience(userId);
    } else if (path.match(/\/experience\/?$/) && method === "POST") {
      result = await handlers.addExperience(userId, body);
    } else if (path.match(/\/experience\/[\w-]+$/) && method === "PUT") {
      const experienceId = path.split("/").pop();
      result = await handlers.updateExperience(userId, experienceId, body);
    } else if (path.match(/\/experience\/[\w-]+$/) && method === "DELETE") {
      const experienceId = path.split("/").pop();
      result = await handlers.deleteExperience(userId, experienceId);

    // Submit
    } else if (path.includes("/submit") && method === "POST") {
      result = await handlers.submit(userId);

    } else {
      result = { statusCode: 404, body: { error: "Not found" } };
    }

    return respond(result);
  } catch (error) {
    console.error("Error:", error);

    if (
      error.name === "JsonWebTokenError" ||
      error.name === "TokenExpiredError"
    ) {
      return respond({ statusCode: 401, body: { error: "Invalid or expired token" } });
    }

    return respond({ statusCode: 500, body: { error: "Internal server error" } });
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
