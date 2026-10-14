# AWS EC2 Deployment

Deployment runbook for running this stack on a single EC2 instance with Docker
Compose.

## Use the right Compose file

```
docker-compose.microservices.yml
```

Every command in this document passes `-f docker-compose.microservices.yml`.
That flag is not optional: `docker-compose.microservices.yml` is the only
Compose file in this repository, and Docker does not pick it up by default.

Consider adding a shell alias while you work:

```bash
alias dc='docker compose -f docker-compose.microservices.yml'
```

## What runs

Eight containers on one bridge network, `microservices-network`:

| Service | Internal port | Published to host |
| --- | --- | --- |
| `frontend` (Nginx) | 80 | **80 — the only public port** |
| `api-gateway` | 5000 | no |
| `auth-service` | 3001 | no |
| `user-service` | 3002 | no |
| `post-service` | 3003 | no |
| `mongodb` | 27017 | no |
| `redis` | 6379 | no |
| `elasticsearch` | 9200, 9300 | no |

## Environment variables

Compose reads `.env` from the project directory and re-interpolates it on
**every** invocation, so always run these commands from the repository root.

### Required

| Variable | Purpose |
| --- | --- |
| `MONGO_ROOT_PASSWORD` | MongoDB root password. Used both to create the root user on the `mongodb` container and inside the `MONGO_URI` of auth-, user- and post-service, so the two can never drift. No default — if unset, Compose warns and interpolates an empty string. |
| `JWT_SECRET` | Signs and verifies all JWTs. `auth-service` refuses to start if it is unset or empty. |

Generate the JWT secret fresh for this deployment:

```bash
openssl rand -hex 32
```

### Optional

| Variable | Default | Notes |
| --- | --- | --- |
| `MONGO_ROOT_USERNAME` | `root` | Compose uses `${MONGO_ROOT_USERNAME:-root}`, so leaving it unset is fine |
| `SUPABASE_URL` | none | Required only for image uploads |
| `SUPABASE_SERVICE_ROLE_KEY` | none | Required only for image uploads |
| `SUPABASE_STORAGE_BUCKET` | `uploads` | Compose uses `${SUPABASE_STORAGE_BUCKET:-uploads}` |

Without the Supabase variables the stack still starts and runs normally;
`post-service` and `user-service` log `Supabase credentials not set` and their
upload endpoints return `503`. Everything else — login, feed, comments, likes,
search, real-time updates — works. See [supabase-setup.md](supabase-setup.md).

They are optional to the *application*, but unlike `MONGO_ROOT_USERNAME` and
`SUPABASE_STORAGE_BUCKET` they carry no Compose default, so leaving them unset
prints `The "SUPABASE_URL" variable is not set. Defaulting to a blank string.`
on every command. That warning is expected in an uploads-disabled deployment and
is not an error. Set them to silence it.

The service-role key is a backend-only credential. It is passed to
`post-service` and `user-service` only, never to the frontend or the gateway.

Avoid `@ : / ? #` and `%` in `MONGO_ROOT_PASSWORD`. It is embedded in a MongoDB
connection URI without percent-encoding, so those characters break the URI.

## 1. Initial setup

```bash
cp .env.example .env
chmod 600 .env
```

Then edit `.env` and fill in `MONGO_ROOT_PASSWORD` and `JWT_SECRET`, plus the
Supabase values if you want uploads.

**`.env` must never be committed.** It is already covered by `.gitignore`
(`**/.env`), and `.env.example` is the only environment file in version
control. Verify at any time:

```bash
git check-ignore -v .env     # should print the .gitignore rule
git status --short            # .env must not appear
```

A secret committed once stays in Git history even after deletion, and must then
be treated as compromised and rotated. Keep backups of `.env` outside the
repository.

## 2. Validate the configuration

```bash
docker compose -f docker-compose.microservices.yml config
```

This resolves `.env` and prints the effective configuration without starting
anything. Run it first — it is the fastest way to catch a missing variable.
Any `variable is not set` warning for `MONGO_ROOT_PASSWORD` or `JWT_SECRET`
means `.env` is incomplete or you are in the wrong directory.

## 3. Build

```bash
docker compose -f docker-compose.microservices.yml build
```

