# I15 Session State Transition Audit

Repo root: `C:\Users\h5cd2\workspace\mentortalk\lambda\`
Audit performed: 2026-05-03
Purpose: enumerate every code path that flips `session.status` to `'requested'`, document the guard each path uses, and confirm or refute the hypothesis that **no DB-level invariant prevents two `'requested'` sessions for the same mentor concurrently**.

Read-only audit. No fixes.

---

## TL;DR

**Hypothesis confirmed.** There is no DB-level invariant. `session` has no partial unique index of the form `UNIQUE (mentor_id) WHERE status = 'requested'`, no application-level row lock (`SELECT … FOR UPDATE`), and no advisory lock anywhere in the lambda repo. Concurrency safety relies entirely on per-statement read-modify-write windows that are **not atomic across the request flow**. Two `'requested'` rows for the same `mentor_id` are reachable through at least three independent races, the most concerning of which is the new-request path (`POST /session/request` → `handleSessionRequest`).

State diagram (entry paths into `requested`):

```
                            ┌──────────────────────────┐
                            │  POST /session/request   │  (mentee → free mentor; INSERT)
                            │  handleSessionRequest    │  ──► UPDATE → none
                            │  (sessionHandler.js:571) │      INSERT status='requested'
                            └────────────┬─────────────┘
                                         │
                                         ▼
                            ┌────────────────────────────┐
                            │  POST /session/free-chat   │  (free-chat first dispatch; INSERT)
                            │  handleFreeChat            │  ──► INSERT status='requested'
                            │  (sessionHandler.js:1752)  │      with billing_type='free_intro'
                            └────────────┬───────────────┘
                                         │
                                         ▼
                  ┌──────────────────────────────────────────────┐
                  │  promoteNextPendingSession                   │  (UPDATE pending→requested,
                  │  fired by handleSessionEnd /                 │   invoked from THREE Lambdas:
                  │  sessionTimeout / sessionGracePeriod         │     session  (line 1538),
                  │                                              │     session-timeout (line 445),
                  │  UPDATE session SET status='requested'       │     grace-period (line 321))
                  │  WHERE id = (SELECT id … LIMIT 1)            │
                  │                                              │
                  └──────────────────────────────────────────────┘
                                         │
                                         ▼
                  ┌──────────────────────────────────────────────┐
                  │  freeChatTimeout — FORWARD path              │  (mentor_id reassignment;
                  │  UPDATE session SET mentor_id = $next        │   status STAYS 'requested',
                  │  (freeChatTimeout.js:273)                    │   so this is *not* a status flip
                  │                                              │   but it does move a 'requested'
                  │                                              │   row onto a different mentor)
                  └──────────────────────────────────────────────┘
                                         │
                                         ▼
                                ┌────────────────┐
                                │  status =      │
                                │  'requested'   │
                                └────────────────┘
