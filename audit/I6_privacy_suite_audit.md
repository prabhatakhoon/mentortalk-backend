# I6 Privacy Suite — Backend Audit

Repo root: `C:\Users\h5cd2\workspace\mentortalk\lambda\`
Audit performed: 2026-05-02
Purpose: gather exact handler details before writing the I6 implementation plan.

Paths are repo-relative unless stated otherwise.

---

## Q1 — Mentor messages handler

- **Route:** `GET /mentor/mentees/:menteeId/messages`
- **File:** `mentortalk-mentor/mentorHandler.js`
- **Function:** `getMenteeMessages`
- **Storage layer:** Direct DynamoDB query against `mentortalk-messages`. **No service/repo abstraction.**

**Scoping flow:** Postgres-first, then DynamoDB per session.

```js
// 1) Find all (mentor, mentee) sessions in Postgres
const { rows: sessionRows } = await db.query(
  `SELECT id, started_at, ended_at,
          EXTRACT(EPOCH FROM (ended_at - started_at))::int AS duration_seconds
   FROM session
   WHERE mentor_id = $1 AND mentee_id = $2 AND status IN ('completed', 'active')
   ORDER BY started_at ASC`,
  [userId, menteeId],
);

// 2) Pull messages for each session from DynamoDB by primary key
await Promise.all(
  sessionRows.map(async ({ id: sessionId }) => {
    const result = await dynamoClient.send(
      new QueryCommand({
        TableName: "mentortalk-messages",
        KeyConditionExpression: "session_id = :sid",
        ExpressionAttributeValues: { ":sid": sessionId },
        ScanIndexForward: true,
      }),
    );
    // ...
  }),
);
```

**Per-message response includes `session_id`:** YES.

```js
{
  message_id, session_id, sender_id, content,
  type: "text" | "system" | "audio_call" | "video_call" | ...,
  created_at, client_message_id
}
```

**I6 implication:** filter by `session_id`. The active session is identifiable from the Postgres step (status = `'active'`); everything else is "past." For `mentor_chat_access = OFF`, drop content for past-session messages where `type != 'system'` (or replace `content` with null).

---

## Q2 — Reviews handlers

### Mentee-facing (mentor profile reviews list)

- **Route:** `GET /mentee/discover/mentor-profile/reviews` (or equivalent)
- **File:** `mentortalk-mentee-discover/index.js`
- **Function:** `getMentorReviews`

```sql
SELECT
  r.id, r.rating, r.comment, r.session_id,
  s.started_at AS session_date, r.created_at,
  mp.first_name AS mentee_first_name,
  mp.last_name  AS mentee_last_name,
  mp.profile_photo_url AS mentee_photo_url
FROM review r
JOIN session s ON s.id = r.session_id
JOIN mentee_profile mp ON mp.user_id = r.mentee_id
WHERE r.mentor_id = $1
ORDER BY r.created_at DESC
LIMIT $2 OFFSET $3
```

```js
{
  id, rating, comment, session_id, session_date,
  mentee: {
    name: [first_name, last_name].filter(Boolean).join(" ") || "Mentee",
    avatar: resolvedPhotoUrl
  },
  modes: [],
  created_at
}
```

**Mentee display name field:** `mentee.name`.

### Mentor's own received-reviews

- **Route:** `GET /mentor/reviews`
- **File:** `mentortalk-mentor/mentorHandler.js`
- **Function:** `getReviews`

```sql
SELECT
   r.id, r.rating, r.comment, r.created_at, r.session_id,
   s.started_at AS session_date,
   mtp.first_name AS mentee_first_name,
   mtp.last_name  AS mentee_last_name,
   mtp.profile_photo_url AS mentee_avatar,
   array_agg(DISTINCT ss.type) FILTER (WHERE ss.type IS NOT NULL) AS modes
 FROM review r
 JOIN session s ON s.id = r.session_id
 JOIN "user" u ON u.id = r.mentee_id
 LEFT JOIN mentee_profile mtp ON mtp.user_id = r.mentee_id
 LEFT JOIN session_segment ss ON ss.session_id = s.id
 WHERE r.mentor_id = $1
 GROUP BY r.id, s.started_at, mtp.first_name, mtp.last_name, mtp.profile_photo_url
 ORDER BY r.created_at DESC
 LIMIT $2 OFFSET $3
