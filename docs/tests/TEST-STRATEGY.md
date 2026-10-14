# Test Strategy — social-media-mini

**Status:** current policy. **Companion document:** [TEST-PLAN.md](TEST-PLAN.md).

This document states **what we test, why, who owns it, and what must pass**. It
is deliberately short and stable: it should change when a policy changes, not
when a test is added.

Operational detail — the test inventory, the commands, per-service analysis,
environment prerequisites, troubleshooting, known defects and the full
historical record — lives in [TEST-PLAN.md](TEST-PLAN.md). Where this document
states a rule, the plan shows the evidence and the mechanics. Neither repeats
the other.

> **Reading the status labels.** Throughout this document:
> **`[today]`** exists and runs now · **`[CI]`** enforced by
> [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) ·
> **`[policy]`** a rule we hold ourselves to · **`[planned]`** recommended, not
> built · **`[gap]`** a known, unresolved shortfall.
>
> Nothing here implies that end-to-end, contract, load, DAST or frontend
> coverage exists. **None of those exist today.** Where this strategy
> recommends them, they are marked `[planned]`.

---

## 1. Purpose and scope

**Purpose.** Give one place that answers "is this change safe to merge?" and
"what are we not covering, deliberately?" — without having to read a 2,600-line
plan.

**In scope.** The eight-container stack defined by
[`docker-compose.microservices.yml`](../../docker-compose.microservices.yml):
the React/Nginx frontend, the API gateway, the three Node services, and the
MongoDB, Redis and Elasticsearch they depend on. Also the CI pipeline itself,
the security-regression script, and the deployment smoke checks.

**Out of scope.** Supabase Storage internals (external, billable — never called
from an automated test); penetration testing (deferred until TLS exists and the
system holds real data); and anything requiring a staging environment, which
does not exist. Each exclusion is a stated trade-off, not an oversight.

**Audience.** Whoever opens a pull request. There is no separate QA function on
this project; the author of a change is its tester.

---

## 2. Testing principles and risk-based priorities

