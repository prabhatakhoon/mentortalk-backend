# Banners — manual ops + future CMS plan

How to manage the promotional banners shown on the mentee app's home screen, and what it would take to move this into the admin panel.

## How banners work today

- **Endpoint:** `GET /mentee/discover/banners` — handled by `getBanners()` in `mentortalk-mentee-discover/index.js:1097`.
- **DB table:** `banner` (see `../mentortalk-docs/schema/schema.md` § "banner").
  - `image_url` stores an **S3 key** (e.g. `banners/start_chatting.png`), not a full URL.
  - `action` is the deep link or URL the mentee app opens when the banner is tapped.
  - `position` controls display order (ASC).
  - `is_active`, `starts_at`, `ends_at` control visibility — the endpoint filters on all three.
- **URL construction:** the lambda prepends `CDN_BASE_URL` to the stored key in `resolvePhotoUrl()` at `mentortalk-mentee-discover/index.js:159`.
- **Storage / CDN:**
  - Bucket: `mentortalk-storage-prod` (region `ap-south-1`)
  - Banner prefix: `banners/`
  - CloudFront distribution: `E1QSMCKVE26SSD` → `https://d3qje7pdvgj2dw.cloudfront.net`

So a row with `image_url = 'banners/foo.png'` is served at `https://d3qje7pdvgj2dw.cloudfront.net/banners/foo.png`.

---

## Add a new banner

Preferred path — use a **new key** so no CloudFront invalidation is needed.

1. Upload the image to S3:

   ```powershell
   aws s3 cp .\my-new-banner.png s3://mentortalk-storage-prod/banners/my-new-banner.png `
     --content-type image/png
   ```

   Use the right `--content-type` (`image/png`, `image/jpeg`, `image/webp`).

2. Insert a row in the `banner` table. `image_url` is the S3 key (no leading slash, no domain):

   ```sql
   INSERT INTO banner (id, image_url, action, position, is_active, starts_at, ends_at)
   VALUES (
     gen_random_uuid(),
     'banners/my-new-banner.png',
     'mentortalk://search?category=design',  -- or an https:// URL
     10,                                      -- position (lower = earlier)
     true,
     NULL,                                    -- starts_at: NULL = active immediately
     NULL                                     -- ends_at:   NULL = no expiry
   );
   ```

   Brand-new key → CloudFront has nothing cached → no invalidation needed.

---

## Update an existing banner

### Just changing `action`, `position`, schedule, or `is_active`

Pure DB update, no S3 or CloudFront involved:

```sql
UPDATE banner
SET position = 1, is_active = true
WHERE id = '<uuid>';
```

### Replacing the image at the same S3 key

CloudFront caches by key — same key + new bytes means stale users until the cache expires. Two options:

**Option A — same key + invalidate (what we did for `start_chatting.png`):**

```powershell
# 1. overwrite the object
aws s3 cp .\start_chatting.png s3://mentortalk-storage-prod/banners/start_chatting.png `
  --content-type image/png

# 2. invalidate the CloudFront edge cache
#    Inline --paths "/banners/foo.png" can fail on Windows with
#    "InvalidArgument: invalid invalidation paths" — use the JSON-file form.
```

Create `invalidation.json`:

```json
{
  "Paths": {
    "Quantity": 1,
    "Items": ["/banners/start_chatting.png"]
  },
  "CallerReference": "banner-update-2026-05-05-1"
}
```

Then:

```powershell
aws cloudfront create-invalidation `
  --distribution-id E1QSMCKVE26SSD `
  --invalidation-batch file://invalidation.json
