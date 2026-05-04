# I15 Session Endpoint Audit

Repo root: `C:\Users\h5cd2\workspace\mentortalk\lambda\`
Audit performed: 2026-05-03
Purpose: enumerate every HTTP endpoint that returns session data and measure each one against the deep-link revalidation target shape. Native clients re-call these after FCM hand-off to recompute countdowns, render strikethrough rates, and decide what to draw when the user lands inside a terminal-state race.

Paths are repo-relative unless stated otherwise. Read-only — no fixes.

Target shape recap (the "ideal" per endpoint, where applicable):

- `request_created_at` and/or `expires_at` so the client can render a live countdown without trusting `Date.now()` skew.
- `mentee.privacy` snapshot block: `{ block_screenshots: bool, block_call_recording: bool }`.
- `normal_rate_per_minute` whenever `billing_type === 'intro_rate'`, so the client can render the strikethrough-against-discounted-rate UI.
- Predictable, distinct HTTP status codes for terminal-state races: accept-on-timed-out, reject-on-completed, cancel-on-active, etc.

---

## Inventory

Twelve HTTP endpoints return session data across three Lambdas. The session Lambda owns ten; the mentor Lambda owns one read-mode listing endpoint plus a per-session detail endpoint; the mentee-profile Lambda owns one mentee-side detail endpoint. The mentee-discover Lambda has no session endpoints — its session references are review/aggregate counts only.

| #   | Method | Route                           | Lambda                  | Handler                       | File:Line                                        |
| --- | ------ | ------------------------------- | ----------------------- | ----------------------------- | ------------------------------------------------ |
| 1   | POST   | `/session/request`              | mentortalk-session      | `handleSessionRequest`        | `mentortalk-session/src/sessionHandler.js:419`   |
| 2   | POST   | `/session/free-chat`            | mentortalk-session      | `handleFreeChat`              | `mentortalk-session/src/sessionHandler.js:1640`  |
| 3   | GET    | `/session/free-chat/availability` | mentortalk-session    | `handleFreeChatAvailability`  | `mentortalk-session/src/sessionHandler.js:1846`  |
| 4   | POST   | `/session/:id/accept`           | mentortalk-session      | `handleSessionAccept`         | `mentortalk-session/src/sessionHandler.js:662`   |
| 5   | POST   | `/session/:id/reject`           | mentortalk-session      | `handleSessionReject`         | `mentortalk-session/src/sessionHandler.js:956`   |
| 6   | POST   | `/session/:id/cancel`           | mentortalk-session      | `handleSessionCancel`         | `mentortalk-session/src/sessionHandler.js:1173`  |
| 7   | POST   | `/session/:id/end`              | mentortalk-session      | `handleSessionEnd`            | `mentortalk-session/src/sessionHandler.js:1218`  |
| 8   | GET    | `/session/active`               | mentortalk-session      | `handleGetActiveSession`      | `mentortalk-session/src/sessionHandler.js:2796`  |
| 9   | POST   | `/session/:id/refresh-duration` | mentortalk-session      | `handleRefreshDuration`       | `mentortalk-session/src/sessionHandler.js:2656`  |
| 10  | POST   | `/session/:id/call/end`         | mentortalk-session      | `handleCallEnd`               | `mentortalk-session/src/sessionHandler.js:2350`  |
| 11  | GET    | `/mentor/sessions`              | mentortalk-mentor       | `getSessions`                 | `mentortalk-mentor/mentorHandler.js:661`         |
| 12  | GET    | `/session/:id/details`          | mentortalk-mentor       | `getSessionDetails`           | `mentortalk-mentor/mentorHandler.js:750`         |
| 13  | GET    | `/mentee/session/:id/details`   | mentortalk-mentee-profile | `getSessionDetails`         | `mentortalk-mentee-profile/index.mjs:1069`       |

> Note on mode-switch and review endpoints: `/session/:id/switch`, `/session/:id/switch/accept`, `/session/:id/switch/decline`, and `/session/:id/review` exist (router lines 262–282) but `schema.md:415` flags mode-switching as legacy/never-shipped and the response payloads carry no mentee identity or privacy state. They are listed in **Section 14 — Out of scope for deep-link revalidation** at the bottom for completeness but not gap-graded.

---

## 1) `POST /session/request` — `handleSessionRequest`

**File:** `mentortalk-session/src/sessionHandler.js:419`

**Status transition:** none → `requested` (or → `pending` if mentor busy).

**Response shape (HTTP 201):**

```js
{
  session_id: string,                       // uuid
  status: "requested" | "pending",
  mentor_name: string,
  mentor_avatar: string | null,
  session_type: "chat" | "audio" | "video",
  billing_type: "paid" | "intro_rate" | "free_intro",
  rate_per_minute: number,                  // discounted rate when intro_rate
  normal_rate_per_minute: number | undefined, // ONLY present when intro_rate (line 636)
  timeout_seconds: 60 | null,               // null when status='pending'
  queue_position: number | null,            // non-null only when status='pending'
  mentee_balance: number,
}
```

**Key code (line 627–644):**

```js
return respond(201, {
  session_id: session.id,
  status: session.status,
  mentor_name: `${mentor.first_name} ${mentor.last_name}`.trim(),
  mentor_avatar: toFullUrl(mentor.profile_photo_url),
  session_type,
  billing_type: billingType,
  rate_per_minute: billingType === 'intro_rate' ? introRatePerMinute : ratePerMinute,
  normal_rate_per_minute: billingType === 'intro_rate' ? ratePerMinute : undefined,
  timeout_seconds:
    sessionStatus === "requested" ? SESSION_REQUEST_TIMEOUT_SECONDS : null,
  queue_position:
    sessionStatus === "pending"
      ? await getQueuePosition(db, mentor_id, session.id)
      : null,
  mentee_balance: balance,
});
```

- `request_created_at` / `expires_at`: **NEITHER**. The client only gets `timeout_seconds: 60`. To compute an absolute expiry it must subtract from its own clock at receive time.
- `mentee.privacy` snapshot: **N/A — direction is mentee→mentor**, the response is the mentee's own confirmation. The mentor's parallel push payload (line 599–624) also lacks a privacy snapshot.
- `normal_rate_per_minute`: **PRESENT for intro_rate only** (line 636). Set to `undefined` (i.e. JSON-stripped) for paid/free_intro. Same key is also forwarded on the WS push to the mentor (line 611) and on the queue-promotion push (line 1615).
- Terminal-state races: not applicable — this is the creation endpoint. Pre-existing-session guard returns **409** with `{ error, session_id }` (line 530–535). Insufficient balance returns **402** (line 513). Mentor missing/unavailable returns **404** (line 454) or **400** (line 461–470). Wallet missing returns **402** (line 505).

**Gaps:** missing `request_created_at` (server-issued UTC timestamp at INSERT) and `expires_at` (UTC = NOW + 60s). Mentor-bound WS push at line 599 also lacks these. There is no mentee privacy block to forward here; not relevant on this hop.

---

## 2) `POST /session/free-chat` — `handleFreeChat`

**File:** `mentortalk-session/src/sessionHandler.js:1640`

**Status transition:** none → `requested` (free_intro flavor, 10s timeout, auto-forwards on reject).

**Response shape (HTTP 201):**

```js
{
  session_id: string,
  status: "requested",
  mentor_name: string,
  mentor_avatar: string | null,
  session_type: "chat",
  billing_type: "free_intro",
  timeout_seconds: number,                  // from promo_config.free_chat_timeout_secs
}
```

**Key code (line 1833–1841):**

```js
return respond(201, {
  session_id: sessionId,
  status: "requested",
  mentor_name: `${selectedMentor.first_name} ${selectedMentor.last_name}`.trim(),
  mentor_avatar: toFullUrl(selectedMentor.profile_photo_url),
  session_type: "chat",
  billing_type: "free_intro",
  timeout_seconds: cfg.free_chat_timeout_secs,
});
```

- `request_created_at` / `expires_at`: **NEITHER**.
- `mentee.privacy`: N/A (mentee creating own session).
- `normal_rate_per_minute`: N/A (`free_intro`, the rate is 0).
- Terminal-state races: same shape as `/session/request`. Already-used returns **409** (line 1663). Existing active/requested/pending session returns **409** (line 1672–1677). No eligible mentors returns **503** with `retry_after: 60` (line 1721, 1745). Feature disabled returns **400** (line 1646).

**Gaps:** missing `request_created_at` and `expires_at`. Free-chat timer is more aggressive (10s default vs 60s), so clock-drift on the client matters more here than anywhere else.

---

## 3) `GET /session/free-chat/availability` — `handleFreeChatAvailability`

**File:** `mentortalk-session/src/sessionHandler.js:1846`

Read-only eligibility check. Does not return session data; included for completeness.

```js
{
  available: boolean,
  mentor_count?: number,
  free_chat_duration_secs?: number,
  reason?: "feature_disabled" | "already_used" | "no_categories",
}
```

Always HTTP 200. **Out of revalidation scope** — there is no session yet to deep-link back to.

---

## 4) `POST /session/:id/accept` — `handleSessionAccept`

**File:** `mentortalk-session/src/sessionHandler.js:662`

**Status transition:** `requested` → `active`.

This is the primary deep-link target after a "Session Accepted" FCM lands on the mentor.

**Response shape (HTTP 200, lines 924–951):**

```js
{
  session_id: string,
  status: "active",
  session_type: "chat" | "audio" | "video",
  billing_type: "paid" | "intro_rate" | "free_intro",
  rate_per_minute: number,                  // 0 when free_intro
  mentee_balance: number,
  max_duration_seconds: number,
  min_duration_secs: number,                // env MIN_SESSION_DURATION_SECS, default 60
  pref_audio: boolean,
  pref_video: boolean,
  mentee: {
    privacy: {
      block_screenshots: boolean,
      block_call_recording: boolean,
    },
  },
  // audio/video only:
  agora_channel?: string,
  agora_token?: string,
  agora_uid?: number,
  agora_app_id?: string,
}
```

**Key code (line 915–941):**

```js
// Snapshot mentee privacy flags for the mentor app to apply FLAG_SECURE on
// the chat screen and call overlays from session-start onward.
const { rows: privacyRows } = await db.query(
  `SELECT block_screenshots, block_call_recording
     FROM mentee_privacy_settings WHERE user_id = $1`,
  [session.mentee_id]
);
const menteePrivacy = privacyRows[0] || { block_screenshots: false, block_call_recording: false };

