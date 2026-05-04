# I15 FCM Payload Audit

Repo root: `C:\Users\h5cd2\workspace\mentortalk\lambda\`
Audit performed: 2026-05-03
Purpose: enumerate every FCM push the backend sends, document payload shape (data vs notification, priority, content-available), token-source and stale-token handling. Read-only — no fixes applied.

Paths are repo-relative unless stated otherwise.

---

## 1. The shared sender — `sendFcmNotification`

There is **no shared package**. The same helper file (`fcmHelper.js`) is **physically copy-pasted into nine Lambdas**:

- `mentortalk-session/src/fcmHelper.js`
- `mentortalk-session-timeout/src/fcmHelper.js`
- `mentortalk-request-timeout/src/fcmHelper.js`
- `mentortalk-grace-period/src/fcmHelper.js`
- `mentortalk-disconnect-check/src/fcmHelper.js`
- `mentortalk-free-chat-timeout/src/fcmHelper.js`
- `mentortalk-auth/fcmHelper.js`
- `mentortalk-admin/fcmHelper.js`
- `mentortalk-support/fcmHelper.js`

`md5sum` puts these in 4 byte-different buckets (whitespace/import-formatting only). All nine files have **identical message-construction logic**. There are **no behavioural differences between Lambdas** — fixing one means fixing nine.

### Message construction (canonical — `mentortalk-session/src/fcmHelper.js:150–178`)

```js
const message = {
  message: {
    token: fcmToken,
    notification: {
      title,
      body,
    },
    data: stringData,
    android: {
      priority: "high",
      notification: {
        channel_id: "session_notifications",
        sound: "default",
      },
    },
    apns: {
      payload: {
        aps: {
          alert: { title, body },
          sound: "default",
          "content-available": 1,
        },
      },
      headers: {
        "apns-priority": "10",
      },
    },
  },
};
```

**Always-present, non-overridable behaviour for every `sendFcmNotification` call:**

- `message.notification` — top-level FCM `notification` key is **always present** (mixed message, not data-only). Caller cannot opt out.
- `message.data` — caller-supplied `data` map. Each value is coerced to string at `fcmHelper.js:144–148`.
- `android.priority` — hard-coded `"high"`. Good for backgrounded delivery on Android.
- `android.notification.channel_id` — hard-coded `"session_notifications"` for **every push the system sends**, including support replies, admin warnings, force-logout, account bans. There is no per-event channel.
- `apns.headers.apns-priority` — hard-coded `"10"` (immediate delivery).
- `apns.payload.aps.content-available: 1` — always set, **and** an `alert` is always set. Per Apple docs, `content-available: 1` only behaves as a silent background push when `alert` / `sound` / `badge` are absent. Setting both means iOS treats it as a user-visible alert; the silent-wake hint is effectively neutralised.
- No `apns.headers.apns-push-type` is set. iOS 13+ requires `"apns-push-type": "background"` for background pushes and `"alert"` for visible. FCM v1 will infer it, but explicitly setting it is the documented best practice.
- No `mutable-content`, no `category`, no thread-id, no badge management.

### Token source (canonical — `mentortalk-session/src/fcmHelper.js:125–137`)

```js
const result = await db.query(
  `SELECT fcm_token FROM "user" WHERE id = $1`,
  [userId]
);