```

There are exactly **three SQL statements** in the entire repo that set `session.status = 'requested'`, plus one INSERT that creates it directly. Each is documented below.

---

## 1) Direct INSERT — `POST /session/request` → `handleSessionRequest`

**File:** `mentortalk-session/src/sessionHandler.js`
**Function:** `handleSessionRequest` (line 419)
**Status transition:** none → `'requested'` (or `'pending'` if mentor busy)

### Read-then-write that picks `requested` vs `pending`

The handler runs five sequential `db.query` calls before the INSERT, each on a separate pool checkout:

```js
// sessionHandler.js:522-528 — mentee-side guard
const menteeActiveSession = await db.query(
  `SELECT id FROM session
   WHERE mentee_id = $1
     AND status IN ('requested', 'active', 'pending')`,
  [menteeId]
);
if (menteeActiveSession.rows.length > 0) { return respond(409, …); }
```

```js
// sessionHandler.js:537-545 — mentor busy check
const mentorActiveSession = await db.query(
  `SELECT id FROM session
   WHERE mentor_id = $1
     AND status = 'active'`,
  [mentor_id]
);
const mentorIsBusy = mentorActiveSession.rows.length > 0;
```

```js
// sessionHandler.js:564-569 — branch selector
let sessionStatus;
if (mentorIsBusy) {
  sessionStatus = "pending";
} else {
  sessionStatus = "requested";
}
```

```js
// sessionHandler.js:571-576 — INSERT
const sessionResult = await db.query(
  `INSERT INTO session (mentee_id, mentor_id, status, requested_session_type, billing_type, started_at)
   VALUES ($1, $2, $3, $4, $5, NOW())
   RETURNING id, status, started_at`,
  [menteeId, mentor_id, sessionStatus, session_type, billingType]
);
```

### Guards present

- **Mentee-side:** `WHERE mentee_id = $1 AND status IN ('requested', 'active', 'pending')` — but this is per-mentee, not per-mentor. It only prevents a mentee from issuing two requests at once.
- **Mentor-side:** `WHERE mentor_id = $1 AND status = 'active'` — checks `'active'` only. **`'requested'` is not in the predicate.** A second mentee whose request lands while the mentor already has a `requested` row will fall into the `else` branch (line 568) and INSERT a second `'requested'` row.

### Atomicity

**None.** No `BEGIN/COMMIT`, no `SELECT … FOR UPDATE`, no advisory lock, no UPSERT-with-conflict. Each SQL statement runs on its own connection. The window between line 545 (`mentorIsBusy` decided) and line 575 (INSERT executes) is bounded only by network latency to Postgres — easily 50–200 ms.

### What happens if a second mentee request arrives?

| Scenario at moment T1 | What handler #2 sees | Result |
| --- | --- | --- |
| Mentor's only existing session is in `'active'` | `mentorIsBusy = true` → status `'pending'` | Correctly queued |
| Mentor's only existing session is in `'requested'` (race window) | `mentorIsBusy = false` (line 541 only checks `'active'`) → status `'requested'` | **Two concurrent `'requested'` rows on same mentor_id** |
| Mentor's only existing session is in `'pending'` | `mentorIsBusy = false` → status `'requested'` | New `'requested'` created; old `'pending'` keeps queue position (still consistent — the new one will accept, the old one stays queued; but also no protection if both end up `'requested'` later) |

**This is the primary race.** Two simultaneous mentees tapping the same free mentor will both see `mentorIsBusy = false` if neither has yet INSERTed, and then both INSERT `'requested'`. The mentor's app receives two `session_request` WebSocket pushes. Whichever the mentor accepts first flips one row to `'active'`; the second `'requested'` row remains live (with its own 60s timeout schedule) and will continue to ring or eventually `'timed_out'`. Worse, if the mentor accepts both in quick succession (double-tap on stacked notifications), the second accept's guard (`AND status = 'requested'`, line 670) will succeed too, leaving **two `'active'` sessions on one mentor** — an inconsistent state the rest of the system was not designed to handle (presence, billing SFN, Agora channels all assume singleton).

---

## 2) Direct INSERT — `POST /session/free-chat` → `handleFreeChat`

**File:** `mentortalk-session/src/sessionHandler.js`
**Function:** `handleFreeChat` (line 1640)
**Status transition:** none → `'requested'` (`billing_type = 'free_intro'`)

```js
// sessionHandler.js:1752-1758
const sessionResult = await db.query(
  `INSERT INTO session
     (mentee_id, mentor_id, status, requested_session_type, billing_type, started_at)
   VALUES ($1, $2, 'requested', 'chat', 'free_intro', NOW())
   RETURNING id, status`,
  [menteeId, selectedMentor.user_id]
);
```

### Guards present

- **Mentee-side:** lines 1666-1677, same `mentee_id IN ('requested', 'active', 'pending')` short-circuit.
- **Mentor-side:** the candidate-mentor selection query (lines 1691-1717) uses `NOT EXISTS (SELECT 1 FROM session s WHERE s.mentor_id = mp.user_id AND s.status = 'active')` — `'active'` only. No check for an existing `'requested'`.

### Atomicity

**None.** Read-then-write. Same race shape as Path #1, plus the additional fan-out: free chat ranks five candidates and falls through to a chosen one. If two free-chat mentees race onto the same first-ranked mentor, both INSERTs succeed.

### What happens with a second concurrent free-chat request?

Two `'requested'` rows for the same `mentor_id`. The mentor app receives two free-chat session-request pushes. Same outcome shape as Path #1.

---

## 3) Promotion — `pending` → `requested` (UPDATE)

A single shared SQL idiom is duplicated across three Lambdas. It runs after a session ends, regardless of whether the end was natural, timeout-driven, or grace-period-driven.

### Call sites

| Lambda | File | Line | Caller |
| --- | --- | --- | --- |
| `mentortalk-session` | `sessionHandler.js` | 1538 (def), 1525 (call) | `handleSessionEnd` |
| `mentortalk-session-timeout` | `sessionTimeout.js` | 445 (def), 430 (call) | scheduled balance/duration timeout |
| `mentortalk-grace-period` | `sessionGracePeriod.js` | 321 (def), 305 (call) | scheduled disconnect grace expiry |

### The SQL (identical in all three Lambdas)

```js
// sessionHandler.js:1538-1550 (also sessionTimeout.js:445-457, sessionGracePeriod.js:321-333)
async function promoteNextPendingSession(db, mentorId) {
  const pendingResult = await db.query(
    `UPDATE session
     SET status = 'requested', started_at = NOW()
     WHERE id = (
       SELECT id FROM session
       WHERE mentor_id = $1 AND status = 'pending'
       ORDER BY started_at ASC
       LIMIT 1
     )
     RETURNING id, mentee_id, requested_session_type`,
    [mentorId]
  );
  …
}
```

### Guards present

- **`WHERE mentor_id = $1 AND status = 'pending'`** in the inner SELECT — this is a *self-guard*: the row promoted must currently be `'pending'`.
- **`LIMIT 1`** — promotes exactly one queued session.

The UPDATE itself is atomic at the row level (a single statement is its own transaction in Postgres), so two parallel calls to `promoteNextPendingSession` for the same `mentorId` cannot both promote the *same* `'pending'` row — Postgres's MVCC will let exactly one win and the other will find no row to update.

### What is **not** guarded

The UPDATE does **not** check that no `'requested'` row already exists for `mentor_id`. The only invariant it enforces is "promote one `'pending'` row." If by any prior path (Path #1 or Path #2 racing in the same instant, or duplicate Lambda invocations of the ending handler — see below) a `'requested'` row already exists for this mentor, a second one is created here.

### How can two `promoteNextPendingSession` calls happen?

EventBridge Scheduler at-least-once delivery + the absence of an idempotency token. Specifically:

1. **`handleSessionEnd` and `sessionGracePeriod.handler` both fire for the same session** when the mentee taps "End" inside the grace window. `handleSessionEnd` only guards `WHERE id = $1 AND status = 'active'` (line 1224). The grace-period scheduler still fires its 5s/90s schedule and runs its own COMMIT path including `promoteNextPendingSession` (sessionGracePeriod.js:305) — but its own status guard (`WHERE id = $1 AND status = 'active'`, line 96) means it bails out cleanly because the row is now `'completed'`. **Cleared this case — not a real race for promotion.**
2. **`sessionTimeout.handler` retries** if its first invocation throws after the COMMIT but before returning. Step Functions has internal retry semantics; on retry, the session is `'completed'` so its outer guard at sessionTimeout.js:149 short-circuits. **Cleared.**
3. **The real risk is Path #1 / Path #2 racing with promotion.** A mentee fires `POST /session/request` at the same instant the mentor's previous session ends. The new-request handler's `mentorIsBusy` check runs against the row at status `'active'` (still), so it picks `'pending'`. Microseconds later, the ending handler commits the previous session as `'completed'` and runs `promoteNextPendingSession`, which finds the just-INSERTed `'pending'` row and promotes it. Net effect: one `'requested'` row, correct. **However**: if the new-request handler's `mentorIsBusy` check runs *after* the previous session was committed `'completed'` but *before* the promotion UPDATE has run, the new request INSERTs `'requested'` directly, and then the promotion UPDATE finds the older `'pending'` row and *also* promotes it to `'requested'`. **Two concurrent `'requested'` rows.** This is the second concrete race window.

---

## 4) Free-chat forwarding — mentor reassignment with status unchanged

**Files:**
- `mentortalk-free-chat-timeout/src/freeChatTimeout.js` (line 273)
- `mentortalk-session/src/sessionHandler.js` (line 1024 — the reject-then-forward branch inside `handleSessionReject`)

**Status transition:** none — the row stays in `'requested'`. Only `mentor_id` changes.

```js
// freeChatTimeout.js:272-276
await db.query(
  `UPDATE session SET mentor_id = $2, request_timeout_schedule = NULL WHERE id = $1`,
  [sessionId, nextMentor],
);
```

```js
// sessionHandler.js:1024-1027 (reject-then-forward branch)
await db.query(
  `UPDATE session SET mentor_id = $2, request_timeout_schedule = NULL WHERE id = $1`,
  [sessionId, nextMentor]
);
```

### Why this matters for the hypothesis

The hypothesis is about "two `'requested'` sessions for the same mentor." Forwarding **moves** a `'requested'` session onto `nextMentor`. If `nextMentor` already has a `'requested'` row from another path (e.g., a paid-session `POST /session/request` racing with the forward), now there are two `'requested'` rows on `nextMentor`.

### Guards present

- The candidate selection (lines 197-228 in `freeChatTimeout.js`, lines 991-1020 in `sessionHandler.js`) checks `NOT EXISTS (… status = 'active')` and presence/quota — **but not** `NOT EXISTS (… status = 'requested')`. A mentor with an open `'requested'` paid request is still considered eligible to receive a forwarded free-chat request.

### Atomicity

The UPDATE itself is atomic, but the read-then-write window between the candidate-eligibility check and the UPDATE is not.

---

## 5) Other status transitions — sanity check

For completeness, the audit verified that the following transitions exist and do not introduce additional `'requested'` entry points:

| Transition | Where | Note |
| --- | --- | --- |
| `'requested' → 'active'` | `handleSessionAccept`, sessionHandler.js:690 | Inside `BEGIN/COMMIT`. Conditional on `s.status = 'requested'` at the SELECT (line 670). Not idempotent — see audit `I15_audit4_accept_reject_idempotency.md`. |
| `'requested' → 'rejected'` | `handleSessionReject`, sessionHandler.js:1113 | Conditional UPDATE `WHERE … AND status = 'requested'`. |
| `'requested' → 'cancelled'` | `handleSessionCancel`, sessionHandler.js:1184 | Conditional UPDATE `WHERE … AND status IN ('requested', 'pending')`. |
| `'requested' → 'timed_out'` | `requestTimeout.handler`, requestTimeout.js:115 | **Read-then-write** (line 95-99 SELECT, line 115-119 UPDATE) with no `WHERE status='requested'` on the UPDATE. The read at line 109 short-circuits if status drifted. Sufficient because the schedule fires once per session and the worst-case drift is "no-op." |
| `'requested' → 'timed_out'` (free chat, no candidates) | `freeChatTimeout.handler`, freeChatTimeout.js:237 | Same shape. |
| `'pending' → 'cancelled'` | `handleSessionCancel`, sessionHandler.js:1184 | Same UPDATE as `'requested' → 'cancelled'`. |
| `'active' → 'completed'` | `handleSessionEnd`, sessionTimeout, sessionGracePeriod | Inside `BEGIN/COMMIT`. Each guards on `status='active'`. |

None of these transitions create a path *into* `'requested'`.

---

## 6) DB-level constraint check — refuting the existence of an invariant

### `schema.md` review (lambda repo root)

`C:\Users\h5cd2\workspace\mentortalk\lambda\schema.md` lines 375-413 describe the `session` table and lifecycle. The table description lists no UNIQUE constraint on any combination involving `mentor_id` and `status`. The only column-level uniqueness mentioned anywhere in the doc that involves `mentor_id` is on **payouts** (line 534):

> **Idempotency:** unique partial index on `(mentor_id, period_start, period_end) WHERE status != 'failed'` prevents duplicate payouts for the same cycle.

This is not the session table.

### Migration files (sibling `source/mentortalk` repo)

Two folders contain SQL:
- `C:\Users\h5cd2\workspace\mentortalk\source\mentortalk\backend\migrations\` — only `V003_free_chat_promo.sql`.
- `C:\Users\h5cd2\workspace\mentortalk\source\mentortalk\docs\schema\migration\` — `V004_role_scoping.sql`, `V005_mentee_privacy_settings.sql`, `V006_drop_retool_email(outdated).sql`, `V007_mentor_payout.sql`.

V003 only **adds** `session.billing_type` (line 79: `ALTER TABLE session ADD COLUMN billing_type …`). No CREATE TABLE, no CREATE UNIQUE INDEX on session.

V004–V007 do not touch the `session` table. Searched with `grep -i session` across both directories — only V003 references session, and only to add `billing_type`.

### Where is the original `session` DDL?

**No CREATE TABLE for `session` exists anywhere on disk** (lambda repo, source repo, or admin-panel repo — verified by globbing all `*.sql` files and grepping for `CREATE TABLE` patterns). The session table was bootstrapped outside the migration system (likely via Retool/RDS console at project genesis), and only delta migrations are versioned. As a consequence:

1. The doc-level summary in `schema.md` is the only authoritative description of constraints.
2. `schema.md` lists no partial unique index on `session(mentor_id) WHERE status = 'requested'`.
3. No code in any Lambda creates such an index at runtime.

### `pg_advisory_lock` / `SELECT FOR UPDATE` / `SERIALIZABLE` check

```
grep -i 'FOR UPDATE\|advisory_lock\|pg_advisory\|SERIALIZABLE' lambda/
→ no matches
```

There is **zero** application-level Postgres-locking infrastructure in the lambda repo. The only `BEGIN/COMMIT` blocks are inside `handleSessionAccept`, `handleSessionEnd`, `handleFreeChat` (no — that one is single-statement INSERT), `sessionTimeout.handler`, and `sessionGracePeriod.handler` — and those wrap multi-row updates within a *single* session's lifecycle, not cross-session arbitration.

---

## 7) Race summary — concrete attack scenarios

### Race A: two mentees, one free mentor (Path #1 vs Path #1)

| Step | Mentee A handler | Mentee B handler | Mentor's session table |
| --- | --- | --- | --- |
| T0 | (idle) | (idle) | (no rows for this mentor) |
| T1 | SELECT mentor_active → 0 rows | | |
| T2 | | SELECT mentor_active → 0 rows | |
| T3 | INSERT status='requested' (A) | | 1 row: A `'requested'` |
| T4 | | INSERT status='requested' (B) | **2 rows: A and B both `'requested'`** |

Window between T1/T2 and T3/T4: ≈100 ms typical pool-roundtrip.

### Race B: new request vs queue promotion (Path #1 vs Path #3)

| Step | New `POST /session/request` (mentee B) | Ending session (mentor's `handleSessionEnd` for mentee A) | Table state |
| --- | --- | --- | --- |
| T0 | | A is `'active'` | 1 row: A `'active'` |
| T1 | SELECT mentor_active → 1 row → `mentorIsBusy=true` | | A `'active'` |
| T2 | INSERT status='pending' (B) | | A `'active'`, B `'pending'` |
| T3 | | UPDATE A → `'completed'` (inside BEGIN/COMMIT) | A `'completed'`, B `'pending'` |
| T4 | | promoteNextPendingSession → UPDATE B → `'requested'` | A `'completed'`, B `'requested'` |

This case is **safe** — net result is one `'requested'`. Now consider the reordering:

| Step | New `POST /session/request` (mentee B) | Ending session (mentee A) | Table state |
| --- | --- | --- | --- |
| T0 | | A is `'active'` | A `'active'` |
| T1 | | UPDATE A → `'completed'` | A `'completed'` |
| T2 | | promoteNextPendingSession → SELECT pending → 0 rows → return early | A `'completed'` |
| T3 | SELECT mentor_active → 0 rows → `mentorIsBusy=false` | | A `'completed'` |
| T4 | INSERT status='requested' (B) | | A `'completed'`, B `'requested'` |

Also **safe** — one `'requested'`. The dangerous interleave:

| Step | New `POST /session/request` (mentee B) | Ending session (mentee A) | New `POST /session/request` (mentee C) | Table state |
| --- | --- | --- | --- | --- |
| T0 | | A is `'active'` | | A `'active'` |
| T1 | SELECT mentor_active → 1 → `mentorIsBusy=true` | | | A `'active'` |
| T2 | INSERT status='pending' (B) | | | A `'active'`, B `'pending'` |
| T3 | | UPDATE A → `'completed'`; promote B → `'requested'` | | A `'completed'`, B `'requested'` |
| T4 | | | SELECT mentor_active → 0 → `mentorIsBusy=false` | A `'completed'`, B `'requested'` |
| T5 | | | INSERT status='requested' (C) | A `'completed'`, B `'requested'`, **C `'requested'`** |

Two concurrent `'requested'` rows. Mentee C's handler at T4 only checked `'active'`; B is `'requested'` so it doesn't trip the guard.

### Race C: free-chat forward onto a mentor with an open paid `'requested'`

Mentor M has an open paid `'requested'` from mentee X. Free-chat flow forwards to M as the next candidate (the eligibility check at `freeChatTimeout.js:205-208` only excludes `'active'`). M now has two `'requested'` rows: X's paid one and the forwarded free-chat one.

---

## 8) Confirmation — answer to the hypothesis

> **Hypothesis:** there is no DB-level invariant preventing two `'requested'` sessions from existing for the same mentor concurrently.

**Confirmed.** Evidence:

1. **No partial unique index** on `session(mentor_id) WHERE status = 'requested'` is documented in `schema.md`, present in any migration file (`V003`–`V007`), or created by any Lambda at runtime.
2. **No SELECT FOR UPDATE / advisory lock** anywhere in the lambda repo.
3. **The application-level guard is incomplete:** the new-request handler (`sessionHandler.js:537-545`) checks `WHERE mentor_id = $1 AND status = 'active'` only — `'requested'` is excluded from the predicate.
4. **The promotion handler does not check** for an existing `'requested'` row before promoting a `'pending'`.
5. **The free-chat forward handler does not check** for an existing `'requested'` row on the next-mentor candidate.
6. Three concrete race scenarios (A, B, C above) each produce two `'requested'` rows for the same `mentor_id` under realistic timing.

The most concerning race window is **Race A** (two mentees, one free mentor) because (a) it is reachable with no prior session activity — just two mentees tapping the same mentor, (b) it ends with the mentor's app receiving two `session_request` WebSocket pushes that look identical in structure, and (c) if the mentor double-taps "Accept" on the stacked notifications (or if the mentor app auto-accepts the topmost), the accept handler at `sessionHandler.js:670` will succeed for both because each row independently satisfies `status = 'requested'`. The downstream code (Agora, SFN timeout, presence) silently breaks under two `'active'` rows for one mentor.

There is currently **nothing** preventing the race — neither a DB invariant, nor a code-level lock, nor a mentor-app-side queue. The 60s request-timeout schedule does not help because both rows get their own schedule.

---

## File:line index

| File | Line | What |
| --- | --- | --- |
| `mentortalk-session/src/sessionHandler.js` | 419 | `handleSessionRequest` entry |
| `mentortalk-session/src/sessionHandler.js` | 522-528 | Mentee-side guard SELECT |
| `mentortalk-session/src/sessionHandler.js` | 537-545 | Mentor-busy check (`status='active'` only) |
| `mentortalk-session/src/sessionHandler.js` | 564-569 | `mentorIsBusy → pending else requested` branch |
| `mentortalk-session/src/sessionHandler.js` | 571-576 | INSERT with chosen status |
| `mentortalk-session/src/sessionHandler.js` | 1525 | Call site of `promoteNextPendingSession` from `handleSessionEnd` |
| `mentortalk-session/src/sessionHandler.js` | 1538-1550 | `promoteNextPendingSession` SQL |
| `mentortalk-session/src/sessionHandler.js` | 1666-1677 | `handleFreeChat` mentee-side guard |
| `mentortalk-session/src/sessionHandler.js` | 1691-1717 | `handleFreeChat` candidate select (only `'active'` excluded) |
| `mentortalk-session/src/sessionHandler.js` | 1752-1758 | `handleFreeChat` INSERT `'requested'` |
| `mentortalk-session/src/sessionHandler.js` | 1024-1027 | reject-then-forward `mentor_id` reassignment |
| `mentortalk-session-timeout/src/sessionTimeout.js` | 430 | Call site |
| `mentortalk-session-timeout/src/sessionTimeout.js` | 445-457 | `promoteNextPendingSession` (duplicate) |
| `mentortalk-grace-period/src/sessionGracePeriod.js` | 305 | Call site |
| `mentortalk-grace-period/src/sessionGracePeriod.js` | 321-333 | `promoteNextPendingSession` (duplicate) |
| `mentortalk-free-chat-timeout/src/freeChatTimeout.js` | 197-228 | Free-chat forward candidate eligibility |
| `mentortalk-free-chat-timeout/src/freeChatTimeout.js` | 273-276 | `mentor_id` reassignment (status stays `'requested'`) |
| `mentortalk-request-timeout/src/requestTimeout.js` | 109-119 | `'requested' → 'timed_out'` (exit, not entry) |
| `lambda/schema.md` | 375-413 | Session table doc — no UNIQUE constraint listed |
| `source/mentortalk/backend/migrations/V003_free_chat_promo.sql` | 79-82 | Only ALTER on `session` in any migration (adds `billing_type`) |

---

## Items to clarify before any fix is designed

1. **Where does the original `session` DDL live?** No migration file creates the table. If a fix introduces a partial unique index, it should be authored as a new migration `V008_session_requested_uniqueness.sql` and the team should also backfill the source DDL into the migration system as a baseline (`V000` or `V001`) for replayability.
2. **What are the operational semantics of two `'requested'` rows when they're already in production?** Before adding a unique index, the migration would need to detect and resolve any existing duplicates (`UPDATE … SET status = 'cancelled'` for the older one, perhaps).
3. **Is the desired fix a partial unique index, an advisory lock keyed on `mentor_id`, or both?** The index closes the race at the cost of returning a 23505 to the second mentee — the application would need to map this to the `409` it already returns from line 530-535. An advisory lock is cheaper to fail-fast but doesn't survive process crashes.
4. **Free-chat forwarding's same-mentor double-up** is a separate dimension from the `INSERT` race — a partial unique index on `session(mentor_id) WHERE status='requested'` would also catch this case (the UPDATE at `freeChatTimeout.js:273` would fail), but the free-chat-timeout Lambda has no error-handling branch for that and would currently swallow the failure silently.