```

```js
{
  id, rating, comment, session_id, session_date,
  mentee: {
    name: [mentee_first_name, mentee_last_name].filter(Boolean).join(" "),
    avatar: toFullUrl(mentee_avatar),
  },
  modes, created_at
}
```

**Mentee display name field:** `mentee.name`.

### Shared service / query?

**No.** Two separate handlers in two separate Lambdas. SQL and DTO assembly are duplicated. The privacy filter (`show_name_in_reviews = FALSE → mentee.name = null`) must be applied **in both places**.

To support the filter, both queries need to add `LEFT JOIN mentee_privacy_settings mps ON mps.user_id = r.mentee_id` and check `COALESCE(mps.show_name_in_reviews, TRUE)`.

---

## Q3 — Media presign handler

- **File:** `mentortalk-session/src/sessionHandler.js`
- **Upload presign function:** `handlePresignUpload` (~line 2859) — issues presigned PUT URL.
- **Download presign:** **inline** in `handleGetMessages` (~line 359) — no standalone GET endpoint, no service layer.

**Inline GET presign:**

```js
if (item.media_url) {
  msg.media_url = await getSignedUrl(
    s3Client,
    new GetObjectCommand({
      Bucket: BUCKET_NAME,
      Key: item.media_url,
    }),
    { expiresIn: 3600 },
  );
}
```

**Auth check (download path, ~line 318):**

```js
const sessionResult = await db.query(
  `SELECT id FROM session
   WHERE id = $1 AND (mentee_id = $2 OR mentor_id = $2)`,
  [sessionId, userId],
);
```

**Verifies the requester is a session participant only.** No status filter — past-session media is currently fetchable by either party.

**Auth check (upload path, ~line 2876):** Same query but with `AND status = 'active'` — uploads only allowed during live session.

**I6 implication:** For `mentor_download_access = OFF`, the presign-on-read path in `handleGetMessages` needs to gate on `(requester is mentor) AND (session_id != active_session_id) AND (mentee.privacy.mentor_download_access = FALSE)`. **The mentor-side `getMenteeMessages` (Q1) does NOT currently presign media** — verify before relying on this; if it ever starts returning media URLs it'll need the same gate.

**Net-new: a media presign service.** All presign code is inline.

---

## Q4 — Mentee profile / `/me` payload

- **File:** `mentortalk-mentee-profile/index.mjs`
- **Function:** `getProfile`
- **Route:** `GET /mentee/profile`

```js
{
  (username,
    display_name, // first_name + last_name, or first_name alone
    wallet_balance, // default 0
    phone_number,
    profile_photo_url); // resolved S3 URL or null
}
```

**Slot for privacy_settings:** add as a top-level object on the same response.

```js
{
  username, display_name, wallet_balance, phone_number, profile_photo_url,
  privacy_settings: {
    show_name_in_reviews,
    mentor_chat_access,
    mentor_download_access,
    block_screenshots,
    block_call_recording,
  }
}
```

The Flutter `UserResponse` model can be extended with a nested `PrivacySettings` object cleanly.

**Side note (unrelated bug):** `mentortalk-mentee-profile/index.mjs` references `getFollowing` at ~line 1062 but no such function is defined. Worth filing separately — not in scope for I6.

---

## Q5 — Mentor's view of mentee data (session-active context)

### REST response when mentor accepts session (`POST /session/:id/accept`)

- **File:** `mentortalk-session/src/sessionHandler.js`
- **Function:** `handleSessionAccept` (~line 636)
- Status transition: `requested` → `active` (~line 664)

**Mentor REST response:**

```js
{
  session_id, status: "active", session_type, billing_type,
  rate_per_minute, mentee_balance, max_duration_seconds,
  pref_audio, pref_video,
  agora_channel, agora_token, agora_uid, agora_app_id   // audio/video only
}
```

> Notable: this payload contains **no mentee object at all** — no name, no avatar, no flags. The mentor app must already be loading the mentee from another endpoint (Q7's `getMentees` row, or a detail fetch).

### WebSocket payload at activation (sent to BOTH parties)

Pushed via `pushToUser` (~line 780):

```js
{
  type: "new_message",
  message_id, session_id,
  sender_id: "system",
  content: "Chat started" | "Audio call started" | "Video call started",
  created_at
}
```

No dedicated `session_active` event — activation is signaled by the system message above.

### Mentee object shape in `GET /mentor/sessions` (history)

- **File:** `mentortalk-mentor/mentorHandler.js`
- **Function:** `getSessions`

```js
{
  id, status, started_at, ended_at,
  mentee: { id, name, avatar, categories },
  modes, total_duration_seconds, mentor_earning, review_rating
}
```

**I6 implication:** `block_screenshots` and `block_call_recording` need to ride on the mentee object **everywhere the mentor app renders mentee context** — at minimum:

- `getMentees` row (Q7) — for the mentee detail screen (FLAG_SECURE outside live session)
- `handleSessionAccept` REST response — currently has no mentee object; need to add one, OR push the privacy flags as a top-level field
- WebSocket session-start system message — currently has none; either extend it or push a separate `privacy_snapshot` event right before/after

Recommend: bake `mentee.privacy = { block_screenshots, block_call_recording }` into both `getMentees` and `getSessions` rows, and into `handleSessionAccept`'s REST response. Then the WS layer only needs to handle live toggle changes (Q10).

---

## Q6 — Active session lookup

**Session statuses (from code + `schema.md`):**

- `pending` — mentee requested, mentor busy (queued)
- `requested` — request sent, 60s timeout active
- `active` — live, billing
- `completed` — ended normally
- `cancelled` — mentee cancelled
- `rejected` — mentor declined
- `timed_out` — mentor didn't respond

**Chat content flow:** Only `active` surfaces real chat. `requested`/`pending` carry no message content; the first system message ("Chat started") is written when status flips to `active`. So `mentor_chat_access` filter only needs to check `session.status = 'active'` to identify "current session = leave alone."

**Existing helper:** `handleGetActiveSession` (`mentortalk-session/src/sessionHandler.js` ~line 2714) returns the active/requested/pending session for **a single user**:

```sql
SELECT ... FROM session s
JOIN mentor_profile mp ON ...
LEFT JOIN mentee_profile mtp ON ...
WHERE (s.mentee_id = $1 OR s.mentor_id = $1)
  AND s.status IN ('requested', 'pending', 'active')
