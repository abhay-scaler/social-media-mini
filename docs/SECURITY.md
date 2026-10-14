# Security

What must be protected in this project, and what the repository deliberately
does not contain.

## The repository ships development values

`docker-compose.microservices.yml` is a development configuration. It contains
values that are safe to commit precisely because they are **not** secrets and
must never become production credentials:

- Redis with no password
- Elasticsearch with `xpack.security.enabled=false`

MongoDB credentials are **not** among them: `docker-compose.microservices.yml`
reads `MONGO_ROOT_USERNAME` and `MONGO_ROOT_PASSWORD` from `.env`, and the
password has no default, so an unset value fails visibly rather than falling
back to a well-known one.

Internal service ports are no longer published either — only the frontend's
port 80 is reachable from the host.

None of these are production settings. [DEPLOYMENT.md](DEPLOYMENT.md) covers
what has to change before the stack faces the internet.

Likewise, the placeholder values in `.env.example` and the
`ci-placeholder-not-a-real-key` strings in the CI workflow are inert fixtures,
not credentials. They exist so the configuration path can be exercised without
granting access to anything. Treating them as real secrets, or substituting real
secrets for them in the repository, defeats the purpose.

## Never commit secrets

`.env` is gitignored (`**/.env`) and only `.env.example` is tracked. Keep it
that way.

Never commit, in any form:

- `.env` files holding real values
- Supabase service-role keys
- JWT secrets
- production database passwords or connection strings containing credentials
- TLS private keys

Git history is permanent. A secret that is committed and later removed is still
in the history and must be treated as compromised and rotated — removing the
file is not a remediation.

`scripts/ci-security-checks.sh` runs in CI and fails the build on committed
`.env` files, credential-shaped literals, and JWT-shaped strings. Run it locally
before pushing:

```bash
./scripts/ci-security-checks.sh
```

## A previously exposed JWT secret

A development `JWT_SECRET` was committed to this repository's history. It must
be considered **compromised**. Any environment that ever used it has to move to
a freshly generated secret, and that value must never be used again.

The value is not reproduced here, and should not be copied into any
documentation, issue, or commit message.

## Production JWT secret

Generate a new secret for production and for every other environment:

```bash
openssl rand -hex 32
```

`auth-service` refuses to start when `JWT_SECRET` is unset or empty, so a
missing secret fails loudly at boot rather than producing confusing errors on
every login. That check cannot tell a weak or reused secret from a strong one —
generating a fresh value is your responsibility.

Rotating the secret invalidates every issued token, logging all users out. Plan
for that.

## Production MongoDB password

Set `MONGO_ROOT_PASSWORD` in `.env` to a strong value. Compose derives both the
database's root credentials and every service's `MONGO_URI` from that one
variable, so they cannot drift.

`MONGO_INITDB_*` applies only when the data volume is first initialised, so
**set the password before the first start**. Changing it later leaves the
existing user on the old password while the services present the new one, and
every connection fails. Recovery steps are in
[DEPLOYMENT.md](DEPLOYMENT.md#the-mongodb-password-is-set-once-at-first-initialisation).

## The Supabase service-role key is backend-only

The service-role key bypasses all row-level security in your Supabase project.
It is a backend credential and nothing else.

It is passed only to `post-service` and `user-service`. It must never reach:

- frontend source or the built bundle
- the browser, in any form
- API responses
- logs or error messages
- `api-gateway`, which has no need for it

The frontend reads **no** environment variables at all, so it cannot receive the
key by accident. CI enforces this on every run: the built bundle is scanned for
`SUPABASE_SERVICE_ROLE_KEY`, `service_role`, `JWT_SECRET`, `MONGO_URI`, and
JWT-shaped strings, and a Compose assertion fails the build if Supabase
variables appear on any service other than those two.

If the key is ever exposed, rotate it in the Supabase dashboard immediately.

## What should not be publicly reachable

Only the frontend is a public entry point. In production, these must not be
reachable from the internet:

| Service | Port | Why |
| --- | --- | --- |
| MongoDB | 27017 | Full database access |
| Redis | 6379 | No password configured |
| Elasticsearch | 9200, 9300 | Security disabled; full index read/write |
| auth-service | 3001 | Internal; `/verify` issues trust decisions |
| user-service | 3002 | Internal |
| post-service | 3003 | Internal |
| api-gateway | 5000 | Reached through Nginx `/api/` |

The Compose file publishes all of them for development convenience. Remove
those `ports:` entries or bind them to `127.0.0.1` before deploying, and apply a
host firewall. Both steps matter: Docker's published ports are implemented with
`iptables` rules that can bypass some firewall configurations, so a firewall
alone is not enough.

Internal traffic does not depend on published ports. Containers on
`microservices-network` address each other by service name, so unpublishing a
port does not break anything inside the stack.

## Storing production secrets

Keep secrets outside Git. In rough order of preference:

1. A platform secret manager, injected at deploy time and never written to disk.
2. Docker secrets, with a Swarm deployment.
3. A root-owned `.env` with `chmod 600`, backed up separately from the repository.

Never bake a secret into an image or pass one as a build argument — both persist
in image layers that anyone who can pull the image can read.

## Application-level protections

Already enforced in the code, worth knowing so they are not accidentally removed:

- **Uploads** require authentication, cap files at 5 MB, and validate the file's
  actual magic bytes rather than the browser-supplied `Content-Type`. The stored
  object's extension and content type are both derived from those bytes, so a
  crafted filename cannot plant an executable extension or traverse paths. SVG
  is rejected — it can carry script. Uploads use `upsert: false` and so cannot
  overwrite an existing object.
- **Object keys** are `posts/{userId}/{uuid}` and `profiles/{userId}/{uuid}`,
  where the user id comes from the verified JWT, never from request input.
- **Token verification** is cached in Redis for 5 seconds, keyed on a SHA-256
  digest rather than the bearer token itself, so a dump of Redis keys yields no
  usable credentials. If Redis is unavailable, verification falls back to full
  JWT validation plus a database lookup — it never fails open. The cache does
  mean a revoked or just-expired token can be accepted for up to 5 seconds.
- **Rate limiting** applies to authentication, posting, commenting, liking,
  searching, and uploading.
- **Passwords** are hashed with bcrypt and never returned by any endpoint.

`scripts/ci-security-checks.sh` asserts these remain in place, so removing one
fails CI rather than passing quietly.

## Reporting a vulnerability

Open a private security advisory on the repository rather than a public issue,
and do not include working credentials or exploit payloads in the report.
