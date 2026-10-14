# Supabase Storage Setup

Image uploads (post images and profile pictures) are stored in Supabase Storage.
Nothing is written to container-local disk, so services stay stateless and
uploads survive restarts, rescheduling, and horizontal scaling.

## Access model: why the bucket is public

The bucket is **public**, and the services return permanent public URLs via
`getPublicUrl()`. This is deliberate and matches how the application works:

- Post images appear in the global feed, which every authenticated user sees.
- Profile pictures appear on publicly viewable profiles.
- The feed is cached in Redis under a single shared key (`posts:feed:global`)
  for 300s, with image URLs embedded in the cached payload. Short-lived signed
  URLs would expire *inside* that cache window, so cached entries would serve
  dead links.

Private buckets with signed URLs would therefore require reworking the feed
cache. If this application ever needs genuinely private images, that is the
change to make first — switching to signed URLs alone would break the feed.

What the public bucket does *not* grant: the bucket is public for **reads only**.
All writes go through the authenticated `/upload` endpoints, which hold the
service-role key server-side. Anonymous users cannot upload, overwrite, or
delete objects.

## 1. Create the project and bucket

1. Create a project at <https://supabase.com>.
2. Go to **Storage → New bucket**.
3. Name it `uploads` and tick **Public bucket**.
4. Create it.

Default Supabase storage limits are adequate; the services independently cap
uploads at 5 MB per file.

## 2. Collect credentials

From **Project Settings → API**:

| Value | Environment variable |
| --- | --- |
| Project URL | `SUPABASE_URL` |
| `service_role` secret key | `SUPABASE_SERVICE_ROLE_KEY` |
| Bucket name (`uploads`) | `SUPABASE_STORAGE_BUCKET` |

> **The `service_role` key bypasses all row-level security.** It is a backend-only
> credential. It is passed to `post-service` and `user-service` only — never to
> the frontend, the API gateway, or any browser-delivered bundle. The frontend
> reads no environment variables at all and talks only to its own backend
> upload endpoints. Never commit this key.

## 3. Configure the environment

```bash
cp .env.example .env
```

Fill in `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and `SUPABASE_STORAGE_BUCKET`,
plus a strong `JWT_SECRET`:

```bash
openssl rand -hex 32
```

`.env` is read by docker-compose and is already gitignored.

### Local development (bare Node)

Export the three Supabase variables in the shell that runs `npm start` for
`post-service` and `user-service`, or place them in each service's own `.env`.

If the Supabase variables are absent, the services still start — they log a
warning and the upload endpoints return `503 Image storage is not configured`.
The rest of the application works normally, which keeps Supabase optional for
contributors who are not touching uploads.

### Production

```bash
docker compose -f docker-compose.microservices.yml up -d
```

Supply secrets through your orchestrator's secret store (Docker secrets,
Kubernetes Secrets, SSM, etc.) rather than a checked-in file. `auth-service`
refuses to start if `JWT_SECRET` is unset or empty, so a missing secret fails
loudly at boot instead of producing 500s on every login.

## 4. Object layout

| Content | Object path |
| --- | --- |
| Post images | `posts/{userId}/{uuid}.{ext}` |
| Profile pictures | `profiles/{userId}/{uuid}.{ext}` |

The user id comes from the verified JWT, never from the request body. The
filename is a server-generated UUID, and the extension is derived from the
file's own magic bytes — the browser-supplied filename is discarded entirely, so
a crafted filename cannot traverse paths or plant an executable extension.
Uploads use `upsert: false`, so an upload can never overwrite an existing object.

Accepted formats are JPEG, PNG, GIF, and WebP, validated by byte signature
rather than the `Content-Type` header. SVG is intentionally rejected: it can
carry executable script and is the main XSS vector for image uploads.

## 5. Migrating legacy base64 images

Older records stored images as base64 `data:` URLs directly in MongoDB.
`scripts/migrate-base64-images.js` uploads those to Supabase Storage and
replaces each field with its public URL.

The script is idempotent (only values still beginning with `data:` are
considered), resumable (each document is handled individually), and
storage-first (MongoDB is updated only after the object is durably stored, so a
document can never point at a nonexistent object). Nothing is ever deleted;
failed records keep their original base64 value and are listed for follow-up.
Documents are streamed with a cursor rather than loaded all at once, since each
base64 image can be several megabytes.

Install the script's dependencies once from the repository root:

```bash
npm install
```

**Always dry-run first, and back up both databases before the real run.**

```bash
# Use the same credentials as MONGO_ROOT_USERNAME / MONGO_ROOT_PASSWORD in .env
export POST_MONGO_URI="mongodb://${MONGO_ROOT_USERNAME:-root}:${MONGO_ROOT_PASSWORD}@localhost:27017/post-service?authSource=admin"
export USER_MONGO_URI="mongodb://${MONGO_ROOT_USERNAME:-root}:${MONGO_ROOT_PASSWORD}@localhost:27017/user-service?authSource=admin"
export SUPABASE_URL='https://your-project-ref.supabase.co'
export SUPABASE_SERVICE_ROLE_KEY='your-service-role-key'
export SUPABASE_STORAGE_BUCKET='uploads'

npm run migrate:images:dry-run
```

The dry run reads only. It reports, per record, what would be uploaded and to
which path, and flags anything it would skip. Review that output, then apply:

```bash
npm run migrate:images
```

Both URIs must be given explicitly — posts and profiles live in separate
databases and the script never infers one from the other. It exits non-zero if
any record failed.

Records reported as **skipped** held a malformed `data:` URL or bytes that are
not a valid JPEG/PNG/GIF/WebP. They are left untouched for manual inspection
rather than uploaded as unusable objects.

## 6. Orphaned objects

Uploading and attaching an image are two separate requests: the client uploads,
receives a URL, and then submits the post or profile update. If a user uploads an
image and abandons the form, the object remains in the bucket with nothing
referencing it. The same applies to a re-run of the migration after a partial
failure.

This is inherent to the two-phase flow and is not a correctness problem — no
request returns success for a failed upload, and no database row ever points at
a missing object. To reclaim space, prefer a periodic sweep that lists bucket
objects and deletes those not referenced by any `post.image` or
`user.profilePic`. Do not add rollback-on-abandon to the upload endpoint: it
cannot distinguish an abandoned form from one the user is still filling in.