**P1 — Test the code that ships.** A test that exercises a copy of the logic
proves nothing about the product. This is not abstract here: all three service
suites rebuild a replica Express app inside the test file, and the replica has
already drifted from production in two measured places. **`[gap]`** Closing it
is the single highest-priority item in this strategy. Evidence and the fix:
[TEST-PLAN.md §30 C1](TEST-PLAN.md#critical).

**P2 — A Testing Trophy, not a pyramid.** This codebase has almost no pure
domain logic; business rules live inside Express handlers interleaved with
Mongoose, Redis and Axios. Unit-testing those means mocking everything, which
produces tests that fail on refactor and pass on breakage. The investment layer
is therefore the **service-level API test against the real `server.js` and a
real in-memory MongoDB**, stubbing only what crosses a process boundary.

**P3 — Automate the deterministic; leave judgement to people.** Visual
correctness, usability, exploratory probing and production-report reproduction
stay manual. Automation nobody trusts is worse than none: it consumes
maintenance budget and trains the team to ignore red.

**P4 — Prioritise by risk, not by coverage.** Effort goes where a defect would
hurt most, which here means authentication, authorization and cross-service
trust — not breadth.

**P5 — Assert accepted trade-offs rather than ignoring them.** The 5-second
verify cache means a deleted user's token works briefly. That is a design
decision; the test suite should pin the window, not pretend it is absent.

**P6 — Every production defect ships a test with its fix,** at the lowest layer
that could have caught it. This is what compounds suite value over time.

**Risk-based priority order.** Full scored register with probability and impact:
[TEST-PLAN.md §23](TEST-PLAN.md#23-risk-based-testing). The top four, which set
the order of work:

| # | Risk | Status |
| --- | --- | --- |
| 1 | Service suites validate replicas, not shipped code | **`[gap]`** |
| 2 | ~~`POST /api/users/sync-user` unauthenticated~~ — closed by an internal service token | **`[resolved]`** |
| 3 | Ownership-bypass authorization on four mutation routes is untested | **`[gap]`** |
| 4 | `/verify` response-shape drift would break every authorization check silently | **`[gap]`** |

Risk 2 was a product defect that testing surfaced rather than test debt: the
assertion written for it failed, the endpoint was then closed, and it now
passes. Risk 3 is the opposite case — the four server-side ownership checks exist in
the product, and the suite asserts one of them, but against the replica app
rather than the shipped `server.js`. It therefore protects nothing real, which
is risk 1 in a different costume, and both remain open.

---

## 3. Testing levels

What each level is for, and its honest current state. The full layer
specification — purpose, scope, mocking boundary, speed and owner per level — is
[TEST-PLAN.md §3](TEST-PLAN.md#3-microservices-test-architecture).

| Level | Purpose | State |
| --- | --- | --- |
| **Static analysis and linting** | Defects without executing the product | **`[today]` `[CI]`** ESLint on the frontend; `scripts/ci-security-checks.sh`; CodeQL `security-and-quality`; `npm ci` lockfile-drift assertion |
| **Unit** | Exhaustive edge cases on pure logic | **`[today]` `[CI]`** `imageType.js` magic-byte detection and `imageReference.js` origin validation in both upload services; `internalAuth.js` in user-service. The only suites importing a production module |
| **Service-level (API)** | A service's real HTTP contract and real persistence | **`[today]` `[CI]`** three suites run and pass — but against replica apps, so the assurance is not what the count suggests. **`[gap]`** |
| **Cross-service integration** | Trust and data flows between services | **`[today]` `[CI]`** `scripts/e2e-registration.sh` runs in `stack-integration` against the booted stack: registration through Nginx and the gateway, the profile read back from user-service, `/sync-user` unreachable from a client, the internal guard against missing/wrong-length/wrong-value/multibyte tokens, and the rollback path with user-service stopped. **`[gap]`** the `PUT /me` → `posts:feed:global` invalidation and `protect` against a live auth-service are still uncovered; one untracked file exists and fails |
| **Full-stack / infrastructure** | The assembled stack actually boots and serves | **`[today]` `[CI]`** `stack-integration` brings up all eight containers with `up -d --wait`, which gates on the **seven** that declare a health check; probes the three services and the gateway by name inside the Docker network; checks `/api/health/all` through Nginx and `:80` for the frontend (which declares no health check); and asserts MongoDB/Redis connectivity with `redis-cli`/`mongosh` and from the application logs |
| **Contract** | Stop silent provider/consumer shape drift | **`[planned]`** Two pairings earn it; see [TEST-PLAN.md §7](TEST-PLAN.md#7-contract-testing) |
| **End-to-end** | Prove the assembled system delivers a journey | **`[gap]` — no browser E2E exists.** No Playwright, Cypress or any browser automation in the repository. Thirteen journeys are specified in [TEST-PLAN.md §8](TEST-PLAN.md#8-end-to-end-strategy); none is driven through a browser. The registration journey is covered at API level one row above, which is the lowest level that can catch its defects |
| **Frontend component** | Auth and form logic | **`[gap]` — no frontend test tooling at all.** No Vitest, Jest, Testing Library, MSW or jsdom |
| **Non-functional** (load, DAST, container scan, accessibility) | Behaviour under load, attack, failure | **`[planned]`** none implemented |
| **Deployment smoke** | Confirm the deployed stack is serving | **`[planned]`** the checks are specified; nothing runs them automatically |

**Policy on levels.** A test belongs at the **lowest level that can catch its
defect**. If something is expressible as a service-level API test, it does not
go in E2E. E2E is capped at **15 specs, permanently** — a larger E2E suite is a
symptom of under-investment one level down, not progress.

---

## 4. Responsibilities and ownership

This is a single-maintainer project today. The policy is written so it still
holds if that changes.

| Area | Owner | Responsibility |
| --- | --- | --- |
| A change's tests | **The author of the change** | Tests land in the same pull request as the code. No "tests to follow" |
| A service's suite | The service owner | Keeping it green, fast and honest; fixing its flaky tests |
| CI pipeline and harness | Whoever maintains the platform | The workflow, the security script, the quality gates themselves |
| Quality gates | Agreed in this document | Changing a gate is a change to this file, reviewed like code |
| This strategy | The maintainer | Reviewed when a policy changes, not on a schedule |

**Non-negotiable:** a red pipeline is nobody's background task. Whoever's change
turned it red owns it until it is green or reverted.

---

## 5. Quality gates and acceptance criteria

**The rule.** Gate on checks that are **deterministic, fast, and indicative of
real risk**. Alert — never block — on anything noisy or environment-sensitive.
Never gate on a metric people can game.

**Blocking today `[CI]`** — the `ci-complete` job fails if any of these fails or
is cancelled, so a skipped job cannot read as green:

| Gate | Criterion |
| --- | --- |
| `scripts/ci-security-checks.sh` | every assertion passes |
| Service test suites (3-way matrix) | 100% pass, `fail-fast: false` |
| Lockfile reproducibility | `git diff --exit-code` clean after `npm ci` — four assertions: the three-service matrix, `api-gateway`, the frontend, and the root scripts package |
| Frontend ESLint + production build | 0 errors, build succeeds |
| Frontend bundle secret scan | no backend secret in `dist/` |
| `api-gateway` proxy behaviour | 17 tests against the real `server.js` in front of stub upstreams: the internal token never reaches an upstream, `Authorization` does, prefixes are stripped, and a refused *or hung* upstream yields the documented JSON 503 |
| `api-gateway` module load | parses and boots with its proxy targets set |
| Migration script check | parses and refuses to run unconfigured |
| Compose files parse | `docker compose config` succeeds |
| All five images build | `docker build` succeeds |
| Stack integration | `up -d --wait` succeeds (gating on the seven health-checked services), in-network probes and the Nginx aggregate check pass |

**Blocking, separate workflow `[CI]`:** CodeQL `security-and-quality` on pushes
to `main`/`develop`, pull requests into `main`, and weekly.

**Planned gates `[planned]`** — each becomes blocking only when it exists and
has proven stable for a week: contract schema checks; critical E2E; `npm audit`
on high/critical in production dependencies (**not run at all today**);
container scanning on critical CVEs.

**Alert, never block `[policy]`:** performance against a recorded baseline; the
extended E2E suite; accessibility findings. A failure opens a bug; it does not
stop the line.

**Acceptance criteria for merging.** Every blocking gate green; no new `[gap]`
introduced without being recorded in the plan; and any fixed defect accompanied
by the test that would have caught it.

Current per-gate status, including the ones not yet wired up:
[TEST-PLAN.md §22](TEST-PLAN.md#22-quality-gates).

---

## 6. Security, reliability and regression testing expectations

**Security — what we require `[policy]`.**

- **Authorization is tested negatively, always.** For every ownership-protected
  route, a cross-user attempt must be asserted to fail. This matters more than
  usual here because the frontend makes the same decision client-side from
  `localStorage`, so the server check is the only real control. **`[gap]`** —
  not covered today.
- **No credential or token value is ever committed.** Enforced **`[CI]`** by
  `scripts/ci-security-checks.sh`, which asserts `.env` is untracked and
  gitignored and that no credential literal or JWT-shaped string appears in
  tracked code or config.
- **No credential is logged by a test or passed on a command line.** This is
  **`[policy]`** only — nothing checks it. Reviewers enforce it.
- **Hardening is asserted positively, not just negatively.** The security script
  checks that controls are still *present* — SHA-256 cache keys, `upsert: false`
  on uploads, magic-byte validation — so removing one fails the build. This
  pattern is unusually effective and should be **extended rather than
  replaced** when new controls land.
- **Known-unauthenticated endpoints get a test that asserts the intended
  behaviour**, even while it fails. A failing test that documents a real defect
  is more honest than no test. Both such endpoints in this repository have
  since been closed, and the assertions now pass.
- **Supabase is never called from an automated test** — external, billable,
  credential-bearing. Stub the client; the magic-byte validation that actually
  guards the endpoint is unit-tested instead.

**Reliability `[policy]`.** Degradation must be a **verified property**, not a
hope. For every backing store, the documented behaviour when it is unavailable
is asserted — and the critical invariant is that authentication **never fails
open**. The failure matrix and expected behaviour per dependency:
[TEST-PLAN.md §11.3](TEST-PLAN.md#113-resilience). **`[planned]`** — specified,
not yet automated.

**Regression `[policy]`.** Three rules:

1. **No S1 or S2 defect closes without an automated test** at the lowest layer
   that can catch it.
2. **Fixed bugs are protected by assertion where an assertion is possible.**
   `scripts/ci-security-checks.sh` pins the historical defects whose regression
   is detectable by inspecting code or config — the hardcoded Socket.IO host,
   base64 image storage, the compromised JWT secret and the in-memory verify
   cache — which is why it blocks. **`[gap]`** Four of the eight are *not*
   covered by it: the `/verify` interface divergence, the registration-sync
   rollback, the feed cache key, and the Vite dev proxy. Verified — the script
   contains no reference to `Authorization`, sync/rollback/retry,
   `posts:feed:global` or the proxy config. Those depend on tests, and the test
   suites exercise replicas, so **their regression protection is weaker than the
   script's green tick suggests.**
3. **A removed test needs the same justification as removed code.** Deleting a
   test that nobody trusted is a net gain — deleting one quietly is not.

---

## 7. Coverage policy and how to read it

**Coverage is a signal, not a quality guarantee.** It measures which lines ran,
never whether the assertions were worth making.

**The policy `[policy]`:**

- **Use a ratchet, not a target.** Coverage may not decrease. A ratchet rewards
  adding tests where code changes; an absolute target rewards assertion-free
  tests that execute lines.
- **Measure where risk is.** The number that matters is coverage of
  authentication and authorization paths, not the global figure. Direction when
  a gate is introduced: ~70% lines per service, ~80% on auth paths.
- **Do not chase 100%.** The last few percent is error handlers and defensive
  branches whose tests cost more to maintain than the bugs they catch.
- **The global figure is not a release criterion** and must not be reported as a
  quality headline.

**How to read today's numbers — they currently mislead.** Measured with
`npm test -- --coverage` on Node 22: user-service and post-service each report
100% across all four metrics **for `imageType.js` alone**, and auth-service
reports **0%**, because its suite imports no production module. The suites
cover replica apps that coverage tooling cannot see. **Until the replica gap is
closed, no coverage figure from this repository is meaningful**, which is
exactly why no coverage gate is enforced. `backend-tests` does not run coverage.

**Coverage output is a generated artifact.** `services/*/coverage/` is
gitignored and must not be committed; 33 such files were tracked historically
and were later removed from the index. How to generate and read a report:
[TEST-PLAN.md §0.4](TEST-PLAN.md#04-coverage-reporting).

---

## 8. Test environment and reproducibility principles

**Principles `[policy]`:**

1. **A test environment is an artifact, not a place.** Created per run,
   destroyed after. No shared mutable state, no environment anyone has to
   maintain by hand.
2. **The service suites require no infrastructure.** MongoDB comes from
   `mongodb-memory-server` in-process. A laptop and a CI runner must behave
   identically — if a test needs a running container to pass, it belongs at a
   higher level.
3. **Installs are reproducible or they are broken.** `npm ci` from a committed
   lockfile everywhere, with CI asserting the lockfile is unchanged afterwards.
   **`[gap]`** The Dockerfiles use `npm install --production` (and the frontend
   `npm install`), so **image builds are not reproducible even though the
   lockfiles are** — see [TEST-PLAN.md §30 L1](TEST-PLAN.md#low).
4. **Test topology must match deployed topology.** Stack-level tests use the
   real `docker-compose.microservices.yml` rather than a re-implementation,
   because a test topology that drifts from the deployed one is the bug class
   that makes integration tests worthless.
5. **Probe the way the consumer does.** Service-to-service checks go by service
   name inside the Docker network; anything standing in for a user goes through
   the single published port. Only the frontend publishes a host port, so a test
   that assumes host access to a backend is wrong by construction.
6. **Every test creates what it needs and asserts only on what it created.** No
   test depends on another's residue; unique identities via `randomUUID()`, not
   timestamps.
7. **No production data in any environment, ever.** Synthetic users on
   `@example.test`. Production validation is read-only.
8. **There is no staging environment `[gap]`.** `main` deploys straight to the
   EC2 instance. Accepted trade-off for a project at this scale; the mitigation
   is a deployment smoke suite and a *rehearsed* rollback, and the trade-off
   should be revisited the moment real users would notice a bad deploy.

Prerequisites, exact commands and the per-environment matrix:
[TEST-PLAN.md §0.2](TEST-PLAN.md#02-prerequisites) and
[§20](TEST-PLAN.md#20-environment-strategy).

---

## 9. Dependency and runtime version-management policy

**The single rule: one authoritative source per component, and documents link
to it rather than copying the value.** A version written into prose is a version
that goes stale silently. This section names the source of truth; it does not
restate what the file says.

| Component | Authoritative source | Notes |
| --- | --- | --- |
| Node.js for CI and tests | `NODE_VERSION` in [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) | One place, referenced by every job |
| Node.js in service images | the `FROM` line of each service [`Dockerfile`](../../services) | Must track `NODE_VERSION`; they agree today |
| Node.js in the frontend build | [`social-media-mini-frontend/Dockerfile`](../../social-media-mini-frontend/Dockerfile) | Build stage only; the runtime stage is an Nginx image |
| Application dependencies | each `package.json` + `package-lock.json` | Lockfiles are committed; `npm ci` is mandatory |
| Test runner, assertion and in-memory DB | the `devDependencies` of each service's `package.json`, resolved by its lockfile | Jest, Supertest, `mongodb-memory-server` |
| Frontend build and lint toolchain | [`social-media-mini-frontend/package.json`](../../social-media-mini-frontend/package.json) | Vite, ESLint, React |
| MongoDB, Redis, Elasticsearch | the `image:` tags in [`docker-compose.microservices.yml`](../../docker-compose.microservices.yml) | The only place these are pinned |
| MongoDB used by the service suites | `mongodb-memory-server`'s default binary | **Not pinned.** See the gap below |
| CI runner image | `runs-on:` in each workflow | `ubuntu-latest` — a moving target by design |
| GitHub Actions versions | the `uses:` lines in each workflow | Pinned to major tags |
| Docker Engine / Compose plugin | **not pinned anywhere** | See the gap below |
| Browser automation | **not applicable** — none in the repository | |

**Policy `[policy]`:**

- **Pin what affects correctness; let the runner float.** Application and image
  versions are pinned. `ubuntu-latest` is deliberately not, because tracking the
  runner is the maintainer's job, not this repository's.
- **The runtime major version is stated once.** `NODE_VERSION` is the source;
  Dockerfile `FROM` lines must match it, and a mismatch is a defect. This is not
  theoretical — a Node 20/22 mismatch previously broke the upload services at
  startup, fixed by moving every image to Node 22.
- **Lockfiles are part of the change.** A dependency bump without its lockfile
  is incomplete and CI rejects it.
- **No floating version in documentation.** Prose names the file; the file names
  the version.

**Known version-governance gaps `[gap]`:**

1. **No `engines` field in any `package.json`.** Nothing stops an install on the
   wrong Node major; it fails at runtime instead. Adding `engines` is cheap and
   would turn a runtime failure into an install-time one.
2. **Dockerfiles do not use `npm ci`,** so image dependency versions can drift
   from the lockfiles that CI validates.
3. **`mongodb-memory-server`'s MongoDB binary version is unpinned,** so the
   database the suites run against can change without any repository change —
   and it differs from the Compose MongoDB major in any case. Pin it when the
   suites start asserting engine-specific behaviour.
4. **No automated dependency-update or vulnerability surface.** No Dependabot
   configuration exists and no workflow runs `npm audit` (verified).
5. **Docker Engine and Compose plugin versions are unrecorded** for both CI and
   the EC2 host. *Requires verification against the running host* — this
   strategy does not invent a baseline.

---

## 10. Upgrade and compatibility-validation process

Applies to any runtime, image, action or dependency bump. **No upgrade is
performed as a side effect of other work.**

1. **State the change and the reason.** Component, from → to, and why now —
   security fix, required feature, or end of support. "Latest" is not a reason.
2. **Read the release notes for breaking changes,** and check compatibility
   against what depends on it: the Node major against every service and
   `@supabase/supabase-js`; a Jest major against the ESM configuration
   (`--experimental-vm-modules`, `transform: {}`); a Vite or ESLint major
   against the frontend config.
3. **Update the authoritative source, and only it** — the manifest, the
   lockfile, the image tag, or the workflow reference. If the component is
   pinned in two places (Node, in `NODE_VERSION` and the Dockerfiles), update
   both in the same commit and say so.
4. **Run the static checks and the service suites.** ESLint, the security
   script, and all three suites, on the new version.
5. **Run the stack checks where the environment permits** — Compose config, all
   five image builds, and the stack boot with health verification. If the local
   environment cannot (no Docker, for instance), say so explicitly and let CI be
   the first place they run. **Do not describe static inspection as
   execution.**
6. **Review the dependency delta.** Inspect what else moved in the lockfile:
   unexpected transitive changes are the usual source of surprise. Check
   high/critical advisories for anything new.
7. **Record what was validated:** the versions, which checks ran and their
   results, anything that could not be checked, and how to roll back — which for
   a dependency is the previous lockfile, and for an image is the previous tag.
8. **Update documentation only where the change alters supported environments or
   how tests are executed.** A patch bump inside a lockfile needs no prose.

**Rollback `[policy]`.** An upgrade that cannot be reverted by restoring the
previous lockfile or image tag is not an upgrade, it is a migration, and it
needs its own plan.

---

## 11. Flaky, failing, skipped and environment-dependent tests

**Definitions `[policy]`.** A **flaky** test produces different results on the
same commit with no code change — two failures in twenty runs at an unchanged
SHA qualifies. A **failing** test is a signal: either a defect or a bad test,
and both must be resolved, never muted. A **skipped** test is invisible debt.

**Rules:**

- **A red suite is never normalised.** A failing test is fixed, or the test is
  deleted with a reason recorded. "Known failing" is not a state anything stays
  in.
- **Detection is automatic.** A test that fails and then passes at the same SHA
  is flaky by definition; it is surfaced rather than hidden by the green retry.
- **Quarantine is time-boxed.** A confirmed flaky test is tagged within one
  working day, keeps running and reporting, and stops blocking merges. **Hard
  cap: five.** At six, fixing flakiness takes priority over writing new tests.
  Each entry has a named owner and a two-week expiry: fixed, deleted, or
  escalated.
- **Retries must never hide a product defect.** One retry for browser-level
  tests only, where environmental non-determinism is genuine. **Zero retries on
  unit, service and integration tests** — a non-deterministic API test is a bug
  in the test. Every retry is recorded as a flakiness event, so using retries
  makes the metric worse rather than free.
- **`skip` needs a reason and an owner,** written at the skip. An unexplained
  skip is deleted.
- **Design flakiness out before managing it.** Never `sleep`: poll with a bound.
  Await the event rather than guessing a duration. Make time injectable so a TTL
  assertion is not a race.
- **Environment-dependent tests are separated, not disguised.** A test needing
  real Elasticsearch or Redis belongs in a slower tier that is non-blocking on
  pull requests — it does not belong in the fast gate with a longer timeout.
- **Attribute infrastructure failures separately from product failures.**
  Conflating them is how a team learns to ignore red.

Where flakiness will actually come from in this system, and how to design each
one out: [TEST-PLAN.md §25](TEST-PLAN.md#25-flaky-test-strategy).

**One known failing test today `[gap]`.** The untracked
`services/auth-service/verify-cross-service.integration.test.js` fails. It is
deliberately not in git, so CI never runs it; it is recorded in
[TEST-PLAN.md Appendix A](TEST-PLAN.md#appendix-a-repository-inconsistencies-found)
rather than silently tolerated.

---

## 12. Documentation maintenance and source-of-truth rules

**One fact, one home `[policy]`.** A fact that lives in two documents will
disagree with itself. These are the homes:

| Fact | Source of truth |
| --- | --- |
| How to run a test | the `scripts` block of the relevant `package.json` |
| What CI does | [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) |
| Which ports are published | [`docker-compose.microservices.yml`](../../docker-compose.microservices.yml) |
| Dependency and runtime versions | the manifests and lockfiles (§9) |
| Which security assertions exist | [`scripts/ci-security-checks.sh`](../../scripts/ci-security-checks.sh) |
| Required environment variables | [`.env.example`](../../.env.example) and the Compose file |
| Testing policy | **this document** |
| Test inventory, commands, known gaps, history | [TEST-PLAN.md](TEST-PLAN.md) |

**Rules:**

- **Link, do not copy.** Prose points at the authoritative file. A count or a
  version number copied into a document is a future inaccuracy.
- **Where a count must be stated, state how it was measured** and treat it as
  verifiable rather than decorative.
- **This strategy changes when policy changes.** Adding a test does not touch
  it; changing a gate does, and that edit is reviewed like code.
- **The plan changes when the implementation changes.** It is expected to churn.
- **Historical snapshots stay historical.** The numbered `docs/00`–`26` files
  carry banners identifying them as pre-fix snapshots. They are **not** updated
  to match current behaviour — rewriting them would destroy the record. Current
  behaviour belongs in the documents listed above.
- **Resolved issues are marked resolved, with a commit reference,** not deleted.
  The plan keeps the original finding and records the fix.
- **Say "requires verification" rather than guessing.** Anything the repository
  cannot answer is listed as unverified, not filled in. See
  [TEST-PLAN.md Appendix B](TEST-PLAN.md#appendix-b-explicitly-unverified).

---

## 13. References

**Companion document**

- [TEST-PLAN.md](TEST-PLAN.md) — the operational plan: inventory, commands,
  prerequisites, per-service and per-area analysis, CI detail, known defects,
  roadmap, and the historical record.

**Authoritative configuration** — each file is already linked from the table it
governs: version sources in §9, sources of truth in §12. Two workflows are not
named there:

- [`.github/workflows/codeql.yml`](../../.github/workflows/codeql.yml) — SAST
  configuration and schedule
- [`.github/workflows/docker-publish.yml`](../../.github/workflows/docker-publish.yml)
  — image publication

**Related documentation**

- [../../README.md](../../README.md) — prerequisites, running and verifying
- [../ARCHITECTURE.md](../ARCHITECTURE.md) — services, ports, networking
- [../ci.md](../ci.md) — what the pipeline verifies, in prose
- [../SECURITY.md](../SECURITY.md) — secret handling
- [../../services/TEST_README.md](../../services/TEST_README.md) — per-suite
  notes beside the services