Five images are built from source: the four Node services and the frontend.
Expect several minutes on a first run.

## 4. Start

```bash
docker compose -f docker-compose.microservices.yml up -d --wait
```

`--wait` blocks until every health check passes, so a non-zero exit means
something genuinely failed to come up rather than merely being slow.

Startup is serialised by `depends_on: condition: service_healthy`:

```
mongodb, redis                                → auth-service
mongodb, redis, elasticsearch, auth-service   → user-service
mongodb, redis, auth-service, user-service    → post-service
auth-service, user-service, post-service      → api-gateway
api-gateway                                   → frontend
```

Nothing starts before its dependencies are healthy. Elasticsearch has a 30s
health-check interval and is the slowest link, so allow a few minutes.

## 5. Check status

```bash
docker compose -f docker-compose.microservices.yml ps
```

Seven services declare health checks and should report `healthy`. `frontend`
declares none, so it shows only as running.

Verify the application answers:

```bash
curl -I http://localhost                      # Nginx serving the frontend
curl http://localhost/api/health/all          # gateway + the three services
```

`/api/health/all` returns `200` when all three backend services are healthy and
`503` otherwise, which makes it a good target for an external monitor. Note it
is reached **through** Nginx on port 80 — the gateway's own port 5000 is not
published.

Because nothing but port 80 is published, check internal services from inside
the network rather than from the host:

```bash
docker compose -f docker-compose.microservices.yml exec api-gateway \
  wget -qO- http://auth-service:3001/health
docker compose -f docker-compose.microservices.yml exec redis redis-cli ping
docker compose -f docker-compose.microservices.yml exec mongodb \
  mongosh --quiet --eval 'db.runCommand({ping:1}).ok'
```

Health endpoints prove a process is listening. To confirm an application
actually reached its dependencies, check its logs for `MongoDB Connected` and
`Redis Connected`.

## 6. Logs

```bash
docker compose -f docker-compose.microservices.yml logs --tail=100
```

A single service:

```bash
docker compose -f docker-compose.microservices.yml logs user-service
docker compose -f docker-compose.microservices.yml logs -f --tail=50 post-service
docker compose -f docker-compose.microservices.yml logs --since 10m api-gateway
```

When a container is crash-looping, read from the **start** of its output rather
than using `--tail` — a startup error appears first, then scrolls away as the
container restarts.

For an unhealthy container, the health check's own output is the quickest route
to the cause:

```bash
docker inspect user-service --format '{{json .State.Health}}' | python3 -m json.tool
```

`State.Health.Log` holds each probe's exit code and output; `State.ExitCode` and
`State.OOMKilled` distinguish a crashed process from a merely failing probe.

## 7. Stop and restart

```bash
# Stop, keep containers
docker compose -f docker-compose.microservices.yml stop

# Start again
docker compose -f docker-compose.microservices.yml start

# Restart one service
docker compose -f docker-compose.microservices.yml restart user-service

# Remove containers and network, KEEP data volumes
docker compose -f docker-compose.microservices.yml down
```

```bash
# Removes the data volumes too — DESTROYS the database
docker compose -f docker-compose.microservices.yml down -v
```

Use `down -v` only when you intend to lose all data. The three named volumes
(`mongodb_data`, `redis_data`, `elasticsearch_data`) otherwise survive `down`
and container replacement.

## 8. Updating after a new commit

```bash
cd social-media-mini
git pull origin main
docker compose -f docker-compose.microservices.yml build
docker compose -f docker-compose.microservices.yml up -d --wait
```

Compose recreates only the containers whose image or configuration changed, and
volumes are untouched so data persists. To force one service:

```bash
docker compose -f docker-compose.microservices.yml up -d --build --force-recreate user-service
```

Expect a brief interruption. There is no rolling deployment, and the health
gating means a restarted dependency can hold up the services above it. Take a
database backup before any update that changes data handling.

## 9. Port exposure

Only the frontend's port 80 is published by Docker. Everything else is reachable
only from inside `microservices-network`, by service name.

This is deliberate, and three of the internal services would be dangerous to
expose:

- **MongoDB** — full database access.
- **Redis** — no password is configured.
- **Elasticsearch** — runs with `xpack.security.enabled=false`, so anyone who
  can reach it has full read and write access to the index.