const acceptResponse = {
  session_id: sessionId,
  status: "active",
  session_type: sessionType,
  billing_type: session.billing_type || 'paid',
  rate_per_minute: session.billing_type === 'free_intro' ? 0 : ratePerMinute,
  mentee_balance: menteeBalance,
  max_duration_seconds: maxDurationSeconds,
  min_duration_secs: minDurationSecs,
  pref_audio: session.pref_audio ?? true,
  pref_video: session.pref_video ?? true,
  mentee: {
    privacy: {
      block_screenshots: menteePrivacy.block_screenshots,
      block_call_recording: menteePrivacy.block_call_recording,
    },
  },
};
```

- `request_created_at` / `expires_at`: **NEITHER** — and they're not relevant after activation. However, no `started_at` is returned either, which would be the analogous "session began at" anchor a client needs for the live billing countdown (currently the client must derive it from `max_duration_seconds + Date.now()`).
- `mentee.privacy`: **PRESENT** (the only endpoint where it is). Defaults to `{false, false}` if no row exists. This matches the I6 spec.
- `normal_rate_per_minute`: **MISSING**. Lines 879–880 (mentee WS) and 929 (mentor REST) emit `rate_per_minute` only — when `billing_type === 'intro_rate'` the client cannot render the strikethrough on the now-active session. The Q5 prep query at line 700–706 computes `effectiveRate` from `intro_discount_percent` but does not surface `baseRate`.
- **Terminal-state race handling:** the SELECT (line 666–672) requires `status = 'requested'`. If the session timed out, was cancelled, or was already accepted, `sessionResult.rows.length === 0` and the handler returns **404 `"Session not found or not in requested state"`** (line 675). All three losing races collapse into the same 404.

**Gaps:** missing `started_at` echo (no anchor for active-session timer); missing `normal_rate_per_minute` for intro_rate strikethrough; mentee WS payload (line 874–897) lacks the privacy block (mentee's app doesn't need it but the symmetric "session_accepted" event delivered to the mentor app via WS would benefit if the FCM-then-fetch path is bypassed); 404-collapse on terminal races (no way for the mentor app to distinguish "you were too late" from "wrong session id").

---

## 5) `POST /session/:id/reject` — `handleSessionReject`

**File:** `mentortalk-session/src/sessionHandler.js:956`

**Status transition:** `requested` → `rejected` (or, for `free_intro`, attempts auto-forward to next queued mentor before falling through).

**Response shape:**

- Successful normal reject (HTTP 200, line 1168): `{ session_id, status: "rejected" }`
- Free-chat forward (HTTP 200, line 1105): `{ session_id, status: "forwarded" }`
- Free-chat exhausted (HTTP 200, line 1149): `{ session_id, status: "rejected" }`

- `request_created_at` / `expires_at`: **NEITHER** (not applicable after rejection — the session is terminal).
- `mentee.privacy`: **MISSING** (arguably not needed after reject, but if the client landed here from a deep-link expecting to re-render the request screen and getting "rejected" instead, no privacy snapshot is conveyed).
- `normal_rate_per_minute`: **MISSING** (irrelevant after rejection).
- **Terminal-state race handling:** the dual SELECT/UPDATE pair guards `status = 'requested'`. The first SELECT at line 960–963 returns 404 on no row (line 967). The follow-up UPDATE at line 1112–1117 also returns 404 on no row (line 1120) — defensive but unreachable in practice given the lock-free read-then-write. **All races (already accepted, cancelled, timed_out, completed) collapse into 404 `"Session not found or not in requested state"`** with the same body shape as accept.

**Gaps:** 404-collapse on terminal races. No way for the mentor's FCM-then-fetch flow to distinguish "mentee already cancelled" from "you got beaten by the timeout" from "session id is bogus".

---

## 6) `POST /session/:id/cancel` — `handleSessionCancel`

**File:** `mentortalk-session/src/sessionHandler.js:1173`

**Status transition:** `requested` | `pending` → `cancelled`. Mentee-only.

**Response shape (HTTP 200, line 1213):**

```js
{ session_id: string, status: "cancelled" }
```

- `request_created_at` / `expires_at`: NEITHER (terminal).
- `mentee.privacy`: N/A.
- `normal_rate_per_minute`: N/A.
- **Terminal-state race handling:** SELECT and UPDATE both guard `status IN ('requested', 'pending')`. If the session has flipped to `active` (mentor accepted in the same tick), `cancelled`, `timed_out`, etc., `sessionResult.rows.length === 0` and the handler returns **404 `"Session not found or cannot be cancelled"`** (line 1191). All races collapse to 404.

**Gaps:** 404-collapse. The mentee app can't tell "I cancelled before the mentor accepted" from "the mentor accepted before my cancel landed" (which determines whether the user lands on the active session screen or the home screen).

---

## 7) `POST /session/:id/end` — `handleSessionEnd`

**File:** `mentortalk-session/src/sessionHandler.js:1218`

**Status transition:** `active` → `completed`.

**Response shape (HTTP 200, lines 1431–1443):**

```js
{
  session_id: string,
  total_duration_seconds: number,
  gross_amount: number,
  platform_fee: number,
  mentor_earning: number,
  segments: [
    {
      type: "chat" | "audio" | "video",
      duration_seconds: number,
      rate_per_minute: number,
      cost: number,
    }
  ],
}
```

- `request_created_at` / `expires_at`: NEITHER (terminal post-active).
- `mentee.privacy`: **MISSING** — but the deep-link revalidation case here is trickier. If a mentor receives a "session ended" FCM and re-opens the app, they should land on a post-session summary screen; the mentee's privacy block on `block_screenshots` matters until the screen unmounts. Currently, no privacy info is returned from the end endpoint.
- `normal_rate_per_minute`: **MISSING**. For `intro_rate` sessions, `segments[0].rate_per_minute` is the discounted rate; the un-discounted base rate is nowhere in the response. The session's `billing_type` field is also not echoed in this response (it is in `getSessionDetails`).
- **Terminal-state race handling:** SELECT at line 1222–1227 guards `status = 'active'`. Returns **404 `"Active session not found"`** (line 1230) if the session has already been ended (by the other party, by SFN timeout, or by grace expiry). Same 404-collapse pattern.

**Gaps:** missing `billing_type` echo, missing `normal_rate_per_minute` for intro_rate; 404-collapse for "already ended" race. Mentee privacy missing if a post-session screenshot policy is intended to persist into the summary screen.

---

## 8) `GET /session/active` — `handleGetActiveSession`

**File:** `mentortalk-session/src/sessionHandler.js:2796`

This is the canonical re-validation endpoint a re-opened app calls first. It returns whatever active/requested/pending session the user is on, regardless of role.

**Response shape (HTTP 200, lines 2915–2936):**

```js
{
  session_id: string,
  status: "requested" | "pending" | "active",
  my_role: "mentor" | "mentee",
  session_type: "chat" | "audio" | "video",
  billing_type: "paid" | "intro_rate" | "free_intro",
  rate_per_minute: number,                  // baseRate, NOT segment rate
  other_user_id: string,
  other_user_name: string,
  other_user_avatar: string | null,
  started_at: string | null,                // ISO 8601 — present for ALL statuses
  max_duration_seconds: number | null,      // populated when status='active'
  timeout_seconds: 60 | null,               // populated when status='requested'
  queue_position: number | null,            // populated when status='pending'
  call_type: "audio" | "video" | null,
  agora_channel: string | null,
  agora_token: string | null,
  agora_uid: number | null,
  agora_app_id: string | null,
  pref_audio: boolean,
  pref_video: boolean,
}
```

- `request_created_at`: **MISSING** for `requested`/`pending` — the only signal is `timeout_seconds: 60` which is a hard-coded constant, not a true expiry. A client that opens the app 30 seconds late will still believe it has the full 60.
- `expires_at`: **MISSING**.
- `started_at`: **PRESENT** at line 2925 (`s.started_at?.toISOString() || null`). For a `requested` session, `started_at` is set to NOW() at INSERT (line 572) — so for the `requested`/`pending` cases, **this column is being used as both creation timestamp and activation timestamp**, which conflates two semantically distinct events.
- `mentee.privacy`: **MISSING** entirely. The only privacy-bearing endpoint is `handleSessionAccept` (#4). A mentor who reopens the app and hits `/session/active` to re-render an in-progress chat will not get the privacy snapshot back. The `other_user_*` fields are flat strings — no nested mentee object exists to attach `privacy` to in the current shape.
- `normal_rate_per_minute`: **MISSING**. `rate_per_minute` is `baseRate` (line 2921) — for `intro_rate` sessions this is wrong-direction-wrong: the active rate is the discounted one stored on `session_segment.rate_per_minute`, but the API surfaces the un-discounted base rate. There is no companion field.
- **Terminal-state races:** only HTTP 404 `"No active session"` (line 2823) when no row matches `status IN ('requested', 'pending', 'active')`. If a session just transitioned to `completed` / `rejected` / `cancelled` / `timed_out`, this endpoint returns 404 with no information about which terminal state was reached. The client must independently query history to learn what happened.

**Gaps:** the most critical endpoint for revalidation is the most undershoot — no expiry timestamps, no privacy block, wrong rate semantics for intro_rate, terminal-state race information completely lost in 404-collapse.

---

## 9) `POST /session/:id/refresh-duration` — `handleRefreshDuration`

**File:** `mentortalk-session/src/sessionHandler.js:2656`

**Status transition:** none — recomputes max_duration after a wallet top-up. Mentee-only.

**Response shape (HTTP 200, lines 2787–2791):**

```js
{
  session_id: string,
  max_duration_seconds: number | null,      // null when free_intro
  remaining_balance: number,
}
```

Free-chat short-circuit (line 2678–2683) returns the same shape with `max_duration_seconds: null` and a `message` field.

- `request_created_at` / `expires_at`: N/A (mid-session adjust).
- `mentee.privacy`: N/A (mentee-self-call).
- `normal_rate_per_minute`: **MISSING**. For an `intro_rate` session, the duration is being recomputed against the discounted rate (line 2740); the response doesn't expose the un-discounted rate either, but in practice this endpoint is mentee-only and the mentee already knows their own rate from `/session/active`.
- **Terminal-state race:** SELECT at line 2661–2667 guards `status = 'active' AND mentee_id = $2`. Returns **404 `"Active session not found"`** (line 2670) on race or non-mentee caller. Same 404-collapse.

**Gaps:** 404-collapse on session-already-ended race.

---

## 10) `POST /session/:id/call/end` — `handleCallEnd`

**File:** `mentortalk-session/src/sessionHandler.js:2350`

**Status transition:** none on `session.status`; segment type flips audio/video → chat.

**Response shape (HTTP 200, lines 2563–2570):**

```js
{
  session_id: string,
  ended_type: "audio" | "video",
  duration_seconds: number,
  resumed_type: "chat",
  chat_rate: number,
  max_duration_seconds: number,
}
```

- `request_created_at` / `expires_at`: N/A.
- `mentee.privacy`: **MISSING** — when a call ends and the app falls back to chat, the privacy posture for chat persists. Since this endpoint is part of the in-call flow on both sides, lack of a privacy echo means the mentor app must already have the snapshot from the original `/session/:id/accept` reply.
- `normal_rate_per_minute`: **MISSING**. `chat_rate` is the post-call rate (line 2387 reads `mentor_profile.rate_per_minute` directly); for an intro_rate session this is the wrong rate (would be base, not discounted) — but per `schema.md:415` mode-switching/auto-resume to chat is documented as never-shipped legacy, so this codepath may be unreachable in practice.
- **Terminal-state race:** 404 `"Active session not found"` (line 2364), or 400 `"No active call to end"` if the segment is already chat (line 2379). Two distinct codes here, but both are coarse-grained — no way to distinguish "session ended seconds ago" from "wrong session id".

**Gaps:** missing `mentee.privacy` echo (if the chat-resume screen needs FLAG_SECURE recomputation); the 400 vs 404 distinction is welcome but doesn't separate "ended by counterpart" from "wrong id".

---

## 11) `GET /mentor/sessions` — `getSessions` (mentor lambda)

**File:** `mentortalk-mentor/mentorHandler.js:661`

History list for the mentor's own past/current sessions. Filter by `?status=...&limit&offset`.

**Response shape (HTTP 200, lines 709–737):**

```js
{
  sessions: [
    {
      id: string,
      mentee: {
        id: string,
        name: string,
        avatar: string | null,
        categories: string[],
        privacy: {
          block_screenshots: boolean,
          block_call_recording: boolean,
        },
      },
      status: "completed" | "cancelled" | "rejected" | "timed_out" | "active" | ...,
      modes: ("chat" | "audio" | "video")[],
      total_duration_seconds: number,
      mentor_earning: number,
      review_rating: number | null,
      started_at: timestamp,
      ended_at: timestamp | null,
    }
  ],
  pagination: { total, limit, offset, has_more },
}
```

**Key code (line 681–719):** the SQL `LEFT JOIN mentee_privacy_settings mps ON mps.user_id = s.mentee_id` and the `privacy` field on the `mentee` object are present per I6 (`audit/I6_privacy_suite_audit.md` Q5 closure).

- `request_created_at` / `expires_at`: N/A — these are completed/terminal rows.
- `mentee.privacy`: **PRESENT** ✅ (one of two endpoints that have it; the other is `handleSessionAccept`).
- `normal_rate_per_minute`: **MISSING**. The list rows don't include any rate at all — `mentor_earning` is a derived total, and the per-minute rate isn't exposed. For `intro_rate` history rows the client would not be able to reconstruct the strikethrough.
- **Terminal-state races:** N/A (read-only listing). No status guards, since multiple statuses can be requested via `?status=`.

**Gaps:** no `billing_type` echo per row, no rate fields, no `normal_rate_per_minute`. The privacy block is correct.

---

## 12) `GET /session/:id/details` — `getSessionDetails` (mentor lambda)

**File:** `mentortalk-mentor/mentorHandler.js:750`

Per-session detail view, mentor-only. Limited to terminal statuses by SQL filter (line 767): `s.status IN ('completed', 'cancelled', 'rejected', 'timed_out')`.

**Response shape (HTTP 200, lines 818–843):**

```js
{
  id: string,
  status: "completed" | "cancelled" | "rejected" | "timed_out",
  started_at: timestamp,
  ended_at: timestamp | null,
  session_type: "chat" | "audio" | "video" | null,
  rate_per_minute: number | null,           // from primarySegment, so discounted for intro_rate
  billing_type: "paid" | "intro_rate" | "free_intro" | null,
  mentee: {
    id: string,
    name: string,
    avatar: string | null,
    categories: string[],
    // NO privacy block here
  },
  segments: [
    { id, type, rate_per_minute, started_at, ended_at, duration_seconds, duration_minutes, mentor_earning }
  ],
  total_duration_seconds: number,
  total_duration_minutes: number,
  total_earning: number,
  review: { rating, comment, created_at } | null,
}
```

- `request_created_at` / `expires_at`: N/A (terminal).
- `mentee.privacy`: **MISSING** — but unlike `/mentor/sessions`, this single-row endpoint has no `LEFT JOIN mentee_privacy_settings`. The detail screen still wants FLAG_SECURE during media presigning (q.v. `handleGetMessages` privacy gate at line 333–343), so the omission here means the client must either re-fetch from `/mentor/sessions` or call the privacy endpoint directly.
- `normal_rate_per_minute`: **MISSING**. `rate_per_minute` (line 824) and `segments[].rate_per_minute` are the discounted rate for intro_rate sessions; no un-discounted companion is returned even though `billing_type` is.
- **Terminal-state races:** N/A — query is restricted to terminal statuses only. An ID for an `active`/`requested`/`pending` session returns **404 `"Session not found"`** (line 772). This is itself a kind of race-condition gap: a mentor app deep-linking to "details" for a session that the user just ended might race the `handleSessionEnd` commit and get 404 → empty detail screen.

**Gaps:** missing privacy block, missing `normal_rate_per_minute`, and the 404-on-not-yet-completed race window between session-end commit and details fetch.

---

## 13) `GET /mentee/session/:session_id/details` — `getSessionDetails` (mentee-profile lambda)

**File:** `mentortalk-mentee-profile/index.mjs:1069`

Mentee mirror of #12. Same SQL status filter (line 1082: `'completed', 'cancelled', 'rejected', 'timed_out'`), with a 403 if the session belongs to a different mentee (line 1093).

**Response shape (HTTP 200, lines 1126–1157):**

```js
{
  id: string,
  status: "completed" | "cancelled" | "rejected" | "timed_out",
  started_at: timestamp,
  ended_at: timestamp | null,
  session_type: "chat" | "audio" | "video" | null,
  rate_per_minute: number | null,
  billing_type: "paid" | "intro_rate" | "free_intro" | null,
  mentor: {
    id: string,
    name: string,
    avatar: string | null,
  },
  segments: [
    { id, type, rate_per_minute, started_at, ended_at, duration_seconds, duration_minutes }
  ],
  total_duration_seconds: number,
  total_duration_minutes: number,
  total_amount: number,
  review: { rating, comment, created_at } | null,
}
```

- `request_created_at` / `expires_at`: N/A (terminal).
- `mentee.privacy`: N/A (mentee viewing own session — privacy is the mentee's own state, fetched via `/mentee/privacy-settings` separately).
- `normal_rate_per_minute`: **MISSING**. Same gap as #12 from the mentee side — no un-discounted rate echo for `intro_rate`.
- **Terminal-state race:** 404 `"Session not found"` if not in terminal status (line 1087); 403 `"Forbidden"` if `mentee_id` doesn't match (line 1093). The 404 has the same race-window-on-fresh-completion issue as #12.

**Gaps:** missing `normal_rate_per_minute`; same 404-on-not-yet-terminal race.

---

## 14) Out of scope / not session-data endpoints

For completeness:

- `POST /session/:id/switch`, `/switch/accept`, `/switch/decline` — mode-switch flow flagged legacy in `schema.md:415`. Each returns a thin `{ session_id, status, ... }` shape with no mentee/privacy data. Skipped.
- `POST /session/:id/review` — review submission, returns `{ message, session_id, rating }`. No session shape to revalidate against.
- `GET /session/:id/messages` and `POST /session/:id/presign-upload` — message & media endpoints, audited under I6 (Q1 / Q3). Not in scope here.

---

## Gap matrix

Legend: ✅ present, ❌ missing, — not applicable for this endpoint, ⚠ partial / wrong-semantics.

| #   | Endpoint                                  | `request_created_at` / `expires_at` | `mentee.privacy` | `normal_rate_per_minute` (intro_rate) | Distinct race codes |
| --- | ----------------------------------------- | ----------------------------------- | ---------------- | ------------------------------------- | ------------------- |
| 1   | `POST /session/request`                   | ❌                                  | —                | ✅                                    | — (creation, 409 on existing) |
| 2   | `POST /session/free-chat`                 | ❌                                  | —                | — (free_intro)                        | — (creation, 409/503) |
| 4   | `POST /session/:id/accept`                | ❌                                  | ✅               | ❌                                    | ❌ (404-collapse)   |
| 5   | `POST /session/:id/reject`                | —                                   | ❌               | —                                     | ❌ (404-collapse)   |
| 6   | `POST /session/:id/cancel`                | —                                   | —                | —                                     | ❌ (404-collapse)   |
| 7   | `POST /session/:id/end`                   | —                                   | ❌               | ❌ (no `billing_type` either)         | ❌ (404-collapse)   |
| 8   | `GET /session/active`                     | ❌ (only `started_at`)              | ❌               | ⚠ (returns base rate, never discounted) | ❌ (404 = no active, indistinguishable from "just terminated") |
| 9   | `POST /session/:id/refresh-duration`      | —                                   | —                | ❌                                    | ❌ (404-collapse)   |
| 10  | `POST /session/:id/call/end`              | —                                   | ❌               | ❌                                    | ⚠ (400 vs 404, but both coarse) |
| 11  | `GET /mentor/sessions`                    | —                                   | ✅               | ❌ (no rate at all)                   | —                   |
| 12  | `GET /session/:id/details` (mentor)       | —                                   | ❌               | ❌                                    | ⚠ (404 on race with end-commit) |
| 13  | `GET /mentee/session/:id/details`         | —                                   | —                | ❌                                    | ⚠ (404 on race with end-commit) |

---

## Summary of cross-cutting findings

1. **No endpoint emits `request_created_at` or `expires_at`.** The session table itself has neither column (`schema.md:375`); the schedule fire-time is held inside an EventBridge `ScheduleExpression` string that's never read back (`mentortalk-session/src/sessionHandler.js:178, 1052, 1780`). For `/session/request`, `/session/free-chat`, and `/session/active` (the three that matter for countdown UI), the client gets only `timeout_seconds: 60` (or `cfg.free_chat_timeout_secs`) and must subtract from its own clock at receive time. Any subsequent re-fetch returns the same constant, not a remaining duration.
2. **`mentee.privacy` is implemented in only 2 of 13 endpoints.** `handleSessionAccept` (#4) and `getSessions` (#11) per the I6 audit closure. The rest — most importantly `handleGetActiveSession` (#8), the one a re-launched app calls first — do not return the snapshot. `handleGetActiveSession` doesn't even have a nested `mentee` / `mentor` object to attach it to; participants are flat fields named `other_user_*`.
3. **`normal_rate_per_minute` is implemented in only 1 of 13 endpoints.** `handleSessionRequest` (#1) and the related WS pushes / queue-promotion push at lines 611, 636, 1615. Every other endpoint that touches an `intro_rate` session emits the discounted rate alone, with no companion field. `handleGetActiveSession` (#8) is structurally worse — it emits the un-discounted base rate, ignoring the segment's locked rate entirely (`mentortalk-session/src/sessionHandler.js:2921`).
4. **Terminal-state races collapse to HTTP 404.** Every state-mutating endpoint (`accept`, `reject`, `cancel`, `end`, `refresh-duration`, `call/end`) uses a guarded SELECT and returns 404 with a generic error string when the row's status doesn't match the precondition. There is no way for a deep-linked client to distinguish "I lost the race to the timeout scheduler" from "wrong session id" from "the other party already terminated". `handleGetActiveSession` (#8) is the most consequential offender: a mentor relaunching the app right after the mentee ends a session sees `404 "No active session"` and has no breadcrumb to learn that the session terminated normally — they have to fall through to history listing endpoints.
5. **Schema-level prerequisites.** The session table needs a true creation timestamp (the existing `started_at` is overloaded as both create and activation, making `request_created_at` semantically ambiguous to add as an alias) and a stored `expires_at` that aligns with the EventBridge schedule (or, less invasively, a derived `request_created_at + SESSION_REQUEST_TIMEOUT_SECONDS`). For terminal-state distinguishability, the cleanest path is an explicit "outcome" lookup that returns `{ status, terminated_at, terminated_reason }` for any session id the caller participates in, regardless of current status — without that, individual endpoints can return 410 (gone) vs 409 (conflict) vs 404 (not found) but the disambiguation logic gets duplicated across six handlers.
6. **`billing_type` is inconsistently echoed.** Present on `/session/request`, `/session/active`, `/session/:id/accept`, and both detail endpoints; absent on `/session/:id/end` summary (`#7`) and `/mentor/sessions` rows (`#11`). Without it, the client can't even tell whether a `normal_rate_per_minute` field would be expected.

