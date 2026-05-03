# MentorTalk — Database Schema Documentation

Version 2.1 · May 2026 · PostgreSQL + DynamoDB + S3

---

## Overview

MentorTalk is a two-sided mentoring marketplace where mentees pay per-minute for chat, audio, and video sessions with mentors. The data layer spans three services: PostgreSQL (relational data, 37 tables), DynamoDB (real-time chat messages, WebSocket connections, presence), and S3 (file storage for profile photos, identity documents, education proofs, and in-session chat media).

The central entity is the `user` table in PostgreSQL. Nearly every other table has a foreign key pointing to `user.id`. A single person has one `user` row but can have both a `mentee_profile` and a `mentor_profile`, each backed by a separate `wallet`. This dual-role design means one phone number can operate as both a mentee and a mentor simultaneously, with independent balances, histories, and lifecycles.

Several shared tables (`user_mentorship`, `user_language`, `education`) include a `role` column (`mentee` or `mentor`) to scope rows per app. This prevents a dual-role user's mentee selections from overwriting their mentor selections. APIs filter by `role` using the JWT `app` claim — the same pattern used by `support_ticket.app`.

The platform itself is represented by a special user with the UUID `00000000-0000-0000-0000-000000000000` and role `platform`. All platform fees and incoming payment cash land in this account's transactions.

---

## 1. Identity & Authentication

### user

The root table. Every person in the system — mentee, mentor, or admin — is a single row here. The phone number is the primary identity (unique, max 15 chars). Authentication happens via Truecaller OAuth (when installed) or Firebase Phone Auth OTP (fallback). The `role` field indicates the primary registration role but does not prevent dual-role usage; that's handled by whether a `mentee_profile` and/or `mentor_profile` exists. On account deletion, PII is stripped (phone_number, names, dob, gender, fcm_token set to NULL) but the row is retained with account_status = hard_deleted to preserve FK integrity for transactions and sessions.

| Column                 | Purpose                                                                         |
| ---------------------- | ------------------------------------------------------------------------------- |
| id                     | UUID primary key, auto-generated                                                |
| phone_number           | Unique login identifier, max 15 characters                                      |
| role                   | Enum: `mentee`, `mentor`, `admin`, `platform` — the role the user registered as |
| auth_method            | Enum: `truecaller_oauth`, `truecaller_otp`, `truecaller_missed_call`            |
| first_name, last_name  | Name from Truecaller or manually entered                                        |
| dob                    | Date of birth, optional                                                         |
| gender                 | Enum: `male`, `female`, `other`                                                 |
| account_status         | Enum: `active`, `suspended`, `banned`, `soft_deleted`, `hard_deleted`           |
| banned_at, ban_reason  | Populated when account_status is set to banned                                  |
| deletion_scheduled_at  | Set when account_status becomes soft_deleted. Hard delete runs after this date. |
| token_version          | Integer, incremented to invalidate all existing JWTs                            |
| fcm_token              | Firebase Cloud Messaging token for push notifications                           |
| is_admin               | Boolean flag for admin access (separate from the `admin` role enum)             |
| admin_email            | Email address for admin panel access (used by `lib/auth.ts` login lookup)       |
| created_at, updated_at | Timestamps                                                                      |

Key relationships: Almost every other table references `user.id` as a foreign key.

### refresh_token

Stores hashed refresh tokens for JWT-based authentication. Each row represents one active device/session.

| Column      | Purpose                                                           |
| ----------- | ----------------------------------------------------------------- |
| id          | UUID primary key                                                  |
| user_id     | FK → user.id                                                      |
| token_hash  | SHA-256 hash of the refresh token (never stored in plain text)    |
| device_info | Optional device identifier string                                 |
| expires_at  | Token expiry timestamp                                            |
| revoked_at  | Set when the token is explicitly revoked (logout, security event) |
| created_at  | Timestamp                                                         |

A user can have multiple active refresh tokens (one per device). On deletion or security events, all tokens for a user are revoked by setting `revoked_at`. Incrementing `user.token_version` globally invalidates all JWTs without touching this table.

---

## 2. Profiles & Onboarding

### mentee_profile

Created during mentee onboarding. One-to-one with user (PK is `user_id`). Contains the mentee's public-facing profile information.

| Column                            | Purpose                                                    |
| --------------------------------- | ---------------------------------------------------------- |
| user_id                           | PK and FK → user.id                                        |
| first_name, last_name             | Display name (may differ from user table if edited in-app) |
| username                          | Unique handle, max 30 characters                           |
| profile_photo_url                 | S3 key for avatar (served via CDN)                         |
| bio                               | Free-text bio                                              |
| education_level, education_detail | Simple dropdowns for current education status              |
| target_year                       | The year the mentee is targeting for their exam            |
| onboarding_completed_at           | Null until all onboarding steps are done                   |
| created_at, updated_at            | Timestamps                                                 |

### mentor_profile

Created when a user applies to become a mentor and is approved. One-to-one with user. Contains mentor-specific settings and aggregated stats.

| Column                 | Purpose                                                                                                                                                                                                        |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| user_id                | PK and FK → user.id                                                                                                                                                                                            |
| first_name, last_name  | Display name                                                                                                                                                                                                   |
| profile_photo_url      | S3 key for avatar (served via CDN)                                                                                                                                                                             |
| bio                    | Free-text bio shown on mentor card                                                                                                                                                                             |
| rate_per_minute        | Current per-minute rate in INR                                                                                                                                                                                 |
| is_available           | Boolean toggle — controls whether the mentor appears in discovery                                                                                                                                              |
| pref_audio, pref_video | Session type preferences (chat is always available)                                                                                                                                                            |
| unlocked_tier_id       | FK → rate_tier.id — the highest pricing tier the mentor has unlocked                                                                                                                                           |
| avg_rating             | Denormalized average from the review table                                                                                                                                                                     |
| total_reviews          | Denormalized count from the review table                                                                                                                                                                       |
| free_chat_enabled      | Platform-controlled. When FALSE, mentor is excluded from free chat matching. Not exposed in mentor app UI. Default TRUE.                                                                                       |
| intro_discount_percent | INT, nullable. CHECK constraint enforces value IN (25, 50). NULL = mentor has opted out of intro rate. 25 = mentee gets 25% off base rate. 50 = mentee gets 50% off. Set by mentor in app, admin can override. |
| created_at, updated_at | Timestamps                                                                                                                                                                                                     |

### mentor_quick_reply

Pre-saved template messages for mentors to send quickly during timed sessions. Accessible from two places: mentor Settings (full CRUD + reorder) and an in-session bottom sheet (tap to insert + add new). Four default replies are seeded on mentor approval.

| Column                 | Purpose                      |
| ---------------------- | ---------------------------- |
| id                     | UUID primary key             |
| user_id                | FK → user.id (the mentor)    |
| content                | The quick reply text         |
| sort_order             | Integer for display ordering |
| created_at, updated_at | Timestamps                   |

Index on `user_id` for fast lookups. Max 50 replies per mentor (enforced at API level, not DB level).

**Default replies seeded on mentor approval:**

1. "Let me explain this step by step, follow along"
2. "Can you share a screenshot of the question?"
3. "Well done! Do you have any other doubts?"
4. "We're running low on time, recharge to continue or let me know your last doubt!"

### education

Stores educational background entries for a user, scoped by role. A user can have multiple education rows per role. Used during both mentee onboarding (optional) and mentor application (required for credibility). Each entry can have an uploaded verification document stored in S3. The `role` column ensures a dual-role user's mentee and mentor education entries are independent — deleting an entry from the mentee app does not affect mentor application data.

| Column                 | Purpose                                                                                                                                                                                       |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| id                     | UUID primary key                                                                                                                                                                              |
| user_id                | FK → user.id                                                                                                                                                                                  |
| role                   | `mentee` or `mentor` — scopes entries per app. Populated from JWT `app` claim. CHECK constraint enforces valid values.                                                                        |
| institution_name       | Name of school/college/university                                                                                                                                                             |
| degree                 | Degree name                                                                                                                                                                                   |
| field_of_study         | Optional specialization                                                                                                                                                                       |
| start_year, end_year   | Year range                                                                                                                                                                                    |
| document_url           | S3 key for uploaded proof (marksheet, certificate). Uploaded via presigned URL (`education/{userId}/{timestamp}-{filename}`). Explicitly deleted from S3 when the education entry is deleted. |
| is_verified            | Set to true by admin after manual verification                                                                                                                                                |
| created_at, updated_at | Timestamps                                                                                                                                                                                    |