The three Node services and the gateway are internal because the frontend's
Nginx already reverse-proxies to them over the Docker network: `/api/` to
`api-gateway:5000` and `/socket.io/` to `post-service:3003`. Nothing outside the
network needs to address them.

Unpublishing a port does not affect traffic inside the stack, and it does not
affect the health checks — each probes `localhost` inside its own container.

If you need host access to an internal service for debugging, bind it to
loopback rather than all interfaces, and reach it over an SSH tunnel:

```yaml
ports:
  - "127.0.0.1:5000:5000"
```

## 10. AWS Security Group

The Security Group should eventually allow only:

| Port | Protocol | Source | Purpose |
| --- | --- | --- | --- |
| 22 | TCP | **your IP only**, e.g. `203.0.113.4/32` | SSH |
| 80 | TCP | `0.0.0.0/0` | HTTP |
| 443 | TCP | `0.0.0.0/0` | HTTPS, once TLS is configured |

Leave 443 closed until TLS is actually serving. Never open 27017, 6379, 9200,
9300, 3001, 3002, 3003, or 5000.

A Security Group is the right control here, and a host firewall is a useful
second layer. Note that Docker publishes ports by writing `iptables` rules that
can bypass some host firewall configurations — which is another reason the
internal services have no `ports:` entry at all rather than relying on a
firewall to hide them.

This document does not change any AWS configuration; apply the above in the
console or CLI yourself.

## 11. MongoDB password and volume behaviour

This catches people out, so read it before the first start.

`MONGO_ROOT_PASSWORD` reaches MongoDB through `MONGO_INITDB_ROOT_PASSWORD`,
which the official image honours **only when it initialises an empty data
directory** — that is, on the very first start against a fresh `mongodb_data`
volume.

Consequences:

- **Set the password before the first `up`.** That is the only moment it takes
  effect cheaply.
- **Changing `.env` later does not change the existing user's password.** The
  variable is simply ignored on subsequent starts. The services will then
  authenticate with the new value against a user that still has the old one, and
  every connection fails with an authentication error.

To change the password after the fact, pick one:

1. **Change it inside MongoDB** and update `.env` to match:

   ```bash
   docker compose -f docker-compose.microservices.yml exec mongodb mongosh \
     --username root --password 'OLD_PASSWORD' --authenticationDatabase admin \
     --eval 'db.getSiblingDB("admin").changeUserPassword("root","NEW_PASSWORD")'
   ```

   Then set the same value in `.env` and restart the services.

2. **Recreate the volume**, which destroys all data:

   ```bash
   docker compose -f docker-compose.microservices.yml down -v
   ```

   Back up first if the data matters.

Because Compose derives both the container's init variables and all three
`MONGO_URI` values from `${MONGO_ROOT_USERNAME:-root}` and
`${MONGO_ROOT_PASSWORD}`, the credentials cannot drift between MongoDB and its
clients — they are the same two variables in every place.

## 12. Elasticsearch memory and `vm.max_map_count`

Elasticsearch is the single largest consumer in this stack and the usual reason
a small instance fails.

**Heap.** The Compose file sets `ES_JAVA_OPTS=-Xms512m -Xmx512m`, a fixed
512 MB heap. With JVM overhead the container wants roughly 1–1.5 GB, and seven
other containers run alongside it.

- **4 GB RAM minimum**; 8 GB comfortable.
- A 1 GB instance (`t3.micro`) is not viable — Elasticsearch is OOM-killed, and
  because `user-service` waits for it to report healthy, the visible symptom is
  `user-service` never starting with
  `dependency failed to start: container social-media-elasticsearch is unhealthy`.

Check for it with `dmesg | grep -i oom` and `docker stats`.

**`vm.max_map_count`.** Elasticsearch stores indices in memory-mapped files and
documents a minimum of 262144 map areas. This stack sets
`discovery.type=single-node`, which makes Elasticsearch skip its bootstrap
checks — so the container will usually *start* on a host that has the default
65530. The requirement is still real for index operation, and raising it is
cheap, so set it:

```bash
sudo sysctl -w vm.max_map_count=262144
echo 'vm.max_map_count=262144' | sudo tee -a /etc/sysctl.conf
```

