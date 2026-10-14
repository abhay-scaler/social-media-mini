# CI Pipeline

`.github/workflows/ci.yml` runs on pushes to `main`, `develop`, `fix/**`, and
`feat/**`, on pull requests into `main` or `develop`, and on manual dispatch. A
newer push to the same ref cancels the in-flight run.

All jobs use **Node 22** and install with **`npm ci`**, never `npm install`, so
builds resolve exactly what the committed lockfiles pin.

## Jobs

| Job | Verifies |
| --- | --- |
| `security-checks` | The eight fixed bugs have not regressed; upload hardening is intact; no secrets are committed |
| `backend-tests` | auth-service, post-service, user-service suites (matrix) |
| `api-gateway` | Dependencies install and the service actually boots |
| `scripts-check` | Migration script parses and refuses to run unconfigured; both shell scripts parse |
| `frontend` | ESLint, production build, bundle secret scan |
| `compose-config` | The Compose file parses; Supabase vars reach only the upload services |
| `docker-build` | All five images build (matrix, with layer caching) |
| `stack-integration` | The microservices stack boots healthy with real MongoDB and Redis, and the registration saga is verified end to end |
| `ci-complete` | Fails if any job failed or was cancelled, so a skipped job cannot read as green |

### Reproducibility

Each install job runs `git diff --exit-code` against its lockfile afterwards.
`npm ci` rewriting a lockfile means the committed one is stale, and that fails
the build rather than passing silently.

`actions/setup-node` npm caching is keyed on each lockfile. The cache only
speeds up downloads; `npm ci` still installs exactly what the lockfile pins.

### Regression checks

`scripts/ci-security-checks.sh` runs the same way locally and in CI, inspecting
only git-tracked files:

```bash
./scripts/ci-security-checks.sh                               # source + secrets
./scripts/ci-security-checks.sh bundle social-media-mini-frontend/dist
```

It asserts the absence of `readAsDataURL`, `FileReader`, `diskStorage`,
`express.static`, `verifyCache = new Map`, `` `verify:${token}` `` (a raw bearer
token as a Redis key), `redisClient.keys(` (a blocking Redis scan),
`.originalname`, `req.file.mimetype`, the compromised JWT secret literal, and any hardcoded
`io("http://…")` in frontend sources.

It also asserts hardening is still *present*, so it cannot be quietly removed:
the SHA-256 verify-cache key, the `JWT_SECRET` startup check, `detectImageType`
in both upload paths, `memoryStorage`, and `upsert: false`.

Historical bug documentation under `docs/` quotes these patterns deliberately,
so `docs/` is excluded from the pattern checks and scanned only for real
credentials. The script also excludes itself, since it contains every pattern it
searches for.

### Secret handling

No real Supabase credential is used anywhere in CI.

- `stack-integration` generates a throwaway `JWT_SECRET`, `MONGO_ROOT_PASSWORD`
  and `INTERNAL_SERVICE_TOKEN` per run with `openssl rand -hex`, and masks each
  one, so nothing is stored in the repository or recoverable from the logs.
  auth-service and user-service both refuse to start without
  `INTERNAL_SERVICE_TOKEN`, so the stack cannot boot unless CI supplies it.
- Supabase variables are set to inert placeholders
  (`https://ci-placeholder.supabase.co`). These exercise the client-construction
  path so the services start with Supabase configured, but reach nothing.
- The frontend job scans the built bundle for `SUPABASE_SERVICE_ROLE_KEY`,
  `service_role`, `JWT_SECRET`, `MONGO_URI`, `mongodb://`, `SUPABASE_URL`, and
  JWT-shaped strings. Only `dist/` is uploaded as an artifact, never the
  workspace root.

Because the Supabase values are inert, **CI does not exercise a real upload
round-trip.** Adding one would require repository secrets holding a live
service-role key for a throwaway Supabase project — see
"Optional: real Supabase integration" below.

### Compose and container coverage

`docker-compose.microservices.yml` is the only Compose file in the repository.
CI parses it, builds all five images from it, and boots the full stack.

`stack-integration` builds images in a dedicated `Build stack images` step
before starting anything, so an image build failure is never mistaken for a
health failure in the step that follows. It then brings the stack up with
`--wait` (so Compose blocks until healthchecks pass) and verifies:

1. `/health` on auth-service, user-service, post-service, and api-gateway.
2. The frontend serves over nginx on port 80.
3. Redis answers `PING` and MongoDB answers `ping`.
4. Each application logged `MongoDB Connected` and `Redis Connected` — proving
   the apps established their backing connections, not merely that the
   processes are listening.
5. The registration saga, via `scripts/e2e-registration.sh` — the only CI step
   that exercises application behaviour against the real containers. It
   registers a user through Nginx and the gateway, reads the profile back out
   of user-service, asserts `/sync-user` is unreachable from a client even
   with the correct token, drives the internal guard with missing,
   wrong-length, wrong-value and multibyte tokens, and stops user-service to
   prove registration returns 503, rolls the credential record back, and
   leaves the email address free. The script restores user-service on every
   exit path, and `INTERNAL_SERVICE_TOKEN` reaches it from the job
   environment, so no token value is ever printed.
6. post-service and user-service did *not* log the
   "Supabase credentials not set" fallback, confirming they received their
   configuration.

On failure, a `Diagnostics` step emits `docker compose ps -a` (including
containers that exited or were never created), full untailed logs for the four
application services, tailed logs for MongoDB, Redis and Elasticsearch, and for
user-service the container `State` as JSON plus every health-probe attempt's
exit code and output — the datum that identifies *why* a probe failed, and that
distinguishes a crashed process (`ExitCode`, `OOMKilled`) from a failing probe.
It also reports runner memory and Docker disk usage, so an OOM kill is visible.
Each probe tolerates a missing container so one absent service cannot truncate
the report; this cannot mask the real failure, because the step only reports and
the failing step has already marked the job failed.

The stack is always torn down with `down -v --remove-orphans`.

Compose re-reads and re-interpolates the file on every invocation, so the
Supabase placeholders are set at **job** level rather than per-step — otherwise
`ps`, `logs`, `exec` and `down` warn that the variables are unset and compute a
config that no longer matches the running containers.

### api-gateway

api-gateway ships no test or lint script. Rather than a suppressed command that
always reports success, CI parses the module and starts it for real, failing if
the process exits during startup. It requires `AUTH_SERVICE_URL`,
`USER_SERVICE_URL`, and `POST_SERVICE_URL` to boot — it builds its proxy
middleware at module scope and throws on an undefined target — so the step
supplies those non-secret URLs, as Compose does.

### Known-failing integration test

`services/auth-service/verify-cross-service.integration.test.js` is intentionally
untracked and is not part of any commit, so a clean CI checkout does not contain
it and `npm test` in auth-service reports 18/18. It is left exactly as-is. If it
is ever committed, CI will fail on it by design — see the notes in its header.

### Optional: real Supabase integration

Not implemented, and not recommended without a dedicated throwaway project. It
would require these repository secrets:

| Secret | Purpose |
| --- | --- |
| `SUPABASE_URL_TEST` | Project URL of a **throwaway** Supabase project, never production |
| `SUPABASE_SERVICE_ROLE_KEY_TEST` | Service-role key for that throwaway project only |
| `SUPABASE_STORAGE_BUCKET_TEST` | A bucket used solely by CI |

Such a job should be gated to non-fork events (`github.event_name != 'pull_request' ||
github.event.pull_request.head.repo.full_name == github.repository`), since
secrets are not exposed to fork PRs, and it should delete the objects it creates.