### experience

Stores professional or mentoring experience entries for mentors. Multiple rows per user. Unlike education, experience entries are purely text-based — there is no document upload or `document_url` column. Credibility is established through admin review of the text content. No `role` column needed — only the mentor app writes to this table.

| Column                  | Purpose                       |
| ----------------------- | ----------------------------- |
| id                      | UUID primary key              |
| user_id                 | FK → user.id                  |
| title                   | Role/position title           |
| organization            | Company/institution name      |
| is_current              | Boolean — still in this role  |
| start_month, start_year | Start date                    |
| end_month, end_year     | End date (null if is_current) |
| description             | Free-text description         |
| is_verified             | Admin-verified flag           |
| created_at, updated_at  | Timestamps                    |

### identity_verification

One-to-one with user (unique constraint on user_id). Stores Aadhaar and selfie verification data for mentors. This is the most sensitive table in the schema from a privacy perspective.

| Column                 | Purpose                                                                                                                                                      |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| id                     | UUID primary key                                                                                                                                             |
| user_id                | FK → user.id (unique)                                                                                                                                        |
| aadhaar_pdf_url        | S3 key for uploaded Aadhaar PDF (`aadhaar/{userId}/{timestamp}-{filename}`). Already deleted from S3 once admin verification is complete per current policy. |
| aadhaar_uploaded_at    | When the document was uploaded                                                                                                                               |
| aadhaar_verified       | Boolean — admin has verified the document                                                                                                                    |
| selfie_url             | S3 key for selfie photo (`selfies/{userId}/selfie.jpg`) used for face-match verification                                                                     |
| selfie_uploaded_at     | When the selfie was uploaded                                                                                                                                 |
| created_at, updated_at | Timestamps                                                                                                                                                   |

On account deletion, the actual files (selfie image, and Aadhaar PDF if still present) must be deleted from S3. The row can be retained with URLs nulled and only the `aadhaar_verified` flag and timestamps kept as an audit record.

### mentorship_application

Tracks the mentor onboarding/application process. One-to-one with user (unique constraint on user_id). The application is a two-step process with admin review.

| Column                 | Purpose                                                                                                                                                                     |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| id                     | UUID primary key                                                                                                                                                            |
| user_id                | FK → user.id (unique)                                                                                                                                                       |
| step1_status           | Enum step_status: `locked`, `in_progress`, `done`, `action_required`                                                                                                        |
| step2_status           | Same enum — step 2 unlocks after step 1 is done                                                                                                                             |
| submission_status      | Enum: `in_progress`, `under_review`, `action_required`, `rejected`, `approved`                                                                                              |
| attempt_number         | Current attempt (starts at 1)                                                                                                                                               |
| max_attempts           | Maximum allowed attempts (default 3)                                                                                                                                        |
| cooldown_until         | If rejected, the date until which the user cannot reapply                                                                                                                   |
| pending_fixes          | Text array — list of substep identifiers the admin flagged for correction (e.g., `personal_details`, `aadhaar`, `selfie`, `categories`, `education`, `experience`, `notes`) |
| notes                  | Free-text notes written by the mentor during application                                                                                                                    |
| submitted_at           | When the application was last submitted for review                                                                                                                          |
| created_at, updated_at | Timestamps                                                                                                                                                                  |

### review_history

Audit trail of admin actions on mentorship applications. Each time an admin approves, rejects, or requests changes, a row is added.

| Column         | Purpose                                                      |
| -------------- | ------------------------------------------------------------ |
| id             | UUID primary key                                             |
| application_id | FK → mentorship_application.id                               |
| reviewer_id    | FK → user.id (the admin who took action)                     |
| action         | Enum: `approve`, `reject`, `request_changes`                 |
| comments       | JSONB — structured feedback from the admin, keyed by substep |
| created_at     | Timestamp                                                    |

### mentor_payout_account

Stores the mentor's bank account details and PAN for receiving payouts. One-to-one with user (unique on user_id). Contains PAN for TDS compliance under Section 194O. v007 adds verification metadata and a `verification_method` column to support both manual admin review (v1) and automated penny drop (future).

| Column                   | Purpose                                                                                                                                                        |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| id                       | UUID primary key                                                                                                                                               |
| user_id                  | FK → user.id (unique)                                                                                                                                          |
| account_holder_name      | Name on the bank account                                                                                                                                       |
| account_number           | Bank account number                                                                                                                                            |
| ifsc_code                | IFSC code for NEFT/RTGS                                                                                                                                        |
| bank_name                | Name of the bank (auto-filled client-side from `https://ifsc.razorpay.com/{IFSC}`)                                                                             |
| pan_number               | PAN card number (required for TDS)                                                                                                                             |
| pan_document_url         | S3 key for uploaded PAN card image                                                                                                                             |
| pan_verified             | Boolean — set to TRUE by admin after manual verification                                                                                                       |
| pan_verified_at          | When PAN was verified                                                                                                                                          |
| pan_verified_by          | FK → user.id — admin who verified                                                                                                                              |
| pan_rejection_reason     | Free text — populated when admin rejects PAN. Cleared on next verification attempt.                                                                            |
| pan_submitted_at         | When mentor first submitted PAN details (or last edited them)                                                                                                  |
| bank_verified            | Boolean — set to TRUE when admin (or automated mechanism) approves bank account. Resets to FALSE if any bank field is edited.                                  |
| bank_verified_at         | When bank was verified                                                                                                                                         |
| bank_verified_by         | FK → user.id — admin who verified                                                                                                                              |
| bank_rejection_reason    | Free text — populated when admin rejects bank details. Cleared on next verification attempt.                                                                   |
| bank_submitted_at        | When mentor first submitted bank details (or last edited them)                                                                                                 |
| verification_method      | How verification is performed: `manual`, `razorpay_forward`, `razorpay_reverse`, `cashfree`, `surepass`, `karza`. Default `manual`. CHECK constraint enforces. |
| razorpay_fund_account_id | Razorpay's fund account ID for automated payouts. Populated only when `verification_method != 'manual'`.                                                       |
| created_at, updated_at   | Timestamps. `updated_at` maintained by trigger.                                                                                                                |

**Editing behavior:** when a mentor edits any bank field via `PUT /mentor/payouts/bank`, the backend resets `bank_verified = FALSE` and `bank_verified_at = NULL`, requiring re-verification. Same for PAN. The audit trail of every bank version a mentor has had is preserved in `mentor_bank_account_history` via a database trigger.

This table contains highly sensitive financial data. On deletion, the row should be deleted after the final payout is processed, but PAN and payout records are retained separately in the transaction table for tax compliance.

### mentor_bank_account_history

Audit trail of every bank account version a mentor has had. Whenever bank details on `mentor_payout_account` change, a database trigger closes the previous active row (sets `active_until = NOW()`) and inserts a new active row reflecting the new state. Lets us answer "which bank received the March payout?" even if the mentor changed their account in April.

| Column              | Purpose                                                                                                        |
| ------------------- | -------------------------------------------------------------------------------------------------------------- |
| id                  | UUID primary key                                                                                               |
| mentor_id           | FK → user.id                                                                                                   |
| account_holder_name | Snapshot of name at the time                                                                                   |
| account_number      | Full account number (not masked, for legal/dispute resolution). Protect via row-level access in admin queries. |
| ifsc_code           | Snapshot of IFSC                                                                                               |
| bank_name           | Snapshot of bank name                                                                                          |
| verified_at         | When this version was verified (NULL if never verified before being replaced)                                  |
| verified_by         | FK → user.id — admin who verified                                                                              |
| verification_method | How this version was verified                                                                                  |
| active_from         | When this version became active                                                                                |
| active_until        | When this version was replaced (NULL = currently active)                                                       |
| changed_by          | FK → user.id — usually the mentor themselves; could be an admin if changed on their behalf                     |
| created_at          | Timestamp                                                                                                      |

Indexed on `(mentor_id, active_from DESC)` for chronological queries, and on `(mentor_id) WHERE active_until IS NULL` for fast current-active lookups.

The `payout` table's `bank_account_history_id` column points to a specific row here — the exact historical bank account the payout was sent to.

### mentee_privacy_settings

Per-mentee privacy controls. One-to-one with user (PK is `user_id`). Created during mentee onboarding alongside `mentee_promo_status`. Read by mentor-facing endpoints to gate access to chat history, media, name display in reviews, and screen-capture protection on the mentor app.