const fcmToken = result.rows[0]?.fcm_token;
if (!fcmToken) {
  console.log(`No FCM token for user ${userId} — skipping push`);
  return false;
}
```

- **Storage:** Postgres `"user"` table, single `fcm_token TEXT` column (`schema.md:38`). One token per user — single-device enforcement.
- **No DynamoDB** is consulted for FCM tokens. (`mentortalk-connections` is consulted for the WebSocket connection only.)
- **No caching** — every push hits Postgres for the token.
- **No multi-device** — second device login overwrites the token globally; old token is also nulled out across any other user that happened to have it: `mentortalk-auth/index.mjs:953–962`.

### Stale-token handling (canonical — `mentortalk-session/src/fcmHelper.js:192–206`)

```js
if (!response.ok) {
  const error = await response.text();
  console.error(`FCM send failed for user ${userId}:`, error);

  // If token is invalid, clear it from DB
  if (error.includes("UNREGISTERED") || error.includes("INVALID_ARGUMENT")) {
    await db.query(
      `UPDATE "user" SET fcm_token = NULL WHERE id = $1`,
      [userId]
    );
    console.log(`Cleared invalid FCM token for user ${userId}`);
  }

  return false;
}
```

- Stale-token detection is **string-matched on the raw response body**. FCM v1 returns a structured error like `{ error: { status: "NOT_FOUND", details: [{ errorCode: "UNREGISTERED" }] }}`. The substring check happens to catch both `UNREGISTERED` and `INVALID_ARGUMENT` — but it will also nuke a valid token any time the body happens to contain the literal string `INVALID_ARGUMENT` (e.g. `"reason": "INVALID_ARGUMENT_for_field_X"`).
- `INVALID_ARGUMENT` is **not** an FCM token-validity signal. It can mean malformed payload, oversized data field, etc. Deleting the token on `INVALID_ARGUMENT` is over-eager.
- Other token-invalidity signals are **not** handled: `SENDER_ID_MISMATCH`, `THIRD_PARTY_AUTH_ERROR`, HTTP 404 on the token resource path, `NOT_FOUND` (which is the canonical wrapper for `UNREGISTERED`).
- **No retry** for transient errors (`UNAVAILABLE`, `INTERNAL`, 5xx, 429). A flaky FCM gateway results in a permanently-dropped notification per call.
- **No batching** — every `sendFcmNotification` is one HTTP round-trip; high-fan-out flows (e.g. presence broadcast — though that one happens to skip FCM) sequentialize poorly.

### OAuth2 access-token caching (`mentortalk-session/src/fcmHelper.js:39–91`)

- Service-account JSON loaded from Secrets Manager `mentortalk/firebase-service-account`. Cached in module scope.
- Access token cached with 60s buffer before expiry. Each Lambda warm container maintains its own cache; cold starts pay one OAuth2 round-trip plus one Secrets-Manager round-trip.

---

## 2. Caller pattern — `pushToUser(userId, wsPayload, fcmOptions?)`

Almost every event-driven push goes through a Lambda-local `pushToUser` helper that **(a) tries the WebSocket** via `mentortalk-connections` DynamoDB table and `ApiGatewayManagementApiClient`, then **(b) calls `sendFcmNotification` if `fcmOptions` is non-null**, regardless of whether the WebSocket leg succeeded.

Canonical version: `mentortalk-session/src/sessionHandler.js:92` (also reproduced in `audit/I6_privacy_suite_audit.md:431–461`).

```js
async function pushToUser(userId, payload, fcmOptions = null) {
  // ... websocket attempt elided ...
  if (fcmOptions) {
    await sendFcmNotification(userId, fcmOptions);
  }
}
```

**Important:** the WebSocket payload (`payload`) and the FCM payload (`fcmOptions.data`) are **two independently-constructed objects**. They are not derived from each other. In every callsite below, the WS `type` and the FCM `data.type` happen to match by hand — but there is no enforcement, and several events drift:

- WS payload usually carries rich fields (mentee object, agora creds, balance, modes, summary spread).
- FCM `data` is consistently a thin subset — typically `{ type, session_id [, mentee_name, session_type, is_free_chat, ended_by] }`.

**Pure WebSocket events (no FCM at all)** — the third arg to `pushToUser` is omitted, so the user is silently dropped if the app is backgrounded:

- `session_cancelled` (mentee cancels on mentor) — `sessionHandler.js:1208`
- `session_promoted` (queue promotion) — `sessionHandler.js:1630`, `sessionTimeout.js:503`, `sessionGracePeriod.js:377`
- `session_expired` (free-chat mentor missed) — `freeChatTimeout.js:155`
- `peer_disconnected` (other party dropped) — `sessionDisconnectCheck.js:220`
- `mode_switch_accepted` + `mode_switch_declined` — `sessionHandler.js:2242, 2256, 2337`
- `call_ended` (audio/video resumed to chat) — `sessionHandler.js:2547–2561`
- `duration_refreshed` (wallet topped up) — `sessionHandler.js:2774–2782`
- All `new_message` system-event mirrors of session-end / call-end / mode-switch transitions — `sessionHandler.js:1480, 1491, 2253–2268, 2557–2561`, `sessionTimeout.js:385–386`, `sessionGracePeriod.js:279–280`.

A backgrounded / killed app will not learn about these state transitions until it next polls or reconnects WS. For the call-flow ones (`peer_disconnected`, `mode_switch_*`, `call_ended`), this is operationally significant because the iOS/Android client needs to revalidate UI state.

---

## 3. Per-event FCM payload inventory

Each subsection below documents one push pattern: **WS-only callsites are listed for completeness** (so the table at the bottom is accurate) but the focus is on the FCM leg.

### 3.1 `session_request` — mentee asks mentor to start a session

Pushed from:

- `mentortalk-session/src/sessionHandler.js:599–625` (initial request)
- `mentortalk-session/src/sessionHandler.js:1080–1102` (free-chat forward on mentor reject)
- `mentortalk-session/src/sessionHandler.js:1604–1628` (queue promotion after session ends, in-process)
- `mentortalk-session/src/sessionHandler.js:1809–1831` (free-chat handler, first mentor)
- `mentortalk-session-timeout/src/sessionTimeout.js:480–501` (queue promotion after balance-exhaustion timeout)
- `mentortalk-grace-period/src/sessionGracePeriod.js:354–375` (queue promotion after grace-period end)
- `mentortalk-free-chat-timeout/src/freeChatTimeout.js:344–367` (forward to next free-chat mentor)

WS payload fields (varies by branch):

```js
{
  type: "session_request",
  session_id, mentee_id, mentee_name, mentee_avatar,  // avatar omitted in some promotions
  session_type,                                       // "chat" | "audio" | "video"
  billing_type,                                       // "paid" | "intro_rate" | "free_intro" — NOT in all branches
  rate_per_minute,
  normal_rate_per_minute,                             // only for intro_rate
  is_free_chat,                                       // only for free_intro
  timeout_seconds,
}
```

FCM `data` (canonical — `sessionHandler.js:617–622`):

```js
{
  type: "session_request",
  session_id,
  mentee_name,
  session_type,
}
```

Free-chat variant (`sessionHandler.js:1096–1100`, `1825–1829`, `freeChatTimeout.js:361–365`):

```js
{
  type: "session_request",
  session_id,
  is_free_chat: "true",
}
```

Notes:

- FCM `data` for free-chat **drops `mentee_name` and `session_type`** but adds `is_free_chat`. So the iOS/Android handler cannot rely on a uniform shape across free vs paid requests. Two different code paths needed client-side just for "session_request."
- The session-timeout and grace-period queue-promotion variants (`sessionTimeout.js:480`, `sessionGracePeriod.js:354`) **do not include `mentee_avatar` in the WS payload** — only the in-process promotion path (`sessionHandler.js:1604`) does. This is a WS payload drift, not an FCM-layer issue, but worth flagging because the iOS/Android push receivers may rely on the WS payload being authoritative on receipt.
- `timeout_seconds` is in the WS payload but not the FCM `data`. The mobile client cannot start a countdown from a cold push alone.
- Three codepaths for the same logical event. If the FCM contract changes, three places need updates plus the lambdas in two other repos.

Title/body: `"New Session Request" / "${menteeName} wants to start a ${session_type} session"` (paid) or `"Free Chat Request" / "${menteeName} wants a free intro chat"` (free).

### 3.2 `session_accepted` — mentor accepts request

Pushed from `mentortalk-session/src/sessionHandler.js:899–911`.

WS payload (lines 873–897) carries Agora creds (`agora_channel`, `agora_token`, `agora_uid`, `agora_app_id`), `mentor_name`, `mentor_avatar`, `mentee_balance`, `max_duration_seconds`, `min_duration_secs`, `pref_audio`, `pref_video`, `billing_type`, `rate_per_minute`.

FCM `data`:

```js
{
  type: "session_accepted",
  session_id,
  session_type,
}
```

Notes:

- The Agora credentials, balance, and max-duration are **only on the WebSocket payload**. A backgrounded mentee receiving the FCM push needs to deep-link to a screen that re-fetches the active session via `GET /session/active` to get them. The push alone is insufficient to start the call.
- No mentor name in the FCM `data` (it's in the title/body but not machine-readable as a structured field).

### 3.3 `session_rejected` — mentor declines

Pushed from `mentortalk-session/src/sessionHandler.js:1152–1166`.

```js
WS:  { type: "session_rejected", session_id }
FCM: { type: "session_rejected", session_id }
```

Title/body: `"Session Declined" / "The mentor declined your session request"`. Clean, minimal.

### 3.4 `session_cancelled` — mentee cancels before mentor accepts

Pushed from `mentortalk-session/src/sessionHandler.js:1208–1211`.

```js
WS:  { type: "session_cancelled", session_id }
FCM: <NONE — third arg omitted>
```

**No FCM**. If the mentor's app is backgrounded when the mentee cancels, the mentor will not learn until WS reconnects. The mentor's pending-request UI will keep its 60s countdown until the request-timeout Lambda fires (3.5).

### 3.5 `session_timed_out` — request-timeout fired

Pushed from `mentortalk-request-timeout/src/requestTimeout.js:122–149` to **both** mentee and mentor.

```js
WS (mentee):  { type: "session_timed_out", session_id, message: "Mentor did not respond in time" }
WS (mentor):  { type: "session_timed_out", session_id, message: "Session request timed out" }
FCM (both):   { type: "session_timed_out", session_id }
```

Title/body (mentee): `"Request Timed Out" / "The mentor did not respond to your session request"`.
Title/body (mentor): `"Missed Session Request" / "A session request expired because you didn't respond"`.

### 3.6 `session_ended` — session ended (manual, balance-exhaustion, peer-disconnect)

Three distinct producers, **all using the same `type: "session_ended"` event** but with different `reason` / `ended_by` semantics:

**(a) Manual end** — `mentortalk-session/src/sessionHandler.js:1502–1524`. Both parties.

```js
WS payload spread: { type, ended_by: endedByLabel, ...summary }
  // summary = { session_id, total_duration_seconds, gross_amount, platform_fee, mentor_earning, segments }