ORDER BY s.started_at DESC LIMIT 1
```

**For (mentor_id, mentee_id) pair lookup: net-new.** No helper exists. The Q1 mentor-messages handler already does the equivalent in its scoping query — filter `sessionRows` to the one where `status = 'active'` and treat the rest as past. No new Postgres query needed if we piggyback on existing scoping.

---

## Q7 — Mentor home / recent sessions / mentee list endpoint

- **Route:** `GET /mentor/mentees`
- **File:** `mentortalk-mentor/mentorHandler.js`
- **Function:** `getMentees`

```js
{
  mentee_id, name, avatar,
  session_count, last_session_at,
  last_activity: {
    type: "text" | "system" | "audio_call" | "video_call",
    content: string  // truncated to 80 chars with "…" suffix
  }
}
```

Example values:

- `{ type: "text", content: "Sure, let me explain that more clearly…" }`
- `{ type: "audio_call", content: "Audio call started" }`
- `{ type: "system", content: "No messages yet" }`

> System "X ended the chat" messages are explicitly skipped during DynamoDB iteration when picking a preview.

**I6 implication — content leak:**
`last_activity.content` will leak past chat snippets into the mentor's home tab. Under `mentor_chat_access = OFF`, the filter must:

- If the source message is from a **past** session AND `type = "text"` → null out `content`, or replace with a placeholder ("Hidden by mentee").
- System messages and call markers can stay (they're metadata, not content).

Same pattern needed: privacy snapshot must be joined per-mentee (`LEFT JOIN mentee_privacy_settings ...`) and `last_activity` post-processed before serialization.

---

## Q8 — Privacy settings endpoints (net-new)

**Routing pattern (mentee-profile Lambda):** switch-on-path with `path.endsWith(...)`, ordered most-specific-first.

```js
if (method === "POST" && path.endsWith("/photo/presign")) { ... }
if (method === "PUT"  && path.endsWith("/edit-profile")) { ... }
if (method === "DELETE" && path.endsWith("/photo")) { ... }
if (method === "GET" && path.endsWith("/profile")) { ... }
```

**Recommendation — match existing style:**

- `GET /mentee/privacy-settings` → handler `getPrivacySettings(db, userId)`
- `PATCH /mentee/privacy-settings` → handler `updatePrivacySettings(db, userId, body)`

Both live in `mentortalk-mentee-profile/index.mjs` alongside `getProfile`.

```js
if (method === "GET" && path.endsWith("/privacy-settings")) {
  return await getPrivacySettings(db, userId);
}
if (method === "PATCH" && path.endsWith("/privacy-settings")) {
  const body = parseBody(event);
  return await updatePrivacySettings(db, userId, body);
}
```

Model after: `getProfile` / `updateEditProfile` in the same file (~lines 159–197 for `getProfile`).

---

## Q9 — Onboarding integration

- **File:** `mentortalk-mentee-onboarding/index.mjs`
- **Function:** `submitOnboarding`

Current transaction (after validation):

```js
await db.query(
  `UPDATE mentee_profile SET onboarding_completed_at = NOW(), updated_at = NOW() WHERE user_id = $1`,
  [userId],
);