| Column                 | Purpose                                                                                                                                                                                                                                                            |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| user_id                | PK and FK → user.id                                                                                                                                                                                                                                                |
| show_name_in_reviews   | When FALSE, mentee's name is suppressed (rendered as "Mentee") in the mentor profile reviews list and the mentor's own received-reviews dashboard. Default TRUE.                                                                                                   |
| mentor_chat_access     | When FALSE, mentor sees only system messages (`Chat ended`, `Audio call ended`, etc.) from past sessions. Active session content is fully visible regardless. The mentor's inbox preview (`/mentor/mentees`) falls back to the last system message. Default FALSE. |
| mentor_download_access | When FALSE, presigned media URLs are not issued to the mentor for messages from past (non-active) sessions. Active session media is fully accessible regardless. Default FALSE.                                                                                    |
| block_screenshots      | When TRUE, the mentor app applies `FLAG_SECURE` on the chat screen during interactions with this mentee. iOS uses `UIScreen.isCaptured` + blur overlay (best-effort, not a true OS-level block). Default FALSE.                                                    |
| block_call_recording   | When TRUE, the mentor app applies `FLAG_SECURE` on the audio/video call overlays during sessions with this mentee. Same iOS caveat as above. Default FALSE.                                                                                                        |
| created_at, updated_at | Timestamps                                                                                                                                                                                                                                                         |

Toggle changes take effect at the start of the next session — there is no real-time WebSocket propagation to active sessions. The mentor's session-start payloads (`POST /session/:id/accept` REST response, `GET /mentor/mentees` rows, `GET /mentor/sessions` rows) carry a `mentee.privacy = { block_screenshots, block_call_recording }` snapshot for the client to apply `FLAG_SECURE` at the right time.

Known limitation: media bytes already cached on the mentor's device (under `{app_support_dir}/chat-media/`) survive a `mentor_download_access = FALSE` toggle. The flag prevents new downloads but does not purge the existing cache.

---

## 3. Discovery & Categories

### mentorship_category

Top-level categories for what mentors offer (e.g., "UPSC," "JEE," "NEET," "CAT"). These are platform-defined, not user-created.

| Column     | Purpose                                  |
| ---------- | ---------------------------------------- |
| id         | String primary key (e.g., "upsc", "jee") |
| name       | Display name                             |
| sort_order | Controls display ordering                |
| is_active  | Soft toggle to hide/show categories      |

### mentorship_option

Subcategories within a category (e.g., under "UPSC": "Prelims Strategy," "Essay Writing," "Optional Subject"). FK to mentorship_category.

| Column      | Purpose                               |
| ----------- | ------------------------------------- |
| id          | String primary key                    |
| category_id | FK → mentorship_category.id           |
| name        | Display name                          |
| group_label | Optional grouping within the category |
| sort_order  | Display ordering                      |
| is_active   | Soft toggle                           |

### user_mentorship

Junction table linking a user to the category + option combinations they are interested in (as mentee) or offer (as mentor). Scoped by `role` — a dual-role user has independent selections per app. A mentee selecting "JEE" means "I want help with JEE"; a mentor selecting "JEE" means "I teach JEE."

| Column                 | Purpose                                                                                                                   |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| id                     | UUID primary key                                                                                                          |
| user_id                | FK → user.id                                                                                                              |
| mentorship_category_id | FK → mentorship_category.id                                                                                               |
| mentorship_option_id   | FK → mentorship_option.id (nullable — user may select the whole category)                                                 |
| role                   | `mentee` or `mentor` — scopes selections per app. Populated from JWT `app` claim. CHECK constraint enforces valid values. |
| created_at             | Timestamp                                                                                                                 |

Unique constraint on (user_id, mentorship_category_id, mentorship_option_id, role) prevents duplicate entries per role.

### user_language

