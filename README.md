# Social Media Mini

A small social-media application built as a Node.js microservice stack behind an
Nginx-served React frontend. Users register and log in, post text and images,
comment and reply, like posts, search for other users, and see new posts appear
in real time over Socket.IO.

The project exists as a study of how a multi-service system is wired together,
tested, and deployed — not as a product. The documentation is deliberately
honest about what is and is not covered; see [Known limitations](#known-limitations).

## Architecture

```
Browser
  │
  ▼
frontend (Nginx, :80)  ── the only port published to the host
  ├── /api/        ──►  api-gateway (:5000)
  │                       ├── /api/auth/*   ──►  auth-service  (:3001)
  │                       ├── /api/users/*  ──►  user-service  (:3002)
  │                       └── /api/posts/*  ──►  post-service  (:3003)
  └── /socket.io/  ──►  post-service (:3003)   bypasses the gateway

MongoDB (:27017) · Redis (:6379) · Elasticsearch (:9200)   internal only
```

Eight containers on one Docker bridge network. **Only the frontend publishes a
host port** — every backend service and data store is reachable solely from
inside the network, which is why the health-check commands below use
`docker compose exec` rather than `curl localhost:3001`.

| Service | Responsibility |
| --- | --- |
| `frontend` | React 19 + Vite 7 SPA, served by Nginx, which also reverse-proxies the API and the WebSocket upgrade |
| `api-gateway` | Single entry point; strips the `/api/<service>` prefix, forwards `Authorization`, global rate limit, health aggregation |
| `auth-service` | Registration, login, JWT issue and verification; bcrypt hashing; Redis-backed verify cache |
| `user-service` | Profiles, avatar upload, Elasticsearch-backed user search with a MongoDB regex fallback |
| `post-service` | Posts, embedded comments and replies, likes, the global feed and its cache, and the Socket.IO server |

Each service owns a separate MongoDB database; there are no cross-database
joins. Full detail in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

### Notable design points

- **`/verify` is the trust chokepoint.** user-service and post-service
  authenticate every protected request by POSTing the token to
  `auth-service:3001/verify`. Results are cached in Redis under a SHA-256 digest
  of the token — never the token itself — with a 5-second TTL. A cache miss or a
  Redis outage falls through to full verification: it never fails open.
- **Registration is a saga.** auth-service writes the credential record, then
  syncs the profile to user-service with a bounded retry (3 attempts, linear
  backoff). If every attempt fails it deletes the credential record and returns
  503, so a half-created user cannot claim an email address.
- **Images never touch container disk.** Uploads are validated by magic bytes —
  not by the browser-supplied filename or `Content-Type` — and stored in
  Supabase Storage.
- **Internal service boundary.** `POST /sync-user` runs during registration,
  before the new user has a token, so it cannot use the normal JWT middleware.
  It is authenticated with a shared `INTERNAL_SERVICE_TOKEN` compared in
  constant time, and both services refuse to start without it. The gateway
  strips the header from client requests, so the endpoint is reachable only
  from inside the Docker network.

## Prerequisites

- Docker with the Compose plugin (`docker compose`, not `docker-compose`)
- **Node.js 22** to run the test suites outside Docker. All images are built on
  `node:22-alpine`
- A Supabase project if you want image uploads to work — see
  [docs/supabase-setup.md](docs/supabase-setup.md). The stack starts without it;
  the upload endpoints return 503 until it is configured

## Running locally

```bash
cp .env.example .env
```

Fill in the required values, then:

```bash
docker compose -f docker-compose.microservices.yml up -d --build
```

The first run builds five images and waits for Elasticsearch, so allow a few
minutes. Validate the configuration without starting anything:

```bash
docker compose -f docker-compose.microservices.yml config
```

### Configuration

Compose reads `.env` from the project directory and re-interpolates it on
**every** invocation, so run these commands from the repository root.

| Variable | Required | Purpose |
| --- | --- | --- |
| `JWT_SECRET` | **yes** | Signs and verifies every token. auth-service refuses to start without it. Generate with `openssl rand -hex 32` |
| `INTERNAL_SERVICE_TOKEN` | **yes** | Authenticates the internal registration sync between auth-service and user-service. Both refuse to start without it. Generate the same way |
| `MONGO_ROOT_PASSWORD` | **yes** | Creates the MongoDB root user and is interpolated into every service's `MONGO_URI`, so the two cannot drift. No default |
| `MONGO_ROOT_USERNAME` | no | Defaults to `root` |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | for uploads | Backend-only. The service-role key must never reach the browser |
| `SUPABASE_STORAGE_BUCKET` | no | Defaults to `uploads` |

`MONGO_INITDB_*` applies only on **first** initialisation, so set the password
before the first start. Changing it later requires recreating the volume, which
destroys data.

## Verifying it works

```bash
docker compose -f docker-compose.microservices.yml ps
```

Every service except `frontend` declares a health check and should report
`healthy`.

From the host, through Nginx:

```bash
curl -I http://localhost/                 # frontend
curl http://localhost/api/health/all      # gateway + all three services
```

`/api/health/all` returns `200` only when every backend is healthy, so it is the
single most useful check — and it exercises the same path a real user takes.

The backend ports are not published, so probe individual services from inside
the network:

```bash
docker compose -f docker-compose.microservices.yml exec -T api-gateway \
  wget -q -O - http://auth-service:3001/health
```

`wget` rather than `curl`: the service images are `node:22-alpine`, whose
BusyBox `wget` is what the container health checks already use.

## Testing

Backend tests use an in-memory MongoDB, so no running database is needed:

```bash
cd services/auth-service && npm ci && npm test   # 18 tests
cd services/user-service && npm ci && npm test   # 64 tests
cd services/post-service && npm ci && npm test   # 51 tests
```

**133 tests in total**, all passing on Node 22. `services/api-gateway` has no
suite.

Repository-level security and regression checks, the same ones CI runs:

```bash
./scripts/ci-security-checks.sh
```

This script is worth a look: its 29 assertions check both that previously fixed
defects have not returned **and** that specific hardening is still present —
removing a control fails the build rather than passing quietly.

### The registration saga, end to end

Registration spans two services and two databases, so no unit test and no
health check can tell you it works. This script asserts it against a running
stack, through port 80 — the path a browser takes:

```bash
INTERNAL_SERVICE_TOKEN=<the value the stack was started with> \
  ./scripts/e2e-registration.sh
```

It registers a user through Nginx and the gateway, reads the profile back from
user-service, confirms `/sync-user` is unreachable from a client even with the
correct token, exercises the internal guard with missing, wrong-length,
wrong-value and multibyte tokens, and then **stops user-service** to prove the
saga returns 503, rolls the credential record back, and frees the email address
for a later attempt. CI runs it in the `stack-integration` job.

**An honest caveat.** The three service suites build a replica Express app
inside the test file rather than importing the service's own `server.js`, so
they do not exercise shipped code. The `imageType`, `imageReference` and
`internalAuth` suites are the exception. This is a known, documented gap — see
[docs/tests/TEST-PLAN.md](docs/tests/TEST-PLAN.md) §30 — and it is the single
highest-priority item in the project's own test plan.

## Deployment

[docs/AWS-EC2-DEPLOYMENT.md](docs/AWS-EC2-DEPLOYMENT.md) is a complete runbook
for a single EC2 instance: sizing, security groups, environment setup, health
verification, backup and restore, and troubleshooting. The stack builds all five
images from source; it does not pull published images.

Elasticsearch is the largest consumer — **4 GB RAM minimum**, 8 GB comfortable.
A 1 GB instance is not viable.

## Known limitations

Stated plainly because the documentation is only useful if it is accurate.

- **No HTTPS.** The stack serves plain HTTP on port 80. TLS termination is a
  deployment concern and is not configured here.
- **No token revocation.** A JWT is valid for 7 days; there is no refresh token,
  logout endpoint, or server-side revocation. Logout clears `localStorage`.
- **The same user is stored twice**, in auth-service and user-service, reconciled
  only by the registration sync. This is the system's main data-integrity risk.
- **No pagination.** `GET /` returns every post; search is capped at 10 results.
- **The feed does an N+1 fan-out** on a cache miss — one user lookup per post,
  comment, and reply. The 300-second cache is what makes it viable.
- **No frontend tests and no browser end-to-end tests.** Test tooling for the
  SPA does not exist in this repository. The registration journey is covered at
  the API level against the real stack (above); every other journey — posting,
  commenting, the real-time feed — is verified only by hand.
- **No staging environment**, so `main` deploys straight to the instance. The
  mitigation is a deployment smoke check and a rehearsed rollback.

## Troubleshooting

| Symptom | Likely cause | Action |
| --- | --- | --- |
| `user-service` never starts; "dependency failed to start … elasticsearch is unhealthy" | Elasticsearch was OOM-killed | Give the host ≥4 GB RAM; check `dmesg \| grep -i oom` |
| Every request returns 401 | `JWT_SECRET` differs from the one that signed the token, or is unset | Confirm `.env`, then recreate the services |
| A service exits immediately at startup | `JWT_SECRET` or `INTERNAL_SERVICE_TOKEN` is unset — both services refuse to start | Set both in `.env`; they fail loudly by design |
| Registration returns 503 | The profile sync to user-service failed all three attempts and rolled back | Check `INTERNAL_SERVICE_TOKEN` matches in both services, and that user-service is healthy |
| Uploads return 503 | Supabase is not configured | See [docs/supabase-setup.md](docs/supabase-setup.md) |
| Search returns nothing for a known user | Elasticsearch lost its volume; there is no backfill | Re-save the profile, or see the operational gap noted in the test plan |
| `curl localhost:3001/health` refuses to connect | Backend ports are intentionally not published | Probe from inside the network with `docker compose exec` |

More symptom-level detail in [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Documentation

| Document | Contents |
| --- | --- |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Services, ports, networking, proxying, volumes |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Deploying to a production VM |
| [docs/AWS-EC2-DEPLOYMENT.md](docs/AWS-EC2-DEPLOYMENT.md) | Single-instance EC2 runbook, including backup and restore |
| [docs/SECURITY.md](docs/SECURITY.md) | Secret handling and what must never be exposed |
| [docs/supabase-setup.md](docs/supabase-setup.md) | Storage bucket setup |
| [docs/ci.md](docs/ci.md) | What the GitHub Actions pipeline verifies |
| [docs/tests/TEST-STRATEGY.md](docs/tests/TEST-STRATEGY.md) | Testing policy: levels, gates, coverage, version governance |
| [docs/tests/TEST-PLAN.md](docs/tests/TEST-PLAN.md) | Operational test plan: inventory, commands, known gaps |
| [MICROSERVICES.md](MICROSERVICES.md) | Service responsibilities and inter-service communication |

> The committed Compose file carries **development** values. Read
> [docs/SECURITY.md](docs/SECURITY.md) before deploying anywhere public.

## License

[MIT](LICENSE) © Abhay Ranjan