await db.query(
  `INSERT INTO wallet (id, user_id, type, balance)
   VALUES (gen_random_uuid(), $1, 'mentee', 0)
   ON CONFLICT (user_id, type) DO NOTHING`,
  [userId],
);

await db.query(
  `INSERT INTO mentee_promo_status (user_id, free_chat_used, intro_session_used)
   VALUES ($1, FALSE, FALSE)
   ON CONFLICT (user_id) DO NOTHING`,
  [userId],
);
```

**Add immediately after the `mentee_promo_status` insert** (matches the spec's column list and defaults — only `show_name_in_reviews` defaults TRUE):

```js
await db.query(
  `INSERT INTO mentee_privacy_settings
     (user_id, show_name_in_reviews, mentor_chat_access, mentor_download_access,
      block_screenshots, block_call_recording)
   VALUES ($1, TRUE, FALSE, FALSE, FALSE, FALSE)
   ON CONFLICT (user_id) DO NOTHING`,
  [userId],
);
```

> Note: these are sequential `db.query` calls — they're NOT inside a `BEGIN/COMMIT` transaction in the current code. If atomicity matters, wrap with `BEGIN`/`COMMIT` as part of I6 (separate concern, flag with the user).
>
> Also: existing mentees won't have a row. Either backfill via the V005 migration (recommended — `INSERT ... SELECT user_id FROM mentee_profile ON CONFLICT DO NOTHING`) or have the `getPrivacySettings` handler fall back to defaults on missing row.

---

## Q10 — WebSocket push helper

- **File:** `mentortalk-session/src/sessionHandler.js`
- **Function:** `pushToUser` (~line 92)

```js
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
    } catch (err) {
      if (err.statusCode === 410) {
        /* stale conn */
      }
      console.error(`Failed to push to user ${userId}:`, err.message);
    }
  }

  if (fcmOptions) {
    await sendFcmNotification(userId, fcmOptions);
  }
}
```

**Existing event-type conventions** (snake_case `type` field):

- `new_message`
- `message_ack`
- `delivery_receipt`
- `read_receipt`
- `typing`
- `presence_update`
- `session_request`, `session_accepted`, `session_rejected`, `session_ended`
- `mode_switch_request`

**Recommended new type:** `privacy_changed`. Payload shape (model after `presence_update`):

```js
{
  type: "privacy_changed",
  user_id: <mentee user_id>,
  privacy_settings: {
    block_screenshots: bool,
    block_call_recording: bool
    // only the live-relevant flags need to push; chat/download/name flags don't need real-time
  }
}
```

**Precedent for cross-party preference push:** YES — `presence_update` (~line 157) broadcasts a user's availability/online state to all subscribers via a fan-out loop. The privacy push is narrower: only target the active-session counterparty (mentor), and only when `block_screenshots`/`block_call_recording` change. Lookup the active session's mentor via existing `handleGetActiveSession` pattern, then `pushToUser(mentorId, payload)`.

---

## Q11 — Migration conventions

**⚠️ Migrations live OUTSIDE the lambda repo.** They're in the sibling `source/mentortalk` repo:

- `C:\Users\h5cd2\workspace\mentortalk\source\mentortalk\backend\migrations\V003_free_chat_promo.sql`
- `C:\Users\h5cd2\workspace\mentortalk\source\mentortalk\docs\schema\migration\V004_role_scoping.sql`

The split between `backend/migrations/` and `docs/schema/migration/` is itself inconsistent — confirm with the user where V005 should land before committing.

**Most recent: V004 header/format**

```sql
-- ============================================================================
-- V004: Role-scoping for dual-role users
-- ============================================================================
-- Problem: [problem statement]
--
-- Solution: [solution statement]
-- ============================================================================