FCM data: { type: "session_ended", session_id }
```

Note — the mentor's title/body literal at line 1520 is `menteeTitle` — copy-paste artefact:

```js
await pushToUser(
  session.mentor_id,
  { type: "session_ended", ... },
  { title: menteeTitle, body: mentorBody, ... }   // sessionTimeout.js:423 — SAME bug
);
```

Wait — re-checking. In `sessionHandler.js:1516–1524` the mentor's title is `"Session Ended"` (string literal). The `menteeTitle` reuse is in **`sessionTimeout.js:423`** specifically (see (b) below), where the mentor branch reuses the variable named `menteeTitle`. The variable is just named "menteeTitle" but holds a generic title string — not actually a bug, but the naming is misleading and the title shown to the mentor is the same as the mentee. Acceptable but confusing.

**(b) Balance-exhausted / free-chat-time-up / intro-time-up** — `mentortalk-session-timeout/src/sessionTimeout.js:409–427`. Both parties.

```js
WS: { type: "session_ended", ended_by: "system", reason, billing_type, ...summary }
    // reason ∈ "balance_exhausted" | "free_chat_ended" | "intro_session_ended"
FCM data: { type: "session_ended", session_id, ended_by: "system" }
```

`reason` and `billing_type` are **only on the WS leg**. A backgrounded client receiving only the FCM has no way to differentiate balance-exhaustion from free-chat-end. UX-wise these warrant different copy, but the FCM has the same `data.type`.

**(c) Peer-disconnected (grace expired)** — `mentortalk-grace-period/src/sessionGracePeriod.js:283–301`. Both parties.

```js
WS: { type: "session_ended", ended_by: "system", reason: "peer_disconnected", ...summary }
FCM data: { type: "session_ended", session_id, ended_by: "system" }
```

Same shape as (b) modulo `reason` value. Same observation about reason loss in the FCM.

### 3.7 `mode_switch_request`

`mentortalk-session/src/sessionHandler.js:2045–2066`. Sent to the *other* party.

```js
WS: { type, session_id, requested_by, requester_name, new_type, current_type, current_rate, new_rate }
FCM: { type: "mode_switch_request", session_id, new_type }
```

Title/body: `"Mode Switch Request" / "${requesterName} wants to switch to ${new_type}"`.

`requester_name`, `current_rate`, `new_rate` are not in FCM `data`. A backgrounded receiver cannot show "user X wants to switch to video for ₹Y/min" from the data payload alone — only from title/body strings.

### 3.8 `mode_switch_accepted` / `mode_switch_declined`

WS-only (no FCM). `sessionHandler.js:2242, 2256` (accepted, both parties) and `sessionHandler.js:2337` (declined, requester).

The accepted variant carries fresh `agora_channel/agora_token/agora_uid/agora_app_id`, `new_type`, `new_rate`, `max_duration_seconds`. The mobile client **must be foregrounded** to receive these or the audio/video transition will not happen.

### 3.9 `call_ended`

`sessionHandler.js:2547–2561`. WS-only, no FCM. Both parties.

```js
{ type, session_id, ended_type, duration_seconds, max_duration_seconds, chat_rate }
```

Only meaningful when both apps are foregrounded since this is mid-call.

### 3.10 `duration_refreshed`

`sessionHandler.js:2774–2782`. WS-only, no FCM. Both parties. Sent after a wallet top-up updates max session duration.

### 3.11 `peer_disconnected`

`mentortalk-disconnect-check/src/sessionDisconnectCheck.js:220–226`. WS-only, no FCM.

```js
{ type, session_id, disconnected_user_id, grace_seconds, remaining_seconds }
```

Same caveat as `mode_switch_accepted`: the still-online party will not learn that their peer dropped if their own app is backgrounded. They will re-discover only on next WS connect.

### 3.12 `session_promoted`

WS-only (no FCM). Three identical callsites:

- `sessionHandler.js:1630`
- `sessionTimeout.js:503`
- `sessionGracePeriod.js:377`

`{ type, session_id, message: "Your session request has been sent to the mentor" }`. Confirms a `pending` → `requested` transition for the mentee.

### 3.13 `session_expired`

`mentortalk-free-chat-timeout/src/freeChatTimeout.js:155–158`. WS-only, no FCM. Sent to the **mentor** when their free-chat request slot expired (forwarded onward). Functions as a "dismiss the request banner" signal.

### 3.14 `free_chat_unavailable`

Two callsites: `sessionHandler.js:1135–1147` (mentor rejected last candidate) and `freeChatTimeout.js:255–267` (queue exhausted). **Both** include FCM.

```js
WS:  { type, session_id, message: "No mentors available right now. Please try again later." }
FCM data: { type: "free_chat_unavailable", session_id }
```

Title/body: `"Free Chat Unavailable" / "No mentors are available right now. Please try again later."`.

### 3.15 Non-session events that share the helper

Out of scope for I15 strictly, but they share the helper and channel and so will be affected by any helper-level changes:

- **Force-logout on second-device login** — `mentortalk-auth/index.mjs:294–298`. `data: { type: "force_logout", reason: "signed_in_elsewhere" }`. Title/body `"Signed in on another device" / "Your MentorTalk account was signed in on another device. You have been logged out."` Channel `session_notifications` — wrong channel (this is an auth event).
- **Onboarding application status update** — `mentortalk-admin/index.mjs:366–370`. `data: { type: "onboarding_update" }`. Title/body vary by action.
- **Generic admin push** — `mentortalk-admin/index.mjs:502–506`. Free-form title/message from request body. Hard-codes `data: { type: "onboarding_update" }` regardless — that string is wrong for a generic push.
- **Account banned** — `mentortalk-admin/index.mjs:746–750`. `data: { type: "account_banned" }`.
- **Account warning** — `mentortalk-admin/index.mjs:1006–1010`. `data: { type: "account_warning" }`.
- **Support reply (admin → user)** — `mentortalk-admin/index.mjs:1225–1244`. `data: { type: "support_reply" }`. Body truncated to 100 chars at line 1238.
- **Support ticket resolved** — `mentortalk-admin/index.mjs:1291–1307`. `data: { type: "support_reply" }` (same `type` as a reply — not distinguishable from a normal reply in the data payload).

These all flow through the same fcmHelper and thus all have the same `notification` + `data` mixed shape, the same hard-coded `session_notifications` channel, and the same stale-token handling.

---

## 4. Cross-cutting issues

### 4.1 Mixed `notification` + `data` (every push)

Every FCM message includes the top-level `notification` key. This has well-known consequences:

- **Android, app backgrounded:** FCM displays the notification automatically and the `onMessageReceived` data callback is **not invoked**. Native `data` handlers do not fire until the user taps the notification. Deep-link revalidation logic that reads `data` cannot run on receipt.
- **iOS:** the simultaneous presence of `aps.alert` and `aps.content-available: 1` makes this a **user-visible push, not a silent push**. iOS will *not* reliably wake the app for background processing; `didReceiveRemoteNotification(...completionHandler:)` may be deferred or skipped under throttling.

If the native side's intent is "wake the app, run a deep-link revalidation, decide whether to show our own UI," the entire system is structured wrong: it should be **data-only** with `apns-push-type: background` + `content-available: 1` and **no** `alert/sound` — and any user-visible notification should be locally constructed by the app from the data payload.

### 4.2 No iOS `apns-push-type`

FCM v1 will infer it from the message shape, but it is not explicitly set. iOS 13+ delivery is most predictable when this header is set explicitly to `"alert"` or `"background"`.

### 4.3 Single Android channel

Every event uses `channel_id: "session_notifications"` regardless of category (session, support, auth, admin warning). Users cannot mute support without muting session requests. Channels should partition by user-meaningful category.

### 4.4 No `apns-collapse-id` / `tag` / FCM `collapse_key`

Multiple promotions / forwarded session requests can pile up in the notification tray. Each `session_timed_out`, `session_request`, `session_promoted` is a fresh notification with no collapse hint.

### 4.5 No unified payload contract

The WebSocket payload is rich; the FCM `data` is a lossy thin slice. The slice is hand-built per callsite and varies (free-chat drops `mentee_name`, paid keeps it; reason/billing_type missing from `session_ended` data; agora creds never in any FCM data). A single source of truth (e.g. `buildFcmDataFromWsPayload(type, wsPayload)`) does not exist.

### 4.6 Stale-token detection is a substring match

`fcmHelper.js:197` — `error.includes("UNREGISTERED") || error.includes("INVALID_ARGUMENT")`. Fragile (false positives wipe valid tokens; misses `NOT_FOUND` / `SENDER_ID_MISMATCH`). Should parse the JSON error and inspect `error.details[*].errorCode`.

### 4.7 No retry / no batching

`sendFcmNotification` makes one fetch and returns. Transient 5xx / `UNAVAILABLE` / `INTERNAL` are dropped silently. No exponential backoff, no `multicast` send, no idempotent retry queue.

### 4.8 Nine duplicated copies of the helper

Touching FCM behaviour means editing nine files. There is no per-Lambda divergence to justify the duplication; it is mechanical. The deploy script (`update.ps1`) per `MEMORY.md` operates on one Lambda at a time, so there is no infrastructure reason it cannot be a shared internal package or a shared layer.

### 4.9 FCM token write is in `mentortalk-auth` only

`mentortalk-auth/index.mjs:953–962` is the only writer of `fcm_token`. The "delete this token from any other user, then set it on me" pattern is correct for single-device but interacts badly with the silent `fcm_token = NULL` clearing in fcmHelper: once cleared, the device must re-register on next app foreground (and the app must know to do so). There is no documented signal pushed back to the client that says "your token was invalidated server-side."

### 4.10 Many session events skip FCM entirely

See §2 list. For events that fire while one party is foregrounded and the other is backgrounded — `peer_disconnected`, `mode_switch_*`, `call_ended`, `session_cancelled`, `session_promoted`, `session_expired`, `duration_refreshed` — the backgrounded party gets no signal at all until WS reconnect. For native deep-link revalidation logic, this is the largest functional gap.

---

## 5. Summary table

`event_type` is the value of `data.type` in the FCM message. "FCM?" = "is `fcmOptions` passed to `pushToUser`, i.e. is FCM actually attempted." All FCM-bearing events use the same shape — `notification` + `data`, `priority: "high"`, `content-available: 1`, channel `session_notifications` — so those columns are constant and listed once below the table.

| event_type                | fields_sent (data)                                                            | data_only? | priority | issues                                                                                                                                                                            |
| ------------------------- | ----------------------------------------------------------------------------- | ---------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session_request` (paid)  | `type, session_id, mentee_name, session_type`                                 | NO         | high     | `notification`+`data` mixed → Android background skips data handler; no `timeout_seconds` in data; 3 lambdas duplicate this construction                                          |
| `session_request` (free)  | `type, session_id, is_free_chat: "true"`                                      | NO         | high     | drops `mentee_name`, `session_type` vs paid variant — non-uniform shape across same `type`                                                                                        |
| `session_accepted`        | `type, session_id, session_type`                                              | NO         | high     | Agora creds + `max_duration_seconds` only on WS — backgrounded mentee must re-fetch via REST after deep-link                                                                      |
| `session_rejected`        | `type, session_id`                                                            | NO         | high     | OK; minimal but sufficient                                                                                                                                                        |
| `session_cancelled`       | —                                                                             | n/a        | n/a      | **No FCM**. Backgrounded mentor will not learn until WS reconnect; client UI keeps countdown until request-timeout fires                                                          |
| `session_timed_out`       | `type, session_id`                                                            | NO         | high     | OK                                                                                                                                                                                |
| `session_ended` (manual)  | `type, session_id`                                                            | NO         | high     | `ended_by`, `reason`, `summary` only on WS — FCM-only receivers can't show "you were charged ₹X" without re-fetching                                                              |
| `session_ended` (timeout) | `type, session_id, ended_by: "system"`                                        | NO         | high     | `reason` (balance_exhausted vs free_chat_ended vs intro_session_ended) and `billing_type` lost in FCM; client cannot distinguish without re-fetch; misleading variable `menteeTitle` reused for mentor branch (`sessionTimeout.js:423`) |
| `session_ended` (grace)   | `type, session_id, ended_by: "system"`                                        | NO         | high     | `reason: "peer_disconnected"` lost in FCM                                                                                                                                         |
| `mode_switch_request`     | `type, session_id, new_type`                                                  | NO         | high     | `requester_name`, `current_rate`, `new_rate` only on WS                                                                                                                           |
| `mode_switch_accepted`    | —                                                                             | n/a        | n/a      | **No FCM**. Carries fresh Agora creds; counterparty's app must be foreground to transition modes                                                                                  |
| `mode_switch_declined`    | —                                                                             | n/a        | n/a      | **No FCM**                                                                                                                                                                        |
| `call_ended`              | —                                                                             | n/a        | n/a      | **No FCM**. Mid-call event, foreground-only, acceptable                                                                                                                           |
| `duration_refreshed`      | —                                                                             | n/a        | n/a      | **No FCM**. Both sides need foreground to update timers                                                                                                                           |
| `peer_disconnected`       | —                                                                             | n/a        | n/a      | **No FCM**. Backgrounded user does not learn peer dropped — meaningful gap for re-engagement / grace-period UX                                                                    |
| `session_promoted`        | —                                                                             | n/a        | n/a      | **No FCM**. Mentee with backgrounded app does not learn their pending request advanced to `requested`                                                                             |
| `session_expired`         | —                                                                             | n/a        | n/a      | **No FCM**. Mentor does not get a "request banner dismiss" signal if backgrounded                                                                                                 |
| `free_chat_unavailable`   | `type, session_id`                                                            | NO         | high     | OK                                                                                                                                                                                |
| `force_logout`            | `type, reason: "signed_in_elsewhere"`                                         | NO         | high     | Wrong Android channel (`session_notifications`); may be coalesced with session pushes in tray                                                                                     |
| `onboarding_update`       | `type`                                                                        | NO         | high     | Title/body carry the action; `data` has only `type` so client can't differentiate approve/reject/needs_fixes without parsing strings                                              |
| `account_banned`          | `type`                                                                        | NO         | high     | Wrong channel; `ban_reason` only in user-visible body string, not data                                                                                                            |
| `account_warning`         | `type`                                                                        | NO         | high     | Same as above                                                                                                                                                                     |
| `support_reply`           | `type`                                                                        | NO         | high     | Same `data.type` for both admin reply and ticket-resolved system message — client cannot tell them apart from data alone (must read `message_type` from WS, which FCM lacks)      |

