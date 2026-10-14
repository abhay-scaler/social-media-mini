# Deployment

How to run this stack on a production VM, and how that differs from the other
environments the project runs in.

> **The Compose file as checked in is a development configuration.** It carries
> a well-known MongoDB password, publishes every internal port on the host, and
> terminates plain HTTP. Working through this document is what turns it into
> something deployable. Read [SECURITY.md](SECURITY.md) alongside it.

## Environments

| Environment | What runs | Secrets | Exposure |
| --- | --- | --- | --- |
| **Local development** | Vite dev server plus services, or the full Compose stack | Your own `.env`, gitignored | localhost only |
| **Codespaces** | Full Compose stack; the stack has been verified to start and become healthy here | Development values | Codespaces port forwarding |
| **CI** (GitHub Actions) | Full Compose stack, built and health-checked on every push | Throwaway `JWT_SECRET` generated per run; inert Supabase placeholders | Runner-local only |
| **Production VM** | Full Compose stack behind a TLS reverse proxy | Real secrets from outside Git | Only 80/443 public |

CI never holds a real credential. See [ci.md](ci.md).

## 1. VM requirements

The constraint is Elasticsearch, which is configured with a 512 MB heap
(`ES_JAVA_OPTS=-Xms512m -Xmx512m`) and needs roughly double that in practice.

- **4 GB RAM minimum**, 8 GB comfortable. Below 4 GB, Elasticsearch will be
  OOM-killed and `user-service` will never start, because it waits for
  Elasticsearch to report healthy.
- 2 vCPU
- 20 GB disk, more if MongoDB will grow
- A current 64-bit Linux with a maintained kernel
- `vm.max_map_count` of at least 262144 for Elasticsearch:

```bash
sudo sysctl -w vm.max_map_count=262144
echo 'vm.max_map_count=262144' | sudo tee -a /etc/sysctl.conf
```

The VM provider has not been chosen yet. Nothing in this stack depends on a
particular one — any VM meeting the above will do. Do not assume any provider's
free tier is suitable or available.

## 2. Install Docker

Use Docker's official convenience script or your distribution's documented
repository, then confirm the Compose plugin is present:

```bash
docker --version
docker compose version
```

This project uses `docker compose` (the plugin), not the legacy
`docker-compose` binary.

## 3. Check out the repository

```bash
git clone https://github.com/abhay-scaler/social-media-mini.git
cd social-media-mini
```

## 4. Production environment variables

```bash
cp .env.example .env
chmod 600 .env
```

`.env` is gitignored and must stay that way. Set:

| Variable | Notes |
| --- | --- |
| `JWT_SECRET` | **Generate a new one**: `openssl rand -hex 32`. Never reuse a development value. |
| `SUPABASE_URL` | Your production Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Production service-role key. Backend-only — never expose it to a browser. |
| `SUPABASE_STORAGE_BUCKET` | Defaults to `uploads` if unset |

Compose reads `.env` from the project directory for `${VAR}` interpolation, and
re-interpolates on **every** invocation. Run `docker compose` commands from the
project directory, or the variables resolve empty and the computed config stops
matching the running containers.

### The MongoDB password is set once, at first initialisation

`docker-compose.microservices.yml` reads both credentials from `.env`, so
setting them in one place is enough — they cannot drift between the database
and its clients:

```yaml
MONGO_INITDB_ROOT_USERNAME: ${MONGO_ROOT_USERNAME:-root}
MONGO_INITDB_ROOT_PASSWORD: ${MONGO_ROOT_PASSWORD}
```

and in each service's connection string:

```yaml
MONGO_URI=mongodb://${MONGO_ROOT_USERNAME:-root}:${MONGO_ROOT_PASSWORD}@mongodb:27017/<db>?authSource=admin
```

`MONGO_ROOT_PASSWORD` has no default. If it is unset, Compose warns and
interpolates an empty string — a visible failure rather than a silent weak
default.

**Set it before the first start.** `MONGO_INITDB_*` applies only when the image
initialises an empty data directory, so changing `.env` later does not change
the existing user's password: the services would then authenticate with the new
value against a user that still has the old one, and every connection would
fail. To change it afterwards, either rotate it inside MongoDB with
`db.changeUserPassword` and update `.env` to match, or recreate the volume with
`down -v`, which destroys all data.

Avoid `@ : / ? #` and `%` in the password — it is embedded in a connection URI
without percent-encoding, so those characters break the URI.

## 5. Secret handling

Keep production secrets out of Git entirely. Options, in rough order of
preference: your platform's secret manager injected at deploy time; a
root-owned `.env` with `chmod 600`; Docker secrets with a Swarm deployment.

Never bake secrets into an image, never pass them as build args, and never
commit `.env`. Details and rationale in [SECURITY.md](SECURITY.md).

## 6. Start the stack