BEGIN;

-- ─── Section 1: <table name> ─────────────────────────────────────
-- <description>
<DDL/DML>

-- ─── Section 2: <table name> ─────────────────────────────────────
-- <description>
<DDL/DML>

-- ─── Track migration ──────────────────────────────────────────────
INSERT INTO schema_migrations (version, name, applied_at)
VALUES ('V004', 'role_scoping', NOW());

COMMIT;
```

**Next migration:** `V005_mentee_privacy_settings.sql`.

**Auto-applied?** No — no `apply-migrations.ps1` or equivalent runner found anywhere. Migrations are run manually. The `schema_migrations` table is used as a record but not a gating mechanism.

**Root `schema.md` summary:** Comprehensive PG + DynamoDB + S3 schema doc. Covers ~36 PG tables (users, profiles, sessions, billing, chat, moderation), 4 DDB tables (`mentortalk-messages`, `-connections`, `-presence`, free-chat queue), and S3 buckets for profiles/identity/in-session media. Documents dual-wallet design (mentee spend vs mentor earn), role-scoping, 50/50 transaction splits, free chat promos, and WS delivery patterns. Useful as the source of truth before designing V005.

---

## Summary — net-new items

| Item                                                                                     | Status                                                   |
| ---------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `mentee_privacy_settings` table                                                          | Net-new (V005)                                           |
| `getPrivacySettings` handler                                                             | Net-new                                                  |
| `updatePrivacySettings` handler                                                          | Net-new                                                  |
| Active-session lookup by (mentor_id, mentee_id)                                          | Net-new (or piggyback on Q1's existing scoping query)    |
| Media presign service abstraction                                                        | Net-new (all presign is inline)                          |
| `privacy_changed` WS event type                                                          | Net-new (model after `presence_update`)                  |
| Mentee `privacy` block on `getMentees` / `getSessions` / `handleSessionAccept` responses | Net-new field on existing payloads                       |
| `mentor_chat_access` filter on Q1 messages + Q7 `last_activity` preview                  | Net-new logic on existing handlers                       |
| `mentor_download_access` gate on inline media presign in `handleGetMessages`             | Net-new logic on existing handler                        |
| `show_name_in_reviews` filter on both Q2 review handlers                                 | Net-new logic, applied in two places (no shared service) |
| Onboarding `INSERT INTO mentee_privacy_settings`                                         | Net-new line in `submitOnboarding`                       |
| Backfill of existing mentees                                                             | Net-new (handle in V005)                                 |

## Items to clarify before writing the plan

1. **Migration repo location** — `backend/migrations/` vs `docs/schema/migration/`. Pick one for V005.
2. **Onboarding atomicity** — current inserts are NOT in a transaction. Wrap as part of I6, or leave?
3. **Existing mentees backfill** — confirm V005 backfills via `INSERT ... SELECT user_id FROM mentee_profile ON CONFLICT DO NOTHING`.
4. **`handleSessionAccept` response** — currently has no mentee object at all. Add `mentee.privacy = {...}` to REST response, or push a separate WS event right after activation? (Recommend: add to REST response — one round-trip, no race.)
5. **Reviews filter SQL vs application-layer** — apply `LEFT JOIN mentee_privacy_settings` and null-out in SQL, or fetch flat and null-out in JS? (Recommend: SQL join + `CASE WHEN` for consistency.)
6. **Unrelated bug:** `getFollowing` referenced at `mentortalk-mentee-profile/index.mjs:1062` but undefined. File separately.