**Constants for every FCM-bearing event:**

- `apns.payload.aps.content-available`: `1`
- `apns.payload.aps.alert`: `{ title, body }`
- `apns.headers.apns-priority`: `"10"`
- `apns.headers.apns-push-type`: **not set**
- `android.priority`: `"high"`
- `android.notification.channel_id`: `"session_notifications"` (every push)
- `android.notification.sound`: `"default"`
- top-level `notification: { title, body }`: always present (mixed message)
- token source: Postgres `"user".fcm_token`, single-device
- stale-token cleanup: substring match on `UNREGISTERED` or `INVALID_ARGUMENT` → `UPDATE "user" SET fcm_token = NULL`

---

## 6. Items to clarify before proposing fixes

1. **Intended delivery model on iOS / Android.** Is the goal "data-only push, app constructs its own UI" (the mobile-architectural fit for deep-link revalidation), or "FCM displays notification, app reads data only on tap"? The current code targets the second; the prompt implies the first. Pick one — the helper rewrite branches on this.
2. **Should events that currently skip FCM start sending it?** `peer_disconnected`, `mode_switch_*`, `call_ended`, `session_cancelled`, `session_promoted`, `session_expired`, `duration_refreshed` are all WS-only today. For each, decide: silent FCM (data-only, no alert) for revalidation, or audible FCM, or stay WS-only?
3. **Channel partitioning.** Confirm Android channel split — at minimum: `session_calls` (high priority, sound, vibrate), `session_chat` (high, sound), `support` (default), `account` (default). Affects every callsite if the helper signature changes.
4. **`session_ended` collapse.** Three flavours (manual / timeout / disconnect) currently share `data.type = "session_ended"`. Add a `data.reason` mirror (so it survives the WS→FCM lossy slice)?
5. **Stale-token detection.** Switch to JSON-parsed `error.details[*].errorCode` checks and add `NOT_FOUND` / `SENDER_ID_MISMATCH`; remove `INVALID_ARGUMENT` from the cleanup list (it is not a token-validity signal).
6. **Helper consolidation.** Nine identical files. Move to a Lambda layer or `npm` package private to the org? Affects deploy mechanics (`update.ps1` is per-Lambda).
7. **Retry policy.** Add bounded exponential backoff for FCM 5xx / `UNAVAILABLE`? Probably yes for session-critical events (`session_request`, `session_accepted`); arguably not for `session_promoted` / fire-and-forget.
8. **WS→FCM contract.** Worth introducing a typed `buildFcmData(wsPayload)` so the data slice is mechanically consistent? Today the slice is hand-built per callsite and drifts (cf. free-chat dropping `mentee_name`).
9. **Missing FCM data fields.** Confirm whether mobile clients want `mentor_id`, `mentee_id`, `session_type`, `billing_type`, `reason`, `ended_by`, `timeout_seconds` consistently on **every** session-related FCM data payload. Today they leak in/out per event.
10. **`apns-push-type` and `mutable-content`.** Should we set `apns-push-type` explicitly and use `mutable-content: 1` to allow a Notification Service Extension to rewrite the body (e.g. for end-to-end-encrypted message previews — relevant if I-something later adds encrypted chat)?