Validate the resolved configuration first — this catches unset variables before
anything runs:

```bash
docker compose -f docker-compose.microservices.yml config
```

Then build and start:

```bash
docker compose -f docker-compose.microservices.yml up -d --build
```

To block until everything is healthy rather than returning immediately:

```bash
docker compose -f docker-compose.microservices.yml up -d --build --wait
```

Expect several minutes on a first run: five images build, and the dependency
chain serialises startup behind Elasticsearch.

## 7. Verify

```bash
docker compose -f docker-compose.microservices.yml ps
```

Every service except `frontend` should show `healthy` (`frontend` declares no
health check, so it shows only as running).

**Only port 80 is published to the host.** The Compose file maps `80:80` for the
`frontend` service and nothing else, so the gateway (5000) and the three
services (3001–3003) are reachable only from inside the
`microservices-network` bridge. Probe them accordingly.

From the host, through Nginx on port 80:

```bash
curl -I http://localhost/                  # Nginx serving the frontend
curl http://localhost/api/health/all       # gateway + three backends, via Nginx
```

`/api/health/all` returns `200` when all three backends are healthy and `503`
otherwise, which makes it a reasonable target for an external monitor. Reaching
it through Nginx also exercises the public request path a user takes, rather
than bypassing the proxy.

For a container-internal endpoint — here the gateway's own `/health`, which is
not proxied — probe from inside the network instead. Run these from the
repository directory so Compose finds the project:

```bash
docker compose -f docker-compose.microservices.yml exec -T api-gateway \
  wget -q -O - http://localhost:5000/health
```

Inside that container, `localhost:5000` is the gateway's own listener. To check
a service by name across the network, probe from the gateway:

```bash
docker compose -f docker-compose.microservices.yml exec -T api-gateway \
  wget -q -O - http://auth-service:3001/health
```

Substitute `user-service:3002` or `post-service:3003` as needed. `wget` is used
rather than `curl` because the service images are `node:22-alpine`, whose
BusyBox `wget` is also what the container health checks use.

Confirm each application actually reached its dependencies — the health
endpoints only prove the processes are listening:

```bash
docker compose -f docker-compose.microservices.yml logs auth-service | grep Connected
```

Expect `MongoDB Connected` and `Redis Connected`. For post-service and
user-service, the absence of `Supabase credentials not set` confirms they
received their Supabase configuration.

## 8. Firewall

Allow only what the public needs:

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp      # SSH — restrict to your own address if possible
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

A host firewall alone is not sufficient. Docker publishes ports by writing
`iptables` rules that can bypass some firewall configurations, so also remove
the unnecessary `ports:` mappings as described next.

## 9. Public versus private ports

The Compose file publishes **every** service on the host, which is convenient
for development and wrong for production. Only the frontend should be reachable.

| Service | Port | Production |
| --- | --- | --- |
| `frontend` (Nginx) | 80 | **Public** — the application entry point |
| `api-gateway` | 5000 | Private — reached via Nginx `/api/` |
| `auth-service` | 3001 | Private |
| `user-service` | 3002 | Private |
| `post-service` | 3003 | Private |
| `mongodb` | 27017 | Private — never public |
| `redis` | 6379 | Private — never public, it has no password |
| `elasticsearch` | 9200, 9300 | Private — never public, security is disabled |

Containers on `microservices-network` reach each other by service name without
any published port, so removing a `ports:` entry does not break internal
traffic. For anything you want reachable from the host but not the internet,
bind to loopback instead of deleting the mapping:

```yaml
ports:
  - "127.0.0.1:5000:5000"
```

Elasticsearch runs with `xpack.security.enabled=false` and Redis with no
password. Both are unauthenticated: exposing either publicly hands over full
read and write access.

## 10. HTTPS and domain

**The Compose file does not provide HTTPS.** The `frontend` container listens on
plain HTTP port 80 and `nginx.conf` has no TLS configuration. Adding TLS is a
deployment step you perform; nothing in the repository does it for you.

The usual approach is a TLS-terminating reverse proxy in front of the stack —
Caddy, Traefik, or a host Nginx with Certbot — holding the certificate for your
domain, listening on 443, and forwarding to the frontend container. Point your
domain's A record at the VM, obtain a certificate, and redirect 80 to 443.

When you put a proxy in front, forward `X-Forwarded-For` and
`X-Forwarded-Proto`. The Node services set `app.set('trust proxy', 1)`, so
rate limiting depends on those headers to identify real client addresses.

WebSocket traffic must survive the extra hop: the outer proxy needs the same
`Upgrade`/`Connection` handling that the stack's own `nginx.conf` already
applies to `/socket.io/`, or real-time updates will fail while REST keeps
working.

## 11. Persistent volumes

`mongodb_data`, `redis_data`, and `elasticsearch_data` are local named volumes.
They survive `down` and container replacement, and are destroyed by `down -v`.

