# Architecture

Everything below reflects `docker-compose.microservices.yml` as checked in.

## Request path

```
Browser
  ↓
frontend  — Nginx, container port 80, published on 80
  ├── /                 static React bundle (try_files → index.html)
  ├── /api/      ──────► api-gateway:5000
  └── /socket.io/ ─────► post-service:3003   (WebSocket upgrade)
         ↓
api-gateway — port 5000
  ├── /api/auth/*   ──► auth-service:3001
  ├── /api/users/*  ──► user-service:3002
  └── /api/posts/*  ──► post-service:3003
         ↓
auth-service    user-service    post-service
         ↓
mongodb:27017   redis:6379   elasticsearch:9200
```

Socket.IO does **not** pass through the gateway. Nginx proxies `/socket.io/`
straight to post-service, which is where the Socket.IO server runs.

## Services

| Compose service | Container name | Port | Role |
| --- | --- | --- | --- |
| `frontend` | `social-media-frontend` | 80 | Nginx serving the React build; reverse-proxies `/api/` and `/socket.io/` |
| `api-gateway` | `api-gateway` | 5000 | Single REST entry point; path-rewriting proxy, rate limiting, health aggregation |
| `auth-service` | `auth-service` | 3001 | Registration, login, JWT issuing and verification |
| `user-service` | `user-service` | 3002 | Profiles, user search, profile-picture upload |
| `post-service` | `post-service` | 3003 | Posts, comments, replies, likes, Socket.IO server, post-image upload |
| `mongodb` | `social-media-mongodb` | 27017 | One database per service |
| `redis` | `social-media-redis` | 6379 | Feed cache and JWT verification cache |
| `elasticsearch` | `social-media-elasticsearch` | 9200, 9300 | User search index |

All eight join a single user-defined bridge network, `microservices-network`,
so containers address each other by Compose service name (`http://auth-service:3001`).

## Startup ordering

`depends_on` uses `condition: service_healthy` throughout, producing a strict
chain:

```
mongodb, redis            → auth-service
mongodb, redis, elasticsearch, auth-service → user-service
mongodb, redis, auth-service, user-service  → post-service
auth-service, user-service, post-service    → api-gateway
api-gateway               → frontend
```

Nothing starts until its dependencies report healthy, so the whole stack can
take several minutes on a cold start — Elasticsearch is the slowest link.

## Health checks

| Service | Check |
| --- | --- |
| `mongodb` | `mongosh localhost:27017/test --quiet --eval "db.runCommand({ping: 1}).ok"` |
| `redis` | `redis-cli ping` |
| `elasticsearch` | `curl -f http://localhost:9200/_cluster/health` |
| `auth-service`, `user-service`, `post-service`, `api-gateway` | `wget --quiet --tries=1 --spider http://localhost:<port>/health` |
| `frontend` | none declared |

MongoDB deliberately uses a **direct `mongosh --eval` invocation** rather than a
shell pipeline. See [DEPLOYMENT.md](DEPLOYMENT.md#mongodb-health-check) for why
this matters.

Each Node service exposes `GET /health` returning
`{"status":"healthy","service":"<name>"}`. The gateway additionally exposes
`GET /api/health/all`, which polls the three backend services and returns `200`
when all are healthy or `503` when any is degraded.

## Frontend proxying

The React code uses **relative** URLs only — `/api/...` for REST and
`io({ path: "/socket.io" })` for the socket. Nothing hardcodes a host or port,
so the same build works in both environments:

- **Docker:** Nginx (`social-media-mini-frontend/nginx.conf`) proxies `/api/` to
  `api-gateway:5000` and `/socket.io/` to `post-service:3003`, the latter with
  `Upgrade`/`Connection` headers and an 86400s read timeout for long-lived
  WebSocket connections.
- **Local dev:** `vite.config.js` proxies `/api` to `http://localhost:5000` and
  `/socket.io` to `http://localhost:3003` with `ws: true`.

## Path rewriting

The gateway strips the `/api/<service>` prefix before forwarding, so
`/api/auth/register` arrives at auth-service as `/register`. It also forwards the
`Authorization` header explicitly and returns `503` with
`{"message":"Service temporarily unavailable"}` on a proxy error. The error
body carries no detail from the underlying error, which names the upstream
host and port.

It also **deletes any client-supplied `x-internal-token`** from every inbound
request before routing it, and again on the outgoing proxy request. That header
authenticates the service-to-service call described below and never
legitimately arrives from a client; forwarding one would make a leaked token
replayable from outside the Docker network against `POST /sync-user`, which
accepts a complete profile including `_id`, `email` and a pre-hashed password.

Proxy callbacks are registered under `on` — http-proxy-middleware v3 removed
the top-level `onProxyReq`/`onError` keys and `createProxyMiddleware` ignores
unrecognised options silently, so a callback registered the old way never runs
and nothing is logged.

## Service-to-service calls

Services call each other directly over the Docker network, not through the
gateway:

- user-service and post-service validate every request by POSTing the token to
  `auth-service:3001/verify`. auth-service caches the result in Redis for 5
  seconds, keyed on a SHA-256 digest of the token. If Redis is unavailable it
  falls back to full JWT verification plus a database lookup — it never
  fails open.
- post-service calls `user-service:3002` to populate post and comment authors.
- user-service calls `post-service:3003` to list a user's posts.

## Data stores

Each service owns a separate MongoDB database on the shared instance:
`auth-service`, `user-service`, and `post-service`. There are no cross-database
joins; services exchange data over HTTP.

Redis holds the global feed cache under the single key `posts:feed:global`
(the feed is identical for every viewer) and the short-lived JWT verification
cache. Both are caches — losing Redis degrades performance, not correctness.

Elasticsearch indexes users for search, with a MongoDB regex query as fallback
when it is unavailable.

## Supabase

Post images and profile pictures are uploaded to **Supabase Storage**, not to
container disk, so the services stay stateless and images survive restarts and
rescheduling.

- Objects are keyed `posts/{userId}/{uuid}.{ext}` and
  `profiles/{userId}/{uuid}.{ext}`. The user id comes from the verified JWT and
  the extension is derived from the file's own magic bytes, never from the
  client-supplied filename.
- Only `post-service` and `user-service` receive the Supabase variables. The
  frontend and gateway never see them, and the frontend reads no environment
  variables at all.
- Services require **Node 22**, because the Supabase client's realtime layer
  expects the native global `WebSocket` that Node provides from version 22. All
  Dockerfiles build on `node:22-alpine`.

Setup and the bucket's access model: [supabase-setup.md](supabase-setup.md).

## Volumes

Three named volumes, all `driver: local`:

| Volume | Mount | Holds |
| --- | --- | --- |
| `mongodb_data` | `/data/db` | All three service databases |
| `redis_data` | `/data` | Redis append-only file |
| `elasticsearch_data` | `/usr/share/elasticsearch/data` | Search index |

There are no upload volumes — images live in Supabase. `docker compose down`
keeps these volumes; `down -v` destroys them.

## Images

| Build context | Base |
| --- | --- |
| `services/api-gateway` | `node:22-alpine` |
| `services/auth-service` | `node:22-alpine` |
| `services/post-service` | `node:22-alpine` |
| `services/user-service` | `node:22-alpine` |
| `social-media-mini-frontend` | `node:22-alpine` build stage → `nginx:alpine` runtime |

The frontend is a two-stage build: Node compiles the Vite bundle, then only
`dist/` and `nginx.conf` are copied into the Nginx image. No Node runtime ships
in the frontend container.