Junction table linking a user to the languages they speak, scoped by role. A dual-role user has independent language selections per app — the mentor app's languages (what I teach in) are separate from the mentee app's languages (what I'm comfortable with).

| Column        | Purpose                                                                                                                   |
| ------------- | ------------------------------------------------------------------------------------------------------------------------- |
| user_id       | FK → user.id                                                                                                              |
| language_code | FK → language.code (2-char code)                                                                                          |
| role          | `mentee` or `mentor` — scopes selections per app. Populated from JWT `app` claim. CHECK constraint enforces valid values. |

Composite primary key on (user_id, language_code, role).

### language

Reference table of available languages.

| Column      | Purpose                                      |
| ----------- | -------------------------------------------- |
| code        | PK — 2-character code (e.g., "en", "hi")     |
| name        | English name                                 |
| native_name | Name in the language's own script            |
| script      | Writing system (e.g., "Devanagari", "Latin") |
| is_active   | Soft toggle                                  |
| sort_order  | Display ordering                             |

### rate_tier

Defines the pricing tiers that mentors unlock as they gain experience. A mentor starts at tier 1 and progresses based on session count, minutes, and rating.

| Column            | Purpose                                         |
| ----------------- | ----------------------------------------------- |
| id                | Integer PK                                      |
| name              | Tier name (e.g., "Starter", "Rising", "Expert") |
| max_rate          | Maximum per-minute rate allowed at this tier    |
| required_sessions | Minimum completed sessions to unlock            |
| required_minutes  | Minimum total minutes to unlock                 |
| required_rating   | Minimum average rating to unlock                |

### rate_history

Audit log of every rate change a mentor makes. Used for analytics and potential dispute resolution.

| Column             | Purpose                           |
| ------------------ | --------------------------------- |
| id                 | UUID primary key                  |
| user_id            | FK → user.id (the mentor)         |
| old_rate, new_rate | Previous and new per-minute rates |
| changed_at         | Timestamp                         |

---

## 4. Sessions & Communication

### session

The core operational table. Each row represents one mentoring session between a mentor and a mentee. Sessions go through a lifecycle tracked by the `status` enum. Each session has a single type (chat, audio, or video) throughout its duration.

| Column                   | Purpose                                                                                                                                                                                                                 |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| id                       | UUID primary key                                                                                                                                                                                                        |
| mentor_id                | FK → user.id                                                                                                                                                                                                            |
| mentee_id                | FK → user.id                                                                                                                                                                                                            |
| status                   | Enum — see lifecycle below                                                                                                                                                                                              |
| requested_session_type   | Enum: `chat`, `audio`, `video` — the session's type for its entire duration                                                                                                                                             |
| pending_switch_type      | Deprecated. Legacy field from an older multi-segment design that was never shipped. Always NULL on new sessions. Scheduled for removal in a future migration.                                                           |
| started_at               | When the session actually began                                                                                                                                                                                         |
| ended_at                 | When the session ended                                                                                                                                                                                                  |
| disconnected_at          | When a disconnect event occurred                                                                                                                                                                                        |
| disconnected_user_id     | FK → user.id — who disconnected                                                                                                                                                                                         |
| frozen_remaining_seconds | Remaining balance-seconds at time of disconnect (for grace period logic)                                                                                                                                                |
| total_amount             | Total INR charged to the mentee                                                                                                                                                                                         |
| platform_fee             | Platform's cut                                                                                                                                                                                                          |
| mentor_earning           | Mentor's cut                                                                                                                                                                                                            |
| sfn_execution_arn        | AWS Step Functions ARN for session timeout orchestration                                                                                                                                                                |
| request_timeout_schedule | EventBridge schedule for request expiry                                                                                                                                                                                 |
| grace_schedule_name      | EventBridge schedule for disconnect grace period                                                                                                                                                                        |
| billing_type             | Billing classification: `paid` (normal), `free_intro` (no charge), `intro_rate` (discounted rate, session auto-ends at intro_max_minutes — no continuation at normal rate). Default `paid`. Locked at session creation. |
| created_at               | Timestamp                                                                                                                                                                                                               |

**Session status lifecycle:**

`pending` → Mentee initiates a session request. Mentor is currently busy with another session; this request is queued.
`requested` → Request is sent to the mentor (either directly, or promoted from pending when the mentor becomes free). A 60-second timeout schedule is created — if the mentor doesn't respond, the session moves to `timed_out`.
`active` → Mentor accepted, session is live. Per-minute billing begins. An AWS Step Functions timeout is started based on the mentee's wallet balance (for paid sessions) or `intro_max_minutes` (for intro rate sessions).
`completed` → Session ended normally. Final billing is calculated, three-way transaction split is created, wallet balances updated.
`cancelled` → Mentee cancelled before mentor responded.
`rejected` → Mentor declined the request.
`timed_out` → Mentor did not respond within the 60-second timeout window.

**Free chat session differences:** Free chat sessions use a 10-second accept timeout (not 60) with auto-forwarding to the next available mentor. Free chat sessions skip the disconnect grace period — if either party disconnects, the session auto-ends immediately.

**Intro rate session differences:** Intro rate sessions are completely self-contained — they auto-end at `promo_config.intro_max_minutes` with no continuation at the normal rate. The discounted rate is calculated as `mentor.rate_per_minute × (1 - mentor.intro_discount_percent / 100)`. A single `session_segment` is created at the discounted rate. The session is billed at the discounted rate for its entire duration.

### session_segment

Tracks per-segment billing within a session. Strictly 1:1 with session — every session has exactly one segment, including intro-rate and free-chat sessions. The billing engine at session end applies `CEIL(seconds / 60) × rate_per_minute` from the segment. Mode switching (chat → audio/video mid-session) is not implemented; the historical multi-segment design is documented only as legacy context for the deprecated `session.pending_switch_type` column.

| Column           | Purpose                                                      |
| ---------------- | ------------------------------------------------------------ |
| id               | UUID primary key                                             |
| session_id       | FK → session.id (1:1 for most sessions, 1:N for mode-switch) |
| type             | Enum: `chat`, `audio`, `video` — the segment's session type  |
| rate_per_minute  | The per-minute rate locked at segment creation               |
| started_at       | When this segment started                                    |
| ended_at         | When this segment ended                                      |
| duration_seconds | Total segment duration in seconds                            |

### Chat Messages (DynamoDB)

Real-time chat messages are stored in DynamoDB, not PostgreSQL. See Section 13 for full details.

---

## 5. Billing & Wallets

### wallet

Each user can have up to two wallets — one of type `mentee` (for spending) and one of type `mentor` (for earnings). This dual-wallet design exists because the same person can be both a mentee and a mentor. The wallets are completely independent: spending from the mentee wallet has no effect on the mentor wallet and vice versa.

| Column                 | Purpose                                         |
| ---------------------- | ----------------------------------------------- |
| id                     | UUID primary key                                |
| user_id                | FK → user.id                                    |
| type                   | String: `mentee` or `mentor`                    |
| balance                | Current balance in INR (numeric, defaults to 0) |
| created_at, updated_at | Timestamps                                      |

Unique constraint on (user_id, type) ensures one wallet per role per user.

The mentee wallet is a **closed-loop prepaid instrument** — money goes in via top-ups (Razorpay) and comes out only as session payments within the platform. There is no withdraw-to-bank feature (that would require an RBI-licensed open/semi-closed PPI).

The mentor wallet accumulates earnings from sessions. Payouts to the mentor's bank account happen on a scheduled cycle via Razorpay fund transfers to the account details stored in `mentor_payout_account`.

### transaction

Double-entry-style ledger. Every financial event creates one or more rows. The `user_id` identifies whose perspective this transaction belongs to, and `wallet_id` links to the specific wallet (mentee or mentor). The platform account (`00000000-...`) also has transaction rows for fees and incoming cash.

| Column       | Purpose                                                                                             |
| ------------ | --------------------------------------------------------------------------------------------------- |
| id           | UUID primary key                                                                                    |
| user_id      | FK → user.id                                                                                        |
| wallet_id    | FK → wallet.id                                                                                      |
| type         | String identifying the transaction type (see below)                                                 |
| direction    | `credit` or `debit`                                                                                 |
| amount       | INR amount (always positive; direction indicates sign)                                              |
| session_id   | FK → session.id (null for non-session transactions like top-ups)                                    |
| reference_id | External reference (Razorpay payment ID, order ID, or internal ref)                                 |
| status       | String: `pending`, `completed`, `failed`                                                            |
| notes        | Human-readable context. Populated for refunds (reason), admin adjustments, and clawbacks. Nullable. |
| created_at   | Timestamp                                                                                           |

**Transaction types and the flows they participate in:**

_Wallet top-up (mentee loads money):_
Two rows are created atomically:

- `wallet_topup` / `credit` → mentee's wallet (balance increases)
- `platform_cash` / `debit` → platform account (records the real money received)

_Session payment (per-minute billing at session end):_
Three rows are created atomically:

- `session_payment` / `debit` → mentee's wallet (balance decreases)
- `session_earning` / `credit` → mentor's wallet (balance increases)
- `platform_fee` / `credit` → platform account (platform's commission)

_Refund (admin-initiated, when a session is disputed):_
Default behavior is platform-absorbs — mentee gets refunded, mentor keeps their earning, platform eats the cost. Clawbacks from mentors are reserved for escalated cases (abuse, fraud).

- `refund` / `credit` → mentee's wallet (balance increases)
- `platform_refund_absorption` / `debit` → platform account (platform absorbs the cost)
- `clawback` / `debit` → mentor's wallet (only in escalated cases, not default)
- `fee_reversal` / `debit` → platform account (only when full three-way reversal is needed)

_Other types observed in production data:_

- `wallet_credit` — Manual/test credits added directly
- `balance_correction` — Admin adjustment to fix discrepancies
- `adjustment` — Bulk balance reset (e.g., test data cleanup)
- `payout` — debit on mentor wallet when a payout completes. `reference_id = payout.id`.
- `tds_deduction` — debit on mentor wallet for TDS. Created alongside `payout` debit when TDS is activated. `reference_id = payout.id`. `notes` column records FY and section reference for CA reconciliation.

### payout

Source of truth for payout lifecycle. Each row represents one payout to one mentor for one cycle. Sits between the wallet/transaction ledger (which tracks the wallet math) and the actual money movement (which happens outside the system via NEFT/UPI in v1, or via RazorpayX API later). Snapshots bank/PAN details at row creation so historical payouts remain accurate even if the mentor edits their account later.

| Column                     | Purpose                                                                                                                           |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| id                         | UUID primary key                                                                                                                  |
| mentor_id                  | FK → user.id                                                                                                                      |
| wallet_id                  | FK → wallet.id (the mentor's mentor-type wallet)                                                                                  |
| gross_amount               | numeric — total amount being paid out (mentor wallet debit)                                                                       |
| tds_amount                 | numeric — TDS deducted under Section 194O. 0 in v1 (deferred). Computed as 0.001 × gross when activated.                          |
| net_amount                 | numeric — `gross_amount - tds_amount` (actual money sent). CHECK constraint enforces consistency.                                 |
| period_start, period_end   | The session-completion window this payout covers. Used for idempotency and audit.                                                 |
| bank_account_holder_name   | Snapshot of mentor's bank details at payout creation                                                                              |
| bank_account_number_masked | Masked account number (e.g., `XXXXXX1234`) for display                                                                            |
| bank_account_history_id    | FK → mentor_bank_account_history.id — links to the exact historical bank account this payout was sent to                          |
| bank_ifsc, bank_name       | Bank metadata snapshot                                                                                                            |
| upi_id                     | UPI ID snapshot (if payout method is UPI-based). Nullable.                                                                        |
| pan_number                 | Snapshot of PAN at payout creation. Required for TDS audit. Even if mentor's PAN changes (rare), historical filings stay correct. |
| method                     | Enum `payout_method`: `manual_neft`, `manual_imps`, `manual_upi`, `razorpay_payout`, `razorpay_link`. Default `manual_neft`.      |
| status                     | Enum `payout_status`: `pending`, `processing`, `completed`, `failed`. Default `pending`.                                          |
| utr                        | Bank UTR (manual flow) or Razorpay payout ID (automated flow). Nullable.                                                          |
| failure_reason             | Free text — populated when status = `failed`                                                                                      |
| notes                      | Free text — admin notes (e.g., "Sent via HDFC corporate banking")                                                                 |
| initiated_by               | FK → user.id — admin who clicked "Mark as paid", or system if automated                                                           |
| initiated_at               | When admin/system initiated the transfer                                                                                          |
| completed_at               | When status flipped to `completed`                                                                                                |
| failed_at                  | When status flipped to `failed`                                                                                                   |
| created_at, updated_at     | Timestamps                                                                                                                        |

**Idempotency:** unique partial index on `(mentor_id, period_start, period_end) WHERE status != 'failed'` prevents duplicate payouts for the same cycle. Failed payouts can be retried (a new row is created with the same period).

**Status lifecycle:**

`pending` → Cron job (EventBridge rule on the 7th of each month) creates the row. Awaiting admin action.
`processing` → Admin clicked "Mark as paid" and entered UTR (manual flow), or RazorpayX payout API call returned (automated flow). Money is in flight.
`completed` → Money has settled. Backend creates a `transaction` row debiting the mentor's wallet by `gross_amount` and (when TDS activated) a second `transaction` row for `tds_amount`. Wallet balance updated atomically.
`failed` → Transfer failed (wrong account, NEFT bounce, insufficient funds in business account). Wallet balance untouched. Admin can retry by creating a new payout row.

**Platform fee split:** The commission split is currently 50/50 (mentor gets 50%, platform takes 50%) and is hardcoded in the session handler Lambda. The split is not stored as a configurable value — it's computed at session end and the resulting amounts are stored in `session.total_amount`, `session.platform_fee`, and `session.mentor_earning`. Video sessions are charged at 1.5× the mentor's base rate.

---

## 6. Reviews & Ratings

### review

One review per session, written by the mentee about the mentor. Unique constraint on session_id ensures no duplicates. Inherently role-scoped — reviews are always mentee→mentor, with explicit `mentee_id` and `mentor_id` columns. No `role` column needed.

| Column     | Purpose                  |
| ---------- | ------------------------ |
| id         | UUID primary key         |
| session_id | FK → session.id (unique) |
| mentor_id  | FK → user.id             |
| mentee_id  | FK → user.id             |
| rating     | Smallint (1-5 stars)     |
| comment    | Optional text review     |
| created_at | Timestamp                |

When a review is created, the `mentor_profile.avg_rating` and `mentor_profile.total_reviews` fields are recomputed (denormalized for fast reads on mentor cards).

---

## 7. Moderation & Admin

### report

User-to-user reports. Either side (mentee or mentor) can report the other. The `app` column records which app the report was filed from, giving admins context about the reporter's role at the time (e.g., a dual-role user reporting as a mentee vs. as a mentor). The system also auto-creates reports via the platform account (`00000000-...`) when contact info sharing is detected in chat messages.

| Column       | Purpose                                                                                                                      |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| id           | UUID primary key                                                                                                             |
| reporter_id  | FK → user.id (who filed the report)                                                                                          |
| reported_id  | FK → user.id (who was reported)                                                                                              |
| app          | Which app the report was filed from: `mentee` or `mentor`. Nullable for legacy data. CHECK constraint enforces valid values. |
| reason       | Short category string (max 50 chars)                                                                                         |
| description  | Detailed free-text description                                                                                               |
| status       | Enum: `pending`, `reviewed`, `dismissed`                                                                                     |
| admin_action | Enum: `warning`, `suspended`, `banned` (null if no action taken)                                                             |
| admin_notes  | Free-text notes from the reviewing admin                                                                                     |
| reviewed_at  | When an admin reviewed the report                                                                                            |
| reviewed_by  | FK → user.id (the admin)                                                                                                     |
| created_at   | Timestamp                                                                                                                    |

### block

User-to-user blocks. Prevents the blocked user from appearing in the blocker's search results and from initiating sessions. Intentionally not role-scoped — blocking a user applies universally across both apps.

| Column     | Purpose                                     |
| ---------- | ------------------------------------------- |
| blocker_id | FK → user.id (composite PK with blocked_id) |
| blocked_id | FK → user.id                                |
| created_at | Timestamp                                   |

### admin_action_log

Audit trail of all admin actions (suspensions, bans, warnings) taken against users.

| Column         | Purpose                              |
| -------------- | ------------------------------------ |
| id             | UUID primary key                     |
| admin_id       | FK → user.id (the admin)             |
| target_user_id | FK → user.id (the affected user)     |
| action         | String describing the action         |
| reason         | Free-text reason                     |
| metadata       | JSONB for additional structured data |
| created_at     | Timestamp                            |

### follow

Mentee-to-mentor follow relationship. Allows mentees to save favorite mentors for quick access. Inherently role-scoped via `mentee_id` and `mentor_id`.

| Column     | Purpose                                    |
| ---------- | ------------------------------------------ |
| mentee_id  | FK → user.id (composite PK with mentor_id) |
| mentor_id  | FK → user.id                               |
| created_at | Timestamp                                  |

### banner

Platform-managed promotional banners shown in the mentee app's home screen.

| Column             | Purpose                           |
| ------------------ | --------------------------------- |
| id                 | UUID primary key                  |
| image_url          | CDN URL for the banner image      |
| action             | Deep link or URL triggered on tap |
| position           | Display ordering                  |
| is_active          | Toggle                            |
| starts_at, ends_at | Optional scheduling window        |
| created_at         | Timestamp                         |

### cache_metadata

Simple key-value table used to track cache versions for client-side invalidation (e.g., when the category list changes, bump the version so the app knows to refresh).

| Column     | Purpose                                 |
| ---------- | --------------------------------------- |
| table_name | PK — name of the cached table           |
| version    | Integer version, incremented on changes |
| updated_at | When the version was last bumped        |

---

## 8. Support Chat

In-app customer support via a single persistent chat thread per user per app. Users send messages from the app, admins reply from the admin panel. System messages mark ticket boundaries with ticket numbers ("Ticket opened · #100000000001", "Ticket resolved · #100000000001") — same visual pattern as session boundary messages in the session chat.

Messages are stored in PostgreSQL (not DynamoDB) because support chat is asynchronous with low write frequency, and the admin panel needs relational queries (list open tickets with user info, filter by status, join with user profiles) that PostgreSQL handles naturally.

### support_ticket

Admin-facing ticket metadata. Users never see tickets directly — they see one continuous chat thread. The ticket table exists for admin tracking: grouping messages into issues, filtering by status, measuring resolution time. Each ticket gets a human-readable 12-digit ticket number for display in system messages and the admin panel.

| Column        | Purpose                                                                                                                                                                                                                                                                              |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| id            | UUID primary key                                                                                                                                                                                                                                                                     |
| user_id       | FK → user.id (the user who initiated the ticket)                                                                                                                                                                                                                                     |
| app           | Which app the ticket was created from: `mentee` or `mentor` (default: `mentee`)                                                                                                                                                                                                      |
| ticket_number | BIGINT, NOT NULL, auto-generated from sequence `support_ticket_number_seq` (starts at 100000000001). Unique constraint. Display-only 12-digit number shown in system messages ("Ticket opened · #100000000001") and admin panel. UUID remains the primary key for all FK references. |
| status        | Enum support_ticket_status: `open`, `resolved`                                                                                                                                                                                                                                       |
| created_at    | When the ticket was auto-created                                                                                                                                                                                                                                                     |
| resolved_at   | When admin resolved the ticket (null while open)                                                                                                                                                                                                                                     |
| resolved_by   | FK → user.id (the admin who resolved, nullable)                                                                                                                                                                                                                                      |

A new ticket is auto-created by the backend when a user sends a message and no open ticket exists for that app. Only one ticket can be open per user per app at a time — enforced at the database level via a partial unique index on `(user_id, app) WHERE status = 'open'`. The `app` value is extracted from the JWT `app` claim, so the same user has separate support threads for the mentee and mentor apps. When resolved, a "Ticket resolved · #${ticketNumber}" system message is inserted into the thread. The next user message auto-creates a new ticket with a "Ticket opened · #${ticketNumber}" system message.

### support_message

All support chat messages for all users, stored in a single table. Queried by `user_id` with cursor-based pagination (newest first). The single-thread-per-user model means scrolling up shows the complete support history — past resolved tickets are visually separated by system messages.

| Column      | Purpose                                                                                         |
| ----------- | ----------------------------------------------------------------------------------------------- |
| id          | UUID primary key                                                                                |
| user_id     | FK → user.id (which user's thread this belongs to)                                              |
| ticket_id   | FK → support_ticket.id (groups messages by ticket for admin panel, nullable for legacy data)    |
| sender_type | Enum support_sender_type: `user` (mentee/mentor), `admin` (support agent), `system` (automated) |
| sender_id   | FK → user.id (the sender's user ID, null for system messages)                                   |
| content     | Message text                                                                                    |
| type        | `text` for regular messages, `system` for boundary markers ("Ticket opened", "Ticket resolved") |
| created_at  | Timestamp                                                                                       |

**Real-time delivery:** When the admin sends a reply, the backend calls `pushToUser()` — the same WebSocket + FCM dual-delivery used for session messages. If the user's app is open, the message appears instantly via WebSocket. If not, FCM delivers a push notification.

**Key differences from session chat (DynamoDB):** Support messages use PostgreSQL because the access pattern is different — low write frequency (async, not real-time dual-party), relational admin queries (join with user profiles, filter by ticket status), and no need for DynamoDB's burst throughput. Session messages stay in DynamoDB because they need high-frequency writes from two simultaneous users during live sessions.

---

## 9. Promotions & Free Chat

### mentee_promo_status

One row per mentee, created during onboarding. Tracks lifetime promo entitlements. Both flags start as FALSE and flip to TRUE when the corresponding session reaches `active` status. Once TRUE, they never revert — even if the mentee ends the session early. These are **entitlements, not first-session rules** — if a mentee's first paid session is with an opted-out mentor, `intro_session_used` stays FALSE and the discount carries forward.

| Column                | Purpose                                                         |
| --------------------- | --------------------------------------------------------------- |
| user_id               | PK and FK → user.id                                             |
| free_chat_used        | TRUE once a free chat session reaches active status             |
| free_chat_session_id  | FK → session.id — which session consumed the free chat          |
| free_chat_used_at     | When the free chat was consumed                                 |
| intro_session_used    | TRUE once a discounted intro-rate session reaches active status |
| intro_session_id      | FK → session.id — which session consumed the intro discount     |
| intro_session_used_at | When the intro discount was consumed                            |
| created_at            | Timestamp                                                       |

### mentor_free_chat_quota

Daily counter per mentor. Composite PK on (mentor_id, date) — a new row is created each day via UPSERT, no cron needed. The `max_count` column is per-mentor, allowing admins to customize individual quotas (e.g., some mentors get 10 slots, others 3). Old rows are safe to prune periodically — only the current day matters for quota checks.

| Column    | Purpose                                                            |
| --------- | ------------------------------------------------------------------ |
| mentor_id | FK → user.id (part of composite PK)                                |
| date      | DATE, defaults to CURRENT_DATE (part of composite PK)              |
| count     | How many free chats this mentor has done today                     |
| max_count | This mentor's daily cap (default 5, admin can override per mentor) |

### promo_config

Singleton table (single row, id=1 enforced by CHECK constraint). Admin-tunable parameters for all promo features. Editable via admin panel — no code deploy needed to change values.

| Column                  | Purpose                                                                                                                         |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| id                      | INT PK, always 1 (CHECK constraint)                                                                                             |
| free_chat_enabled       | Global kill switch for the free chat feature                                                                                    |
| free_chat_duration_secs | Max duration of a free chat session (default 180 = 3 min)                                                                       |
| free_chat_timeout_secs  | Seconds a mentor has to accept before auto-forward (default 10)                                                                 |
| intro_rate_enabled      | Global kill switch for the intro rate feature                                                                                   |
| intro_max_minutes       | Max duration of an intro rate session in minutes (default 5). Session auto-ends at this limit — no continuation at normal rate. |
| mentor_daily_free_cap   | Default daily free chat cap per mentor (default 5)                                                                              |
| updated_at              | Last time config was changed                                                                                                    |

---

## 10. Enums Reference

### user_role

`mentee` · `mentor` · `admin` · `platform`

Assigned at registration. The `platform` role is reserved for the system account.

### account_status

`active` · `suspended` · `banned` · `soft_deleted` · `hard_deleted`

`soft_deleted`: Account deactivated, 30-day grace period. User can restore by logging back in. `hard_deleted`: PII stripped, account permanently deleted. User row kept for FK integrity.

### auth_method

`truecaller_oauth` · `truecaller_otp` · `truecaller_missed_call`

### gender

`male` · `female` · `other`

### session_status

`pending` → `requested` → `active` → `completed`

Alternate terminal states: `cancelled` (by mentee), `rejected` (by mentor), `timed_out` (no response within 60 seconds).

### session_mode

`chat` · `audio` · `video`

Used in both `session.requested_session_type` and `session_segment.type`.

### billing_type

`paid` · `free_intro` · `intro_rate`

Set on `session.billing_type` at session creation time. `paid` is the default for normal sessions. `free_intro` means no billing at session end. `intro_rate` means the session is billed at a discounted rate (mentor's base rate × (1 - intro_discount_percent/100)) for its entire duration up to `intro_max_minutes`, then auto-ends — no continuation at normal rate.

### step_status

`locked` · `in_progress` · `done` · `action_required`

Used for mentor application steps.

### submission_status

`in_progress` · `under_review` · `action_required` · `rejected` · `approved`

Overall status of a mentor application.

### report_status

`pending` · `reviewed` · `dismissed`

### admin_action

`warning` · `suspended` · `banned`

### review_action

`approve` · `reject` · `request_changes`

Used in review_history for admin actions on mentor applications.

### support_ticket_status

`open` · `resolved`

Used in support_ticket for tracking ticket lifecycle.

### support_sender_type

`user` · `admin` · `system`

Used in support_message to identify who sent a message — the app user, an admin from the panel, or the system (automated boundary markers).

### payout_status

`pending` · `processing` · `completed` · `failed`

Tracks payout lifecycle. See Section 5 for state transitions.

### payout_method

`manual_neft` · `manual_imps` · `manual_upi` · `razorpay_payout` · `razorpay_link`

Records how the payout was (or will be) executed. v1 uses `manual_*` variants. RazorpayX integration adds `razorpay_payout` and `razorpay_link` without schema changes.

### verification_method (text, not formal enum)

`manual` · `razorpay_forward` · `razorpay_reverse` · `cashfree` · `surepass` · `karza`

Stored as TEXT with a CHECK constraint on `mentor_payout_account.verification_method`. Allows new providers to be added without DDL changes.

---

## 11. Key Data Flows

### Mentee Onboarding

1. User registers via Truecaller (or Firebase Phone Auth OTP fallback) → `user` row created with role `mentee`.
2. User completes profile → `mentee_profile` row created.
3. User selects categories → `user_mentorship` rows created with `role = 'mentee'`.
4. User adds education (optional) → `education` rows created with `role = 'mentee'`.
5. User selects languages → `user_language` rows created with `role = 'mentee'`.
6. `mentee_profile.onboarding_completed_at` is set.
7. `wallet` row created with type `mentee` and balance 0.
8. `mentee_promo_status` row created with `free_chat_used = FALSE` and `intro_session_used = FALSE`.
9. `mentee_privacy_settings` row created with defaults (`show_name_in_reviews = TRUE`, all four block/restrict flags = FALSE).

### Mentor Onboarding

1. User registers (or existing mentee applies) → `mentor_profile` row created, `mentorship_application` row created with `step1_status = in_progress`.
2. Step 1 — Identity: Personal details saved to `mentor_profile` (first_name, last_name) and `user` (dob, gender). Languages saved to `user_language` with `role = 'mentor'`. Aadhaar PDF uploaded to S3 (`aadhaar/{userId}/...`) and confirmed in `identity_verification`. Selfie uploaded to S3 (`selfies/{userId}/selfie.jpg`) and confirmed. Step marked `done`, step 2 unlocked.
3. Step 2 — Mentorship: Categories selected → `user_mentorship` rows with `role = 'mentor'`. Education added → `education` rows with `role = 'mentor'` (with optional document upload to S3 via presigned URL). Experience added → `experience` rows (text only, no document upload, no role column — mentor-only table). Optional notes saved to `mentorship_application.notes`.
4. Application submitted → `submission_status = under_review`, `submitted_at` set.
5. Admin reviews → `review_history` row added. Status moves to `approved`, `rejected` (with cooldown), or `action_required` (with `pending_fixes` array populated).
6. On approval: `wallet` row created with type `mentor` and balance 0. Aadhaar PDF deleted from S3 (verification complete, raw document no longer needed). Four default `mentor_quick_reply` rows seeded for the mentor.

### Session Lifecycle

1. Mentee taps "Chat" or "Call" on a mentor → `session` created. If mentor is busy, status = `pending` (queued). Otherwise status = `requested` and a 60-second EventBridge timeout schedule is created.
2. System checks mentee wallet balance ≥ minimum (rate × 5 minutes).
3. Mentor gets push notification (WebSocket primary, FCM fallback).
4. Mentor accepts → status `active`, `started_at` set, one `session_segment` row created with the session type and rate. An AWS Step Functions timeout is started based on mentee's remaining balance. A "Session started" system message is persisted to DynamoDB and pushed to both users.
5. Per-minute billing runs. If mentee balance runs out, Step Functions triggers session auto-end.
6. Session ends → status `completed`, `ended_at` set, segment closed with duration. Billing calculated: `CEIL(duration_seconds / 60) × rate_per_minute`. Video sessions use 1.5× the base rate.
7. Three `transaction` rows created atomically: session_payment (mentee debit), session_earning (mentor credit at 50%), platform_fee (platform credit at 50%).
8. Wallet balances updated atomically. Step Functions execution cancelled.
9. A "Session ended" system message persisted to DynamoDB and pushed to both users.
10. Mentee is prompted to leave a `review`.
11. If there are pending (queued) sessions for this mentor, the next one is promoted to `requested` with a fresh timeout.

### Wallet Top-Up

1. Mentee initiates recharge → Razorpay order created.
2. On payment success (Razorpay payment ID received) → two `transaction` rows: `wallet_topup` credit to mentee wallet, `platform_cash` debit from platform account.
3. `wallet.balance` incremented atomically.

### Mentor Payout Cycle

1. EventBridge cron runs at 10:00 IST on the 7th of each month, triggering the `mentortalk-generate-payouts` Lambda.
2. Lambda finds eligible mentors via:

   ```sql
   SELECT u.id, w.id AS wallet_id, w.balance, mpa.*
   FROM "user" u
   JOIN wallet w ON w.user_id = u.id AND w.type = 'mentor'
   JOIN mentor_payout_account mpa ON mpa.user_id = u.id
   WHERE w.balance >= :min_threshold        -- e.g., 500
     AND mpa.bank_verified = TRUE
     AND mpa.pan_verified = TRUE
     AND mpa.bank_verified_at < NOW() - INTERVAL '48 hours'  -- cooldown
     AND u.account_status = 'active';
   ```

3. For each eligible mentor, creates a `payout` row with `status = 'pending'`, snapshotting bank/PAN/period. Wallet balance NOT debited yet.
4. Admin opens admin panel's Pending Payouts queue, clicks "Mark as paid" per row.
5. Admin enters UTR + payment method in the modal. Backend updates `payout`: `status = 'completed'`, `utr`, `completed_at`, `initiated_by`, `method`.
6. Same transaction creates a `transaction` row: `type = 'payout'`, `direction = 'debit'`, `wallet_id` = mentor wallet, `amount = gross_amount`, `reference_id = payout.id`, `status = 'completed'`. Wallet balance decremented atomically.
7. (Future, when TDS activated) A second `transaction` row created: `type = 'tds_deduction'`, `direction = 'debit'`, `amount = tds_amount`, `reference_id = payout.id`. CA exports these quarterly for Form 26Q.
8. Mentor sees the completed payout in their app's Payouts History screen.

**Failure handling:** if admin clicks "Mark as failed" with a reason, payout row gets `status = 'failed'`, `failure_reason`, `failed_at`. No `transaction` row created. Wallet balance remains untouched. Admin can retry by manually triggering a new payout for the same mentor.

**Manual override:** admin panel has a "Generate payouts now" button for off-cycle runs (testing, missed cycle, urgent mentor request). Triggers the same Lambda outside the schedule.

### Three-Way Split

Every session payment is split into three atomic transactions:

- **Mentee pays**: `session_payment` / debit / from mentee wallet
- **Mentor earns**: `session_earning` / credit / to mentor wallet (50% of gross)
- **Platform takes**: `platform_fee` / credit / to platform account (50% of gross)

The split is currently hardcoded at 50/50. The resulting amounts are stored in `session.total_amount`, `session.platform_fee`, and `session.mentor_earning`.

### Support Chat

1. User taps "Chat with us" FAB on the Help Center screen → `POST /support/messages` with their message.
2. Backend extracts the `app` claim from the JWT (`mentee` or `mentor`) and checks for an open `support_ticket` for this user and app. If none exists, auto-creates one with the `app` column set and a `ticket_number` auto-assigned from the sequence, inserts a "Ticket opened · #${ticketNumber}" system message, inserts a welcome message on the user's first-ever ticket for that app ("Hi! How can we help you today?"), then inserts the user's message. All messages are linked to the new ticket.
3. If an open ticket already exists for that app, the user's message is simply appended to the thread with the existing `ticket_id`.
4. Admin sees the ticket in the admin panel (`GET /admin/support/tickets?status=open`), opens the thread, and replies (`POST /admin/support/tickets/:id/messages`).
5. Admin's reply is inserted into `support_message` and delivered to the user via `pushToUser()` (WebSocket + FCM).
6. When resolved, admin hits resolve (`POST /admin/support/tickets/:id/resolve`) → "Ticket resolved · #${ticketNumber}" system message inserted, ticket status updated to `resolved`, `resolved_at` and `resolved_by` set.
7. Next time the user sends a message, a new ticket is auto-created silently (step 2 repeats).

### Free Chat Session

1. Mentee taps "Free Chat" → `POST /session/free-chat`.
2. Backend checks `mentee_promo_status.free_chat_used = FALSE` and `promo_config.free_chat_enabled = TRUE`.
3. Backend queries eligible mentors: online, `is_available = TRUE`, `free_chat_enabled = TRUE`, daily quota not exhausted, category overlap with mentee's `user_mentorship` rows (where `role = 'mentee'`). Shortlist of ~5 mentors stored in DynamoDB (`mentortalk-free-chat-queue`) with TTL.
4. Session created with `billing_type = 'free_intro'`, assigned to first candidate mentor.
5. Mentor gets push notification with 10-second accept window (from `promo_config.free_chat_timeout_secs`).
6. If mentor doesn't accept → `freeChatTimeout` Lambda fires, reassigns session to next candidate, creates new 10-second timeout. Mentee sees "Finding a mentor..." throughout.
7. If all candidates exhausted → session set to `timed_out`, mentee notified "No mentors available."
8. On accept → `mentee_promo_status.free_chat_used = TRUE`, `mentor_free_chat_quota.count` incremented via UPSERT, `session_segment` created with `rate_per_minute = 0`, SFN timeout set to `free_chat_duration_secs` (180s).
9. At 150s → system message warning "Free chat ending in 30 seconds."
10. At 180s → auto-end. No wallet transactions. Session marked `completed` with `total_amount = 0`, `platform_fee = 0`, `mentor_earning = 0`.
11. Mentee sees "Continue this chat" prompt. No disconnect grace period — if either party disconnects, session auto-ends immediately.

### Intro Rate Session

1. Mentee starts a normal chat session with any mentor via `POST /session/request`.
2. Backend checks `mentee_promo_status.intro_session_used = FALSE`, `promo_config.intro_rate_enabled = TRUE`, and `mentor_profile.intro_discount_percent IS NOT NULL`.
3. If all conditions met → discounted rate calculated as `mentor.rate_per_minute × (1 - mentor.intro_discount_percent / 100)`. Session created with `billing_type = 'intro_rate'`, single `session_segment` at the discounted rate. `mentee_promo_status.intro_session_used = TRUE` when session reaches `active`.
4. If mentor is opted out (`intro_discount_percent IS NULL`) → normal session, `billing_type = 'paid'`, mentee's entitlement preserved for a future session with an eligible mentor.
5. Minimum balance check uses the discounted rate × `intro_max_minutes`.
6. SFN timeout set to `promo_config.intro_max_minutes` (default 5 min). Session is completely self-contained at the discounted rate.
7. At `intro_max_minutes` → session auto-ends. No continuation at normal rate. System message: "Intro session ended." Billing: `CEIL(duration_seconds / 60) × discounted_rate`.
8. Three-way transaction split uses the gross amount from the single segment.

---

## 12. Foreign Key Map

All foreign key relationships, organized by target table:

**→ user.id** (referenced by 20+ columns across 22 tables):
`admin_action_log.admin_id`, `admin_action_log.target_user_id`, `block.blocker_id`, `block.blocked_id`, `education.user_id`, `experience.user_id`, `follow.mentee_id`, `follow.mentor_id`, `identity_verification.user_id`, `mentee_profile.user_id`, `mentee_promo_status.user_id`, `mentee_privacy_settings.user_id`, `mentor_bank_account_history.mentor_id`, `mentor_bank_account_history.verified_by`, `mentor_bank_account_history.changed_by`, `mentor_free_chat_quota.mentor_id`, `mentor_payout_account.user_id`, `mentor_payout_account.bank_verified_by`, `mentor_payout_account.pan_verified_by`, `mentor_profile.user_id`, `mentor_quick_reply.user_id`, `mentorship_application.user_id`, `payout.mentor_id`, `payout.initiated_by`, `rate_history.user_id`, `refresh_token.user_id`, `report.reporter_id`, `report.reported_id`, `report.reviewed_by`, `review.mentor_id`, `review.mentee_id`, `review_history.reviewer_id`, `session.mentor_id`, `session.mentee_id`, `support_ticket.user_id`, `support_ticket.resolved_by`, `support_message.user_id`, `support_message.sender_id`, `transaction.user_id`, `user_language.user_id`, `user_mentorship.user_id`, `wallet.user_id`

**→ session.id**: `review.session_id`, `session_segment.session_id`, `transaction.session_id`, `mentee_promo_status.free_chat_session_id`, `mentee_promo_status.intro_session_id`

**→ support_ticket.id**: `support_message.ticket_id`

**→ wallet.id**: `transaction.wallet_id`, `payout.wallet_id`

**→ mentor_bank_account_history.id**: `payout.bank_account_history_id`

**→ mentorship_application.id**: `review_history.application_id`

**→ mentorship_category.id**: `mentorship_option.category_id`, `user_mentorship.mentorship_category_id`

**→ mentorship_option.id**: `user_mentorship.mentorship_option_id`

**→ rate_tier.id**: `mentor_profile.unlocked_tier_id`

**→ language.code**: `user_language.language_code`

---

## 13. Infrastructure — DynamoDB & S3

### DynamoDB Tables

**mentortalk-messages**
Stores all chat messages for every session — user-sent text messages, media messages (audio, image, file), and system-generated event messages (e.g., "Chat started", "Audio call ended", "Mentor ended the chat").

| Attribute         | Purpose                                                                                                                                                                                                                                                                                 |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| session_id (PK)   | Partition key — groups all messages by session                                                                                                                                                                                                                                          |
| message_id (SK)   | Sort key — unique message identifier (format: `msg_{timestamp_base36}_{suffix}`)                                                                                                                                                                                                        |
| sender_id         | User UUID who sent the message, or `"system"` for system events                                                                                                                                                                                                                         |
| content           | Message text content. Empty string for media-only messages.                                                                                                                                                                                                                             |
| type              | `"text"` for text messages, `"system"` for system events, `"audio"` for voice notes, `"image"` for photos, `"file"` for file attachments                                                                                                                                                |
| system_event      | For system messages: `chat_started`, `audio_started`, `video_started`, `chat_ended`, `audio_ended`, `video_ended`                                                                                                                                                                       |
| metadata          | Optional JSON string (e.g., `{"duration_seconds": 120}` for call-ended events)                                                                                                                                                                                                          |
| media_url         | S3 key for media content (audio/image/file). Only present on media messages. Served to clients as presigned GET URLs with 1-hour expiry — never as public CDN URLs, since chat media is private between session participants.                                                           |
| media_metadata    | JSON string with type-specific metadata. For audio: `{"duration_seconds": 12, "waveform": [0.1, 0.4, ...]}`. For image: `{"width": 1080, "height": 1920}`. For file: `{"file_name": "notes.pdf", "file_size": 204800, "mime_type": "application/pdf"}`. Only present on media messages. |
| client_message_id | Client-generated ID for deduplication                                                                                                                                                                                                                                                   |
| created_at        | ISO 8601 timestamp                                                                                                                                                                                                                                                                      |

Messages are queried by session_id (newest-first by default) with cursor-based pagination. The client fetches via `GET /session/:id/messages` with `limit`, `order`, and `last_key` parameters. Media URLs in REST responses and WebSocket forwards are presigned S3 GET URLs (1-hour expiry), not raw S3 keys. When sending a message via WebSocket, the client sends the raw S3 key in `media_url`; the backend converts it to a presigned URL before forwarding to the recipient.

**Contact info detection:** The WebSocket message handler (`mentortalk-ws-default`) runs server-side detection for phone numbers and email addresses in text messages. If detected, the content is masked (replaced with asterisks), the original content is stored in `original_content`, the detected pattern in `detected_pattern`, and a `flagged = true` attribute is set. A report is auto-created in the PostgreSQL `report` table via the platform account. Contact info detection is skipped for non-text message types (audio, image, file).

**mentortalk-connections**
Maps user IDs to their active WebSocket connection. Ephemeral — rows only exist while the user has an active WebSocket connection.

| Attribute     | Purpose                             |
| ------------- | ----------------------------------- |
| user_id (PK)  | Partition key                       |
| connection_id | API Gateway WebSocket connection ID |

Used by the `pushToUser` helper to send real-time events. If the WebSocket push fails (stale connection), the system falls back to FCM.

**mentortalk-presence**
Tracks online/offline status for each user. Updated when WebSocket connects/disconnects and when sessions start/end.

| Attribute    | Purpose                      |
| ------------ | ---------------------------- |
| user_id (PK) | Partition key                |
| status       | `"online"` or `"in_session"` |
| last_seen    | ISO 8601 timestamp           |

Used during session requests to check if the mentor is online before sending a push notification.

**mentortalk-presence-subscriptions**
Tracks which users are subscribed to another user's presence updates. When a user's presence changes, all subscribers are notified via WebSocket.

| Attribute           | Purpose                                    |
| ------------------- | ------------------------------------------ |
| target_user_id (PK) | Partition key — the user being watched     |
| subscriber_id (SK)  | Sort key — the user receiving updates      |
| connection_id       | WebSocket connection ID for the subscriber |
| created_at          | ISO 8601 timestamp                         |

**mentortalk-free-chat-queue**
Ephemeral table for managing the auto-forward candidate list during free chat matching. Rows are created when a mentee taps "Free Chat" and auto-expire via TTL after the forwarding window closes. No sort key — each session has exactly one forwarding queue.

| Attribute            | Purpose                                                     |
| -------------------- | ----------------------------------------------------------- |
| session_id (PK)      | Partition key — the session being matched                   |
| remaining_mentors    | List of mentor user_ids still available for forwarding      |
| current_mentor_index | Which mentor in the list is currently being tried           |
| created_at           | ISO 8601 timestamp                                          |
| ttl                  | Unix epoch timestamp for DynamoDB TTL auto-deletion (5 min) |

### S3 Storage

All user-uploaded files are stored in the bucket `mentortalk-storage-prod`. Files are uploaded via presigned URLs generated by backend Lambdas. Profile photos and banners are served via CDN (`CDN_BASE_URL` environment variable). Chat media is served via presigned GET URLs with 1-hour expiry (private between session participants). Database columns store S3 keys (not full URLs), and full URLs are constructed at runtime.

| S3 Path Pattern                                 | File Type                | Referenced By                                                          | Lifecycle                                                                                                                                                         | Access    |
| ----------------------------------------------- | ------------------------ | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| `aadhaar/{userId}/{timestamp}-{filename}`       | Aadhaar PDF              | `identity_verification.aadhaar_pdf_url`                                | Uploaded during mentor onboarding step 1. Deleted from S3 once admin verifies it (raw document no longer needed; `aadhaar_verified` flag retained).               | Presigned |
| `selfies/{userId}/selfie.jpg`                   | Verification selfie      | `identity_verification.selfie_url`                                     | Uploaded during mentor onboarding step 1. Retained until account deletion.                                                                                        | Presigned |
| `education/{userId}/{timestamp}-{filename}`     | Education proof document | `education.document_url`                                               | Uploaded via `/onboarding/education/presign`. Explicitly deleted from S3 when the education entry is deleted via the API.                                         | Presigned |
| `profile-photos/{userId}/{uuid}.{ext}`          | Profile avatar           | `mentee_profile.profile_photo_url`, `mentor_profile.profile_photo_url` | Uploaded during profile setup. Old photo deleted from S3 when replaced. Retained until account deletion.                                                          | CDN       |
| `chat-media/{sessionId}/{timestamp}-{filename}` | In-session media         | `mentortalk-messages.media_url` (DynamoDB)                             | Uploaded during active sessions via `POST /session/:id/presign-upload`. Audio (.m4a), images (.jpg/.png), files (any type). Private between session participants. | Presigned |
| PAN document path                               | PAN card image           | `mentor_payout_account.pan_document_url`                               | Uploaded during payout account setup. Retained until account deletion (needed for TDS compliance until final payout).                                             | Presigned |

Banner images (`banner.image_url`) are platform content and are not affected by user account deletion.