```bash
docker volume ls
docker volume inspect social-media-mini_mongodb_data
```

Of the three, only `mongodb_data` holds data you cannot rebuild. Redis is a pure
cache; the Elasticsearch index is derived from MongoDB and is repopulated as
users are created or updated.

## 12. Updating and redeploying

```bash
cd social-media-mini
git pull origin main
docker compose -f docker-compose.microservices.yml up -d --build
```

Compose recreates only containers whose image or configuration changed. Volumes
are untouched, so data persists. To force a single service:

```bash
docker compose -f docker-compose.microservices.yml up -d --build --force-recreate user-service
```

Expect a brief interruption — there is no rolling deployment here, and
`depends_on` health gating means a restarted dependency can hold up the
services above it.

## 13. Logs and troubleshooting

```bash
docker compose -f docker-compose.microservices.yml logs -f
docker compose -f docker-compose.microservices.yml logs --tail=200 user-service
docker compose -f docker-compose.microservices.yml ps -a   # includes exited containers
```

When a container is unhealthy, the health check's own output is the fastest
route to the cause:

```bash
docker inspect user-service --format '{{json .State.Health}}' | python3 -m json.tool
```

`State.Health.Log` holds each probe's exit code and output. `State.ExitCode` and
`State.OOMKilled` distinguish a crashed process from a merely failing probe.

### `dependency failed to start: container X is unhealthy`

`up` aborted because something X depends on never became healthy. Work **down**
the chain, not up: check the logs of the first unhealthy service in the ordering
under [ARCHITECTURE.md](ARCHITECTURE.md#startup-ordering). An application that
exits at startup shows its error at the *beginning* of its logs, so avoid
`--tail` when reading a crash loop.

### MongoDB health check

The MongoDB health check is intentionally a direct `mongosh --eval` invocation:

```yaml
test: ["CMD", "mongosh", "localhost:27017/test", "--quiet", "--eval", "db.runCommand({ping: 1}).ok"]
interval: 10s
timeout: 10s
retries: 5
```

An earlier version piped a script into `mongosh` through a shell. That form
produced false unhealthy results and timeouts in the Codespaces environment,
which in turn blocked every service that waits on MongoDB. **Do not replace this
with a shell pipeline or "simplify" it** — the direct `--eval` form is the fix.

### Elasticsearch never becomes healthy

Almost always memory. Check `docker stats` and `dmesg | grep -i oom`. Either
give the VM more RAM or lower the heap in the `ES_JAVA_OPTS` setting. Because
`user-service` gates on Elasticsearch, this surfaces as `user-service` failing
to start.

### Image uploads return 503

`SUPABASE_URL` or `SUPABASE_SERVICE_ROLE_KEY` did not reach the service. The
service logs `Supabase credentials not set` at startup when that happens. Check
`.env` and confirm you ran Compose from the project directory. The rest of the
application works normally in this state.

### Real-time updates stop while the rest of the app works

Socket.IO specific. `/socket.io/` is proxied by Nginx straight to
post-service:3003, bypassing the gateway, and needs WebSocket upgrade headers at
every hop. Check post-service logs and your outer TLS proxy's upgrade handling.

## 14. Backups

`mongodb_data` is the only volume holding unrecoverable data.

MongoDB's port is not published, so the dump runs inside the container. Run it
from the repository directory:

```bash
docker compose -f docker-compose.microservices.yml exec mongodb \
  mongodump --archive --gzip \
  --username "root" --authenticationDatabase admin \
  > "backup-$(date +%F).archive.gz"
```

There is deliberately no `--password` flag: `mongodump` prompts for it, so the
value never enters your shell history or the process list. Use the username from
`MONGO_ROOT_USERNAME` (`root` unless changed) and enter the
`MONGO_ROOT_PASSWORD` value at the prompt. `exec` is used without `-T` because
the prompt needs a TTY.

Restore with `mongorestore --archive --gzip` from the same archive. **Restoring
overwrites data** — take a fresh dump of the target first. Verify a restore into
a throwaway instance periodically; an untested backup is not a backup.

Keep dumps **off the instance** and separate from the persistent volumes, with
controlled retention and access — a dump is a full copy of every user record.
The AWS-specific procedure, including restore verification, is in
[AWS-EC2-DEPLOYMENT.md](AWS-EC2-DEPLOYMENT.md#15-backup-and-restore).

Also back up, outside Git: your `.env`, your TLS certificates (or the means to
reissue them), and your Supabase project configuration. Supabase Storage objects
are not covered by a MongoDB dump; MongoDB holds only their URLs, so the bucket
needs its own backup policy.

Before any upgrade that touches data, snapshot the VM or dump the database
first. Take a backup before running
`scripts/migrate-base64-images.js` — see [supabase-setup.md](supabase-setup.md).
