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

## Environment Variables

All env vars are listed in `.env.example` (the committed template). Copy it to `.env.local` and populate with real values — `.env.local` is gitignored.

| Variable | Purpose | Set on |
|---|---|---|
| `API_GATEWAY_ID` | REST API ID (`485ccgtm48`), used in CLI scripts only | Developer machine |
| `WS_ENDPOINT` | WebSocket API endpoint URL, used at Lambda runtime | AWS Lambda |
| `CDN_BASE_URL` | Base URL for serving profile photos / media | AWS Lambda |
| `SCHEDULER_ROLE_ARN` | IAM role for EventBridge Scheduler | AWS Lambda |
| `GRACE_PERIOD_LAMBDA_ARN` | Lambda ARN for session grace period | AWS Lambda |
| `FREE_CHAT_TIMEOUT_LAMBDA_ARN` | Lambda ARN for free-chat timeout | AWS Lambda |
| `REQUEST_TIMEOUT_LAMBDA_ARN` | Lambda ARN for request timeout | AWS Lambda |
| `DISCONNECT_CHECK_LAMBDA_ARN` | Lambda ARN for disconnect check | AWS Lambda |
| `SFN_ARN` | Step Function state machine ARN | AWS Lambda |
| `ENABLE_TEST_ACCOUNT` | `"true"` to allow seed-test-wallet and skip some checks | AWS Lambda |
| `LAUNCH_DATE` | ISO date for platform launch (mentors see countdown) | AWS Lambda |
| `MIN_SESSION_DURATION_SECS` | Min session seconds before payout earned (default `60`) | AWS Lambda |
| `JWT_SECRET` | JWT signing key (prod uses Secrets Manager; env var for local testing only) | AWS Lambda (mentortalk-auth) |

Most vars are set as Lambda environment variables in the AWS Console. `API_GATEWAY_ID` is the exception — it's only needed locally for CLI commands like `aws apigateway create-resource`.

## Deploy scripts

### `update.ps1`
Deploy a single Lambda. Run from **PowerShell** in `mentortalk-backend/`:

```powershell
.\update.ps1 <lambda-name> "<commit message>"
```

It does: git add+commit+push → zip (`tar -acf`) → `aws lambda update-function-code` → force-tag `deploy/<lambda>/latest`.

### `deploy-many.ps1`
Deploy multiple Lambdas in one command with parallel zip+upload:

```powershell
.\deploy-many.ps1 -Lambdas ([ordered]@{
    'mentortalk-mentee-discover' = 'commit message 1'
    'mentortalk-onboarding'      = 'commit message 2'
})
```

See `../mentortalk-docs/aws-operations-manual.md` §2 for full usage, failure modes, and recovery.

### Zip pitfall: always use PowerShell `tar -acf`, never Bash

`tar -acf ..\lambda.zip *` only works with **Windows bsdtar** (resolved by PowerShell). Bash / Git Bash / WSL ship GNU tar which silently produces a tarball — AWS rejects it. Verify magic bytes before uploading:

```powershell
$bytes = [System.IO.File]::ReadAllBytes("lambda.zip")
$magic = ($bytes[0..1] | ForEach-Object { $_.ToString("X2") }) -join "-"
# Must output "50-4B" (PK header). Anything else = bad zip.
```

If `update.ps1` fails with `ABORT: lambda.zip is not a valid PK zip`, rebuild from **PowerShell**:
```powershell
cd mentortalk-backend
Remove-Item .\lambda.zip -Force -ErrorAction SilentlyContinue
Push-Location ".\mentortalk-admin"
& "$env:SystemRoot\System32\tar.exe" -acf ..\lambda.zip *
Pop-Location
aws lambda update-function-code --function-name mentortalk-admin --zip-file fileb://lambda.zip --region ap-south-1
git tag -f "deploy/mentortalk-admin/latest" HEAD
git push -f origin "deploy/mentortalk-admin/latest"
```
