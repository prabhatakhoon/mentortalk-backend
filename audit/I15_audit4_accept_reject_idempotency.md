# I15 Accept/Reject Idempotency Audit

Repo root: `C:\Users\h5cd2\workspace\mentortalk\lambda\`
Audit performed: 2026-05-03
Scope: read-only audit of `POST /session/:id/accept` and `POST /session/:id/reject` to assess fitness for native-OS notification action buttons (Accept / Reject from a push, no app-foreground UI).
No fixes proposed in this document — gaps only.

Paths are repo-relative unless stated. All line numbers refer to `mentortalk-session/src/sessionHandler.js` at HEAD (`c309048`).

---

## 0. Shared infrastructure

### 0.1 `respond` helper — line 74

```js
const respond = (statusCode, body) => ({
  statusCode,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
```

Body is whatever object the caller passes. There is no envelope. The convention across the file for error bodies is `{ error: "<free-text string>" }`. There is **no `code` discriminator** anywhere — every error path is identified by HTTP status + free-text `error` only.

### 0.2 Route registration — lines 236–242

```js
if (method === "POST" && path.match(/\/session\/[^/]+\/accept/)) {
  return await handleSessionAccept(userId, event);
}

if (method === "POST" && path.match(/\/session\/[^/]+\/reject/)) {
  return await handleSessionReject(userId, event);
}
```

### 0.3 Top-level error catch — lines 302–308

```js
} catch (err) {
  if (err.name === "JsonWebTokenError" || err.name === "TokenExpiredError"
      || err.message.includes("authorization header")) {
    return respond(401, { error: "Unauthorized" });
  }
  console.error("Unhandled error:", err);
  return respond(500, { error: "Internal server error" });
}
```

`401 Unauthorized` is reserved for missing / invalid / expired JWT only. There is no `403 Forbidden` path within accept or reject for "wrong mentor" — that case is silently mapped to 404 (see §3).

### 0.4 `extractSessionId` — line 1910

```js
function extractSessionId(event) {
  const pathParts = (event.path || event.resource || "").split("/");
  return event.pathParameters?.session_id || pathParts[2];
}
```

No malformed-id validation. A missing or unparseable id falls through to the `WHERE id = $1` query which simply returns 0 rows → 404.

---

## 1. `handleSessionAccept` — `POST /session/:id/accept`

**File:** `mentortalk-session/src/sessionHandler.js`
**Function:** `handleSessionAccept` — declared at line 662, returns at line 951.

### 1.1 Authorization + state guard (single combined query) — lines 666–676

```js
const sessionResult = await db.query(
  `SELECT s.*, mp.rate_per_minute, mp.pref_audio, mp.pref_video
   FROM session s
   JOIN mentor_profile mp ON mp.user_id = s.mentor_id
   WHERE s.id = $1 AND s.mentor_id = $2 AND s.status = 'requested'`,
  [sessionId, userId]
);

if (sessionResult.rows.length === 0) {
  return respond(404, { error: "Session not found or not in requested state" });
}
```

This **single query collapses six distinct failure modes into one 404 with one free-text string**:

1. Session id does not exist.
2. Session exists but caller is not the mentor on it.
3. Session is `pending` (queued, mentor not yet engaged).
4. Session is already `active` (already-accepted by this same mentor — the idempotent retry case).
5. Session is `rejected`, `timed_out`, `completed`, or `cancelled` (terminal).
6. Session was reassigned to another mentor (free-chat forwarding flow) — see §2 — caller is the *previous* mentor.

There is **no second query** to disambiguate. Native action-button code receiving 404 cannot tell the user "you already accepted this" vs "this is gone forever."

### 1.2 Success path

`UPDATE session SET status='active'` at lines 689–693, wrapped in a `BEGIN/COMMIT` transaction (lines 685–762). On success returns:

```js
return respond(200, acceptResponse);
```

Body shape (lines 924–949) — note this includes `mentee.privacy.{ block_screenshots, block_call_recording }` and optional `agora_*` fields:

```js
{
  session_id, status: "active",
  session_type, billing_type, rate_per_minute, mentee_balance,
  max_duration_seconds, min_duration_secs,
  pref_audio, pref_video,
  mentee: { privacy: { block_screenshots, block_call_recording } },
  // Audio/video only:
  agora_channel, agora_token, agora_uid, agora_app_id
}
```

### 1.3 Idempotency

**Not idempotent.** The status guard is `status = 'requested'`, and the transaction at line 690 hard-flips to `'active'`. A second `accept` call from the same mentor on the same already-accepted session:

- finds 0 rows in the guard query (status is now `'active'`, not `'requested'`)
- returns `404 { error: "Session not found or not in requested state" }`

The mentor's own re-accept produces an apparent error indistinguishable from "session was deleted." The caller cannot recover by saying "ah, already-accepted, that's fine."

### 1.4 Side-effect duplication risk

Even though the DB transition is gated by `status='requested'`, several side effects sit *outside* the transaction (lines 763–913): SFN execution start, S3/DDB writes for the system "Chat started" message, FCM push, presence broadcast, Agora token generation. These only run after a successful transition, so a duplicate request that returns 404 will *not* fire them again. Good. But there is no `Idempotency-Key`-style dedup — if the first request *partially* succeeded (e.g. SFN start failed but DB committed — the SFN error is caught and swallowed at lines 858–860), a retry cannot re-trigger SFN start; the second call will 404.

---

## 2. `handleSessionReject` — `POST /session/:id/reject`

**File:** `mentortalk-session/src/sessionHandler.js`
**Function:** `handleSessionReject` — declared at line 956, returns at lines 1105, 1149, 1168 (success) and 967, 1120 (error).

### 2.1 Authorization + state guard (lines 960–968)

```js
const sessionData = await db.query(
  `SELECT request_timeout_schedule, billing_type, mentee_id FROM session
   WHERE id = $1 AND mentor_id = $2 AND status = 'requested'`,
  [sessionId, userId]
);

if (sessionData.rows.length === 0) {
  return respond(404, { error: "Session not found or not in requested state" });
}
```

**Same shape as accept** — six failure modes collapsed into one 404 with one free-text string. No `403`. No discrimination of already-rejected vs not-yourrs vs not-found.

### 2.2 Free-chat forwarding branch — lines 974–1109

If `billing_type === 'free_intro'` and there is a viable next mentor in the DDB queue, this branch reassigns the session to the next mentor instead of rejecting it. On success (lines 1022–1106) returns:

```js
return respond(200, { session_id: sessionId, status: "forwarded" });
```

> Subtle: the session remains in `status='requested'` after a forward (lines 1024–1027 only update `mentor_id` and `request_timeout_schedule`). The original mentor calling `reject` again on the same id — within the new mentor's window — will hit the 404 path (caller is no longer `mentor_id`). The new mentor's own subsequent calls behave normally for their own `requested` window.

### 2.3 Normal rejection branch — lines 1112–1168

```js
const sessionResult = await db.query(
  `UPDATE session SET status = 'rejected', ended_at = NOW(), request_timeout_schedule = NULL
   WHERE id = $1 AND mentor_id = $2 AND status = 'requested'
   RETURNING mentee_id`,
  [sessionId, userId]
);

if (sessionResult.rows.length === 0) {
  return respond(404, { error: "Session not found or not in requested state" });
}
```

This **second guard at line 1119** is dead code on the non-free-chat path (the first guard at line 966 already proved the row exists in `'requested'` with this mentor, and there is no concurrent transition between the two queries other than another race). It exists to catch the free-chat-fall-through case (line 1108: "No candidates left — fall through to normal rejection") where `request_timeout_schedule` may have been cleared by another path. Same 404 + same free-text string regardless.

Success bodies:

```js
// Free chat with no remaining candidates (lines 1124–1149):
return respond(200, { session_id: sessionId, status: "rejected" });

// Normal paid/intro rejection (line 1168):
return respond(200, { session_id: sessionId, status: "rejected" });
```

### 2.4 Idempotency

**Not idempotent.** Same pattern as accept: the second guard requires `status='requested'`, which the first call has flipped to `'rejected'`. A second `reject` call from the same mentor:

- finds 0 rows in the guard at line 960
- returns `404 { error: "Session not found or not in requested state" }`

The most common race for this UI — user double-taps "Reject" on a notification, or the OS retries the network call — produces a 404 on the retry. There is no `{ status: "rejected", already: true }` style "already-handled" success.

### 2.5 Free-chat-forward idempotency wrinkle

A retry of the *original* reject after a successful forward goes to a *different* mentor than `userId`, so the guard at line 962 fails on `mentor_id = $2` — **404, not "already forwarded."** Native action code on the original mentor's device cannot distinguish "I already declined and it's been forwarded" from "this never existed."

---

## 3. Wrong-mentor (cross-tenant) behavior

There is **no `403 Forbidden` path** in either handler. The auth check is fused with the state check via `WHERE ... AND mentor_id = $2 AND status = 'requested'`. Consequences:

| Caller | Session state | Response |
|--------|---------------|----------|
| Mentor A on a session belonging to Mentor B | `requested` | `404 { error: "Session not found or not in requested state" }` |
| Mentee on their own session | `requested` | `404` (mentee is not `mentor_id`) |
| Random authenticated user | any | `404` |

This is intentionally information-hiding (a 403 would leak existence). For native action buttons that's fine in principle, but it means: native code receiving 404 on accept/reject **cannot infer auth-failure vs state-failure vs not-found.** All three are the same response.

---

## 4. Status-code matrix

Columns:
- **A-Status / A-Body** — what `POST /session/:id/accept` returns
- **R-Status / R-Body** — what `POST /session/:id/reject` returns

(All bodies omit `headers`; `Content-Type: application/json` is set uniformly.)

| Scenario | A-Status | A-Body | R-Status | R-Body |
|----------|----------|--------|----------|--------|
| Valid accept on a `requested` session | 200 | `{ session_id, status: "active", session_type, billing_type, rate_per_minute, mentee_balance, max_duration_seconds, min_duration_secs, pref_audio, pref_video, mentee: { privacy: {...} }, agora_*? }` | n/a | n/a |
| Valid reject on a `requested` paid/intro session | n/a | n/a | 200 | `{ session_id, status: "rejected" }` |
| Valid reject on `requested` free-chat session, candidates remain (forwarded) | n/a | n/a | 200 | `{ session_id, status: "forwarded" }` |
| Valid reject on `requested` free-chat session, no candidates left | n/a | n/a | 200 | `{ session_id, status: "rejected" }` (also pushes `free_chat_unavailable` to mentee, not `session_rejected`) |
| Already accepted (status=`active`) — same mentor retries | **404** | `{ error: "Session not found or not in requested state" }` | **404** | `{ error: "Session not found or not in requested state" }` |
| Already rejected (status=`rejected`) — same mentor retries | **404** | `{ error: "Session not found or not in requested state" }` | **404** | `{ error: "Session not found or not in requested state" }` |
| Already timed out (status=`timed_out`) | 404 | same string | 404 | same string |
| Already cancelled by mentee (status=`cancelled`) | 404 | same string | 404 | same string |
| Session completed (status=`completed`) | 404 | same string | 404 | same string |
| Wrong mentor (caller is not `mentor_id`) | 404 | same string | 404 | same string |
| Mentee calls accept/reject on own session | 404 | same string | 404 | same string |
| Session in `pending` (queued, not yet `requested`) | 404 | same string | 404 | same string |
| Session id does not exist / malformed | 404 | same string | 404 | same string |
| Free-chat session was forwarded to another mentor — original mentor retries | 404 (caller no longer `mentor_id`) | same string | 404 | same string |
| Missing / expired JWT | 401 | `{ error: "Unauthorized" }` | 401 | `{ error: "Unauthorized" }` |
| DB error / unhandled throw | 500 | `{ error: "Internal server error" }` | 500 | `{ error: "Internal server error" }` |

---

## 5. Inline guards mapping terminal-state races

Both handlers use **a single fused predicate** `s.id = $1 AND s.mentor_id = $2 AND s.status = 'requested'` rather than separate `if (session.status !== 'requested') return ...` branches. There are **no per-state inline guards** like:

```js
if (session.status === 'cancelled') return respond(409, { code: 'CANCELLED_BY_MENTEE' })
if (session.status === 'timed_out') return respond(409, { code: 'TIMED_OUT' })
```

The only inline guard relevant is the **second** state check inside `handleSessionReject` at line 1119 (the post-`UPDATE ... RETURNING` zero-row check), which exists for the free-chat-fall-through edge case but maps to the same 404 with the same string.

Comparable handlers in the same file confirm the pattern:
- `handleSessionCancel` (line 1190): `respond(404, { error: "Session not found or cannot be cancelled" })`
- `handleSessionEnd` (line 1230): `respond(404, { error: "Active session not found" })`
- `handleSubmitReview` (line 2598): `respond(403, { error: "Only the mentee can review a session" })` — **the only handler in the file that uses 403** for an authorization mismatch.

---

## 6. Cross-check: do accept and reject share an error contract?

| Aspect | Accept | Reject | Match? |
|---|---|---|---|
| Status guard SQL | `id=$1 AND mentor_id=$2 AND status='requested'` | `id=$1 AND mentor_id=$2 AND status='requested'` | yes |
| Failure status code | 404 | 404 | yes |
| Failure body | `{ error: "Session not found or not in requested state" }` | `{ error: "Session not found or not in requested state" }` (verbatim match) | yes |
| Success status code | 200 | 200 | yes |
| Success body shape | rich (12+ fields, agora, privacy) | minimal (`{ session_id, status }`) | **no** |
| `status` field values in success body | `"active"` | `"rejected"` or `"forwarded"` | divergent (expected) |
| Has 403 path | no | no | yes (both fuse auth into 404) |
| Has 409 / Conflict path | no | no | yes |
| Has structured `code` field | no | no | yes |

The error contract is **uniform between the two**, but minimal: status alone is the discriminator, and free-text `error` is human-readable only.

---

## 7. Contract gaps for native action-button consumers

The OS-level Accept/Reject buttons need the response to drive a small state machine without app UI. The current contract has the following gaps:

### 7.1 No idempotency on retry — **the highest-impact gap**
Both handlers gate strictly on `status='requested'`. Any retry (network retry, double-tap, OS background re-delivery of a notification action) of an already-completed action returns `404` with a string indistinguishable from "session deleted." Native code that maps `404 → "couldn't process"` will surface a misleading error toast even though the user's action *did* succeed on the first call. The semantic the UI wants — "ok, already-handled" — has no representation in the current contract.

### 7.2 No `code` discriminator
Every error is `{ error: "<free-text>" }`. To branch on "already-handled" vs "expired" vs "wrong-user" vs "not-found", native code would need to **string-match the `error` value** — fragile, will break on any wording change, and right now isn't even possible because all five cases share one string.

### 7.3 All terminal-state races map to the same code
`already-accepted`, `already-rejected`, `timed_out`, `cancelled-by-mentee`, `completed`, `pending-not-yet-requested` — all return `404` with the same body. Native code cannot show "the mentee cancelled while you were deciding" vs "this session has timed out" vs "you already accepted this on another device."

### 7.4 No 403 for wrong-mentor
Cross-tenant access is hidden under 404. A defensible privacy choice for a regular API, but for a notification-driven flow where the OS may deliver the same notification to a logged-out / re-logged-in device with a different user, native code cannot distinguish "you don't own this" from "this is gone."

### 7.5 No 409 / Conflict status
The natural HTTP semantic for "the resource exists but is in a state incompatible with the requested transition" is `409 Conflict`. Neither handler uses it. Everything terminal is 404.

### 7.6 Free-chat forwarding is a hidden state for the original mentor
On a free-chat reject that succeeds via forwarding, the original mentor receives `200 { status: "forwarded" }`. Good. But a *retry* of that same call after the forward is `404`. There is no `{ status: "already_forwarded" }` for the retry case.

### 7.7 Asymmetric success body
A native consumer that wants to write a single shared "request succeeded" handler in Swift/Kotlin has to special-case accept (rich body, may include Agora tokens) vs reject (minimal). Not strictly a gap — accept genuinely has more to return — but worth flagging that the parser code paths cannot be unified.

### 7.8 No envelope / no version field
There is no top-level `{ ok: true/false, code, data }` envelope. Adding `code` later is non-breaking only if native code has been written to ignore unknown fields and not assume `error` presence implies failure (e.g. a future shape `{ status: "active", code: "OK", ... }`). Worth flagging before native code locks in a parser.

### 7.9 Side-effects outside the DB transaction
Accept's transaction (lines 685–762) covers DB only. SFN start, DDB system-message write, FCM push, presence broadcast, and Agora token mint all run *after* `COMMIT`. SFN start failure is **caught and swallowed** at lines 858–860 — the response is still 200 even though the session timer was not armed. Not strictly an idempotency issue (the session is `active`, retries 404), but it means a "successful" 200 response does not guarantee all downstream side effects fired. Native code treating 200 as "everything worked" can be wrong.

### 7.10 No request-id / correlation field on errors
Errors carry no request id. Debugging "user reports reject didn't work" against CloudWatch is by timestamp + user only. Native bug reports cannot include a stable correlation id.

---

## 8. Summary

- **Idempotency:** Neither endpoint is idempotent. Both gate strictly on `status='requested'` and a second call returns `404` indistinguishable from "session does not exist."
- **Error shape:** Flat `{ error: "<string>" }`. No `code` discriminator. No envelope. Status code is the only branch primitive.
- **Inline state guards:** None — both handlers fuse auth + state into a single SQL predicate. Five+ distinct failure modes (already-accepted, already-rejected, timed-out, cancelled-by-mentee, wrong-mentor, not-found, pending-not-yet-requested) all return the same 404 + same free-text string.
- **Top gap for native action buttons:** A retry of either action (the most likely real-world scenario) cannot be distinguished from "session no longer exists." There is no machine-readable "already handled" success or `code: "ALREADY_*"` error.
- **Contracts symmetric across accept/reject:** Yes — both use the same 404 body for all failure modes. So any fix to the contract should be applied symmetrically.

---

## 9. References

- `mentortalk-session/src/sessionHandler.js:74` — `respond` helper
- `mentortalk-session/src/sessionHandler.js:236-242` — route registration
- `mentortalk-session/src/sessionHandler.js:302-308` — top-level catch (401 / 500 paths)
- `mentortalk-session/src/sessionHandler.js:662-952` — `handleSessionAccept`
- `mentortalk-session/src/sessionHandler.js:666-676` — accept guard
- `mentortalk-session/src/sessionHandler.js:924-951` — accept success body
- `mentortalk-session/src/sessionHandler.js:956-1169` — `handleSessionReject`
- `mentortalk-session/src/sessionHandler.js:960-968` — reject guard (first)
- `mentortalk-session/src/sessionHandler.js:1112-1121` — reject guard (second; free-chat fall-through)
- `mentortalk-session/src/sessionHandler.js:1105` — `status: "forwarded"` success
- `mentortalk-session/src/sessionHandler.js:1149,1168` — `status: "rejected"` successes
- `mentortalk-session/src/sessionHandler.js:1190` — `handleSessionCancel` 404 string (similar pattern)
- `mentortalk-session/src/sessionHandler.js:2598` — only 403 in the file (`handleSubmitReview`)