---

## Items to clarify before implementation

1. **Schema migration scope.** Adding `request_created_at TIMESTAMPTZ` and `expires_at TIMESTAMPTZ` to `session`, plus a backfill rule for in-flight rows. Or: derive `expires_at` server-side from a stored creation timestamp + a lifecycle-table-driven TTL.
2. **`handleGetActiveSession` shape redesign.** Currently flat `other_user_*` strings; need a nested `{ mentor, mentee }` to attach `privacy` symmetrically. Whether to break the existing flat shape (clients pinned to it) or add a parallel `participant` object.
3. **Race disambiguation strategy.** Either six handlers each grow precondition-aware error responses (more endpoints, more codes), or a single new `GET /session/:id/outcome` returns the terminal disposition. Pick one.
4. **`normal_rate_per_minute` everywhere or only where strikethrough is rendered.** The pragmatic minimum is to add it to `handleGetActiveSession` (#8), `handleSessionAccept` (#4), and both detail endpoints (#12, #13). Whether to also retrofit `getSessions` rows and `handleSessionEnd` summary depends on whether the strikethrough is shown in history.
5. **Mode-switch / call-end privacy echo.** Out of scope per `schema.md:415` legacy note, but if the `call/end` codepath is being kept, decide whether the chat-resume screen needs a fresh privacy snapshot (vs trusting the one fetched at accept time).
