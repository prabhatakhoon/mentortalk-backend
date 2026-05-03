# I11 - Mentor Payouts: API Gateway Routes

Routes to be added in API Gateway for the new mentor payouts endpoints.

## Integration

- **Target Lambda:** `mentortalk-mentor`
- **Integration type:** Lambda Proxy (AWS_PROXY)
- **Auth:** None at API Gateway level. The Lambda verifies the JWT itself via the `Authorization: Bearer <token>` header and enforces `decoded.role === 'mentor'`.
- **CORS:** Match existing `mentortalk-mentor` routes (the Lambda already returns `Access-Control-Allow-Origin: *` in its responses).

## Routes

| Method | Resource path                             | Auth (Lambda-side)                         | Notes                                                          |
| ------ | ----------------------------------------- | ------------------------------------------ | -------------------------------------------------------------- |
| GET    | /mentor/payouts/summary                   | JWT, role=mentor                           | Read-only. Returns bank + PAN status.                          |
| GET    | /mentor/payouts/bank                      | JWT, role=mentor                           | Returns masked bank details. 404 if not submitted.             |
| PUT    | /mentor/payouts/bank                      | JWT, role=mentor + approved-mentor gate    | Upserts bank, resets bank_verified=FALSE.                      |
| GET    | /mentor/payouts/pan                       | JWT, role=mentor                           | Returns masked PAN + 1hr presigned GET for PAN image.          |
| POST   | /mentor/payouts/pan/image/presign         | JWT, role=mentor + approved-mentor gate    | Returns presigned PUT URL (300s TTL).                          |
| PUT    | /mentor/payouts/pan                       | JWT, role=mentor + approved-mentor gate    | Upserts PAN, resets pan_verified=FALSE, deletes old image.    |
| GET    | /mentor/payouts                           | JWT, role=mentor                           | Cursor-paginated payout history (limit default 20, max 50).   |

## Approved-mentor gate

Write endpoints (PUT and POST) additionally require `mentorship_application.submission_status = 'approved'`. Unapproved mentors get `403 { error: "MENTOR_NOT_APPROVED", message: "Complete mentor onboarding to set up payouts." }`.

Read endpoints stay JWT-only - unapproved mentors can hit them and will receive empty / not_submitted state.

## Validation errors

Write endpoints return `422 { message: "Validation failed", errors: { field_name: ["msg", ...] } }` on bad input. The frontend is structured to consume per-field errors. This is a deliberate departure from the existing `400 { error: "..." }` pattern in `mentortalk-mentor` for these new endpoints only.

## IAM / S3 permissions required by the Lambda role

The Lambda needs permission on the `mentortalk-storage-prod` bucket for:

- `s3:PutObject` on `pan/*` (already granted if existing presigns work)
- `s3:GetObject` on `pan/*` (for the GET /mentor/payouts/pan presigned read URL)
- `s3:HeadObject` on `pan/*` (for PAN PUT existence check)
- `s3:DeleteObject` on `pan/*` (for replacing old PAN image)

If the existing role only covers `profile-photos/*` and similar prefixes, extend it to include `pan/*`.

## Smoke test order (post-deploy)

Once API Gateway routes are wired:

1. `GET /mentor/payouts/summary` -> expect `not_submitted` for both bank and PAN on a fresh approved mentor.
2. `PUT /mentor/payouts/bank` with valid body -> expect 200 with status=pending_review.
3. `GET /mentor/payouts/summary` again -> bank should now be pending_review.
4. `POST /mentor/payouts/pan/image/presign` -> upload a JPG to the returned URL.
5. `PUT /mentor/payouts/pan` with the returned s3_key -> expect 200.
6. `GET /mentor/payouts` -> expect empty list (no payouts generated yet).

## Out of scope

- Payout generation cron (separate `mentortalk-generate-payouts` Lambda).
- Admin verification endpoints (in `mentortalk-admin`).
- "Mark as paid" flow (in `mentortalk-admin`).