The first line applies immediately; the second makes it survive reboot.

Elasticsearch backs user search only, with a MongoDB regex query as fallback, so
a degraded Elasticsearch reduces search quality rather than breaking the
application. Its volume holds a derived index that is repopulated as users are
created and updated.

## 13. HTTPS is not configured

**The current deployment is HTTP-only.** The `frontend` container listens on
plain port 80 and `social-media-mini-frontend/nginx.conf` contains no TLS
configuration. Nothing in this repository obtains or serves a certificate.

Until TLS is added, login credentials and JWTs cross the network in clear text.
Treat the deployment as a learning or staging environment, not something to put
real user data into.

Adding TLS is a deployment task performed in front of this stack, typically a
terminating reverse proxy on the host — Caddy, Traefik, or host Nginx with
Certbot — holding the certificate for your domain, listening on 443, and
forwarding to the frontend container. Point the domain's A record at the
instance's elastic IP, issue the certificate, redirect 80 to 443, then open 443
in the Security Group.

When you add that proxy, forward `X-Forwarded-For` and `X-Forwarded-Proto`. The
Node services set `app.set('trust proxy', 1)`, so rate limiting relies on those
headers to identify real client addresses; without them every request appears to
come from the proxy.

## 14. Socket.IO and WebSocket headers

Real-time updates — new posts, comments, replies, likes — travel over
Socket.IO, which upgrades an HTTP connection to a WebSocket. That upgrade only
survives a proxy hop if the proxy forwards the upgrade headers.

The stack's own Nginx already does this for `/socket.io/`:

```nginx
location /socket.io/ {
    proxy_pass http://post-service:3003;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    ...
    proxy_read_timeout 86400s;
    proxy_send_timeout 86400s;
}
```

`proxy_http_version 1.1` plus the `Upgrade` and `Connection` headers are what
make the handshake work; the long timeouts stop Nginx closing idle but healthy
sockets. Note the traffic goes **straight to post-service**, bypassing the API
gateway, because that is where the Socket.IO server runs.

Two things follow:

- Do not remove or weaken that block. Losing it produces a confusing failure
  where REST works fine and only real-time updates break — the client falls back
  to HTTP long-polling or fails outright.
- **Any TLS proxy you add in front must apply the same handling** for
  `/socket.io/`, or you will reintroduce exactly that failure one layer up.

To confirm the upgrade is working, watch `post-service` logs for
`Client connected` while loading the feed in a browser:

```bash
docker compose -f docker-compose.microservices.yml logs -f post-service
```

## 15. Backup and restore

**Nothing here is automated.** The repository ships no backup job, cron entry,
or snapshot policy. Everything below is a manual procedure you must schedule
yourself. Treat this section as the thing to automate, not as something already
running.

Of the three volumes, **`mongodb_data` is the only one holding unrecoverable
data.** `redis_data` is a pure cache, and `elasticsearch_data` is a derived
index that is repopulated as users are created or updated.

### Taking a dump

MongoDB's port is not published, so the dump runs inside the container. Run it
from the repository directory so Compose finds the project:

```bash
docker compose -f docker-compose.microservices.yml exec mongodb \
  mongodump --archive --gzip \
  --username "root" --authenticationDatabase admin \
  > "backup-$(date +%F-%H%M).archive.gz"
```

Note what is deliberately absent: **no `--password` flag.** `mongodump` prompts
for it, so the value never reaches your shell history or the process list where
`ps` would expose it. For the same reason `exec` is used without `-T` — the
prompt needs a TTY.

Use the same username you set in `MONGO_ROOT_USERNAME` (`root` unless you
changed it), and enter the `MONGO_ROOT_PASSWORD` value from `.env` at the
prompt. If you must script this non-interactively, read the value from `.env`
into the environment rather than typing it on the command line, and accept that
it becomes briefly visible in the container's process list.

### Where to keep backups

- **Off the instance.** A dump sitting on the same EBS volume as
  `mongodb_data` is not a backup — one volume failure or one accidental
  `down -v` loses both. Copy it to object storage (S3) or another host.
- **Separate from the persistent volumes**, and ideally a separate AWS account
  or at least a bucket with its own IAM policy.