```

Notes on invalidations:
- Use a leading `/` on each path.
- `CallerReference` must be unique per call — bump the suffix each time.
- First 1000 paths/month are free across the AWS account; after that ~$0.005 per path. Wildcards (`/banners/*`) count as one path but cost the same.
- Propagation is usually 1–5 min. Status moves from `InProgress` → `Completed`. Check with:
  ```powershell
  aws cloudfront get-invalidation --distribution-id E1QSMCKVE26SSD --id <invalidation-id>
  ```

**Option B — upload under a new key + update DB (cache-busting, no invalidation cost):**

```powershell
aws s3 cp .\start_chatting_v2.png s3://mentortalk-storage-prod/banners/start_chatting_v2.png `
  --content-type image/png
```

```sql
UPDATE banner
SET image_url = 'banners/start_chatting_v2.png'
WHERE id = '<uuid>';
```

Optionally delete the old object once you're sure no client is still holding the old URL:

```powershell
aws s3 rm s3://mentortalk-storage-prod/banners/start_chatting.png
```

Option B is the cleaner default for routine swaps. Option A makes sense when the asset URL is hard-coded somewhere or you want zero DB changes.

---

## Delete a banner

### Soft delete (recommended)

Just take it out of rotation — keep the row and S3 object so you can re-enable later:

```sql
UPDATE banner SET is_active = false WHERE id = '<uuid>';
```

Or schedule it to expire:

```sql
UPDATE banner SET ends_at = NOW() WHERE id = '<uuid>';
```

The endpoint already filters on `is_active = true AND (ends_at IS NULL OR ends_at > NOW())`.

### Hard delete

```sql
DELETE FROM banner WHERE id = '<uuid>';
```

```powershell
aws s3 rm s3://mentortalk-storage-prod/banners/<key>.png
```

No CloudFront invalidation strictly needed (nothing references the URL anymore), but if you want to evict the cache too, use the invalidation flow above.

---

## Future: move this into the admin panel CMS

Today this is a manual SQL + AWS CLI flow. The `mentortalk-admin` lambda already has the scaffolding — auth, DB pool, S3 client (`mentortalk-admin/index.mjs`) — and a `POST /admin/presign` for **GET** URLs at `index.mjs:1100`. What's missing is **PUT-presign** for uploads and the banner CRUD endpoints.

### Proposed endpoints (admin-only, role check on JWT)

| Method | Path                             | Purpose                                                                 |
| ------ | -------------------------------- | ----------------------------------------------------------------------- |
| GET    | `/admin/banners`                 | List all banners (active + inactive) for the CMS table                  |
| POST   | `/admin/banners/presign-upload`  | Returns PUT presigned URL + final S3 key (e.g. `banners/{uuid}.{ext}`)  |
| POST   | `/admin/banners`                 | Create row after upload completes (`image_url`, `action`, schedule…)    |
| PATCH  | `/admin/banners/:id`             | Update `action`, `position`, schedule, `is_active`                      |
| PUT    | `/admin/banners/:id/image`       | Replace image: presign upload → update `image_url` → invalidate CDN     |
| DELETE | `/admin/banners/:id`             | Soft delete (set `is_active = false`); hard delete behind a query flag  |
| POST   | `/admin/banners/reorder`         | Bulk update `position` from a drag-and-drop UI                          |

### Implementation notes

1. **PUT presign helper** — mirror the existing `presignS3()` (currently GET-only) but with `PutObjectCommand` and a 5-minute TTL, matching the convention from the mentor onboarding lambdas. Always pick a fresh UUID-based key (`banners/{uuid}.{ext}`) so updates are cache-busting by default and CloudFront invalidation isn't needed on the happy path.

2. **CloudFront invalidation from the lambda** — only needed for the same-key replace flow. Add `cloudfront:CreateInvalidation` to the `mentortalk-admin-role` IAM policy scoped to distribution `E1QSMCKVE26SSD`, then call `CreateInvalidationCommand` from `@aws-sdk/client-cloudfront`. If the CMS always uploads under new UUID keys, this is optional.

3. **Image validation** — enforce max size (e.g. 500 KB), allowed MIME types (`image/png`, `image/jpeg`, `image/webp`), and target dimensions (current banner is 1080x432 ≈ 5:2 ratio). Either validate client-side before requesting the presign, or validate server-side after upload via a `HeadObject` and reject + delete if it doesn't fit.

4. **Cache version bump** — the schema has a `cache_metadata` table for client-side invalidation. If we want the mentee app to refresh the banner list on next launch instead of waiting for normal poll, bump `cache_metadata` for `banner` on every CRUD operation. Check whether the mentee app currently reads this for `banner` before relying on it.

5. **Audit trail** — log who did what (admin user_id, action, banner_id, before/after) into an `admin_audit_log` table or structured `console.log` lines, since banners are user-visible content.

6. **Admin panel UI** (`mentortalk-admin-panel` repo) — table view with thumbnail, drag-to-reorder, modal form for create/edit with image dropzone (calls `presign-upload` then PUTs directly to S3), toggle for `is_active`, date pickers for schedule.

### Effort estimate

Backend lambda work: ~1 day for endpoints + IAM + tests. Admin panel UI: ~1–2 days for the CRUD screens with drag-reorder. Worth doing once the marketing team needs to push more than a handful of banner changes per month — until then, the manual flow above is fine.
