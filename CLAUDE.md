# CLAUDE.md

Context for AI agents working on this repo.

## Project

This is `mentortalk-backend` — serverless Node.js Lambdas behind API Gateway in `ap-south-1`, plus WebSocket handlers, that power the MentorTalk platform.

Part of the MentorTalk project. Sibling repos:
- `mentortalk` — Flutter mentor + mentee apps
- `mentortalk-backend` — this repo
- `mentortalk-admin-panel` — Next.js admin panel + admin Lambda
- `mentortalk-web` — marketing site
- `mentortalk-docs` — single source of truth for all project documentation

## Documentation

All project docs live in `../mentortalk-docs/` (cloned alongside this repo).

**Always read relevant docs before making changes:**

- `../mentortalk-docs/schema/schema.md` — DB schema (read before any DB/API work)
- `../mentortalk-docs/schema/migrations/` — SQL migration files
- `../mentortalk-docs/mentortalk-backend-architecture.md` — Lambda layout, AWS infrastructure
- `../mentortalk-docs/mentortalk_accounting.md` — financial flows, transaction types
- `../mentortalk-docs/policies/` — privacy, refund, retention
- `../mentortalk-docs/audits/` — past code audits
- `../mentortalk-docs/release/` — sprint plans, launch checklists
- `../mentortalk-docs/strategy/` — product roadmap, business decisions
- `../mentortalk-docs/session/` — MentorTalk session feature
- `../mentortalk-docs/claude/` — past agent prompts and design context

If `../mentortalk-docs/` is missing, ask the user to clone it:

```
git clone https://github.com/prabhatakhoon/mentortalk-docs.git ../mentortalk-docs
```

This repo's own `audit/` folder holds per-Lambda audit notes that are specific to this codebase (e.g. `I15_audit1_fcm_payloads.md`); those stay here, not in `mentortalk-docs`.

## Conventions specific to this repo

- **Layout:** each top-level folder is one deployable Lambda, with its own `package.json` and `node_modules`. No shared package — helpers like `fcmHelper.js` are copy-pasted across Lambdas (see `audit/I15_audit1_fcm_payloads.md` for the canonical list of duplicates).
- **Module system:** ESM (`"type": "module"` in each `package.json`); use `import` not `require`.
- **DB access:** raw SQL via `pg.Pool` with positional params (`$1`, `$2`). Pool created once per Lambda container in a `getPool()` helper that lazily reads credentials from Secrets Manager (`mentortalk/db-app-credentials`). No ORM, no query builder.
- **Auth:** JWT verified inline at the start of every handler via `jwt.verify(token, secret)` where the secret comes from Secrets Manager (`mentortalk/jwt-secret`). Role enforcement is checked manually (`if (decoded.role !== "mentor") return respond(403, ...)`).
- **Routing:** a single `handler` function dispatches on `event.httpMethod` + `event.resource`/`event.path` using `if` chains — no router library.
- **Response shape:** use the `respond(statusCode, body)` helper. It always sets `Content-Type: application/json` and `Access-Control-Allow-Origin: *`.
- **Validation errors:** typically `respond(400, { error: "<message>" })`. The mentor payouts endpoints use `respond(422, { message: "Validation failed", errors })` via a `respond422(errors)` helper — match the local convention of the surrounding handler rather than imposing one.
- **File uploads:** S3 presigned URLs (`@aws-sdk/s3-request-presigner`) — PUT URLs default to 300s TTL, GET URLs to 3600s. Bucket is `mentortalk-storage-prod` in `ap-south-1`.
- **Logging:** plain `console.log` / `console.error`. No logger library.
- **Region:** every AWS SDK client is hard-coded to `ap-south-1`.

## Workflow

1. Audit the relevant area of the codebase
2. Read relevant files in `../mentortalk-docs/`
3. Propose a plan
4. Wait for user approval
5. Then code

## Don't add docs files to this repo

New documentation goes in `mentortalk-docs`, not here. Schema migrations go in `../mentortalk-docs/schema/migrations/`, with `schema.md` updated in the same PR.

The `audit/` folder is the one exception — it holds per-Lambda audit notes specific to this backend codebase.