- **Control retention and access.** Decide how long dumps are kept and delete
  them on schedule; a dump is a complete copy of every user record, so it needs
  the same protection as the database. Restrict read access to the people who
  perform restores. Enable bucket versioning and encryption at rest if you use
  S3.
- Back up `.env`, your TLS certificates (or the means to reissue them), and
  your Supabase project configuration too — **outside Git**.
- **Supabase Storage objects are not covered by a MongoDB dump.** MongoDB holds
  only their URLs. The bucket needs its own backup policy.

### Restoring

> **Restoring overwrites data.** `mongorestore` writes into live collections.
> Never point a restore at a database you still need without taking a fresh
> dump of it first. Practise on a throwaway instance, not production.

```bash
docker compose -f docker-compose.microservices.yml exec -T mongodb \
  mongorestore --archive --gzip --drop \
  --username "root" --authenticationDatabase admin \
  < "backup-2026-01-01-1200.archive.gz"
```

`--drop` replaces each collection present in the archive. Omit it to merge
instead, which can leave a mixture of old and new documents — usually not what
you want.

### Verifying a restore

An untested backup is not a backup. Periodically:

1. Start a scratch MongoDB container — not the production one:
   `docker run -d --name mongo-verify -e MONGO_INITDB_ROOT_USERNAME=root -e MONGO_INITDB_ROOT_PASSWORD=<scratch> mongo:7`
2. Restore the archive into it with the command above, targeting
   `mongo-verify`.
3. Confirm the three databases exist and carry plausible counts:
   `mongosh --username root --authenticationDatabase admin --eval 'db.getSiblingDB("auth-service").users.countDocuments()'`
   and the same for `user-service.users` and `post-service.posts`.
4. Remove the scratch container: `docker rm -f mongo-verify`.

A restore that produces zero documents, or that fails authentication, means the
archive or the credentials are wrong — find out during a drill, not an incident.

### `down -v` is not a backup strategy

```bash
docker compose -f docker-compose.microservices.yml down      # keeps volumes
docker compose -f docker-compose.microservices.yml down -v    # DESTROYS volumes
```

`down -v` deletes `mongodb_data`, `redis_data`, and `elasticsearch_data`
permanently. It is sometimes necessary — changing the Mongo password after
first initialisation requires it, as §11 explains — but it is a destructive
operation, not a maintenance step. Always take a dump first.

### Before data-affecting changes

Take a dump before any upgrade that touches data, before `down -v`, and before
running `scripts/migrate-base64-images.js` — see
[supabase-setup.md](supabase-setup.md), which also documents the script's
dry-run mode.

The provider-neutral version of this procedure lives in
[DEPLOYMENT.md](DEPLOYMENT.md#14-backups).

## Troubleshooting summary

| Symptom | Likely cause |
| --- | --- |
| `variable is not set` on any command | `.env` missing or you are not in the repository root |
| `dependency failed to start: ... elasticsearch is unhealthy` | Not enough RAM; see section 12 |
| Every MongoDB connection fails authentication | Password changed after volume initialisation; see section 11 |
| Image uploads return `503` | Supabase variables absent; the rest of the app is unaffected |
| REST works, real-time updates do not | Socket.IO upgrade headers lost at a proxy hop; see section 14 |
| `auth-service` exits immediately | `JWT_SECRET` unset or empty |

For Supabase Storage setup and the legacy base64 image migration, see
[supabase-setup.md](supabase-setup.md).

Related current documents, all alongside this one:

- [DEPLOYMENT.md](DEPLOYMENT.md) — provider-neutral deployment notes, including
  the environment comparison and the backup procedure this section mirrors
- [SECURITY.md](SECURITY.md) — secret handling, and what must never be exposed
- [ARCHITECTURE.md](ARCHITECTURE.md) — services, ports, networking and proxying
- [tests/TEST-STRATEGY.md](tests/TEST-STRATEGY.md) — testing policy: what we
  test, quality gates, coverage and version governance
- [tests/TEST-PLAN.md](tests/TEST-PLAN.md) — the operational test plan:
  inventory, commands, known gaps

The numbered `00`–`26` documents in this directory predate the technical-debt
fixes and describe several since-resolved issues as if they were current; each
carries a banner saying so. Prefer this file and the four above for anything
deployment-related.
