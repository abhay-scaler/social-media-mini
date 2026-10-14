# Backend service tests

The three service test suites live beside the services they cover:

```
services/auth-service/auth.test.js
services/user-service/user.test.js        services/user-service/imageType.test.js
services/post-service/post.test.js        services/post-service/imageType.test.js
```

`services/api-gateway` has no suite and no `test` script.

**The canonical test documentation is
[`../docs/tests/TEST-PLAN.md`](../docs/tests/TEST-PLAN.md)** — §0 covers what
each suite contains and its measured result, the prerequisites, the exact
commands, coverage reporting, what CI runs, and troubleshooting. §4 is the
per-service analysis. The testing policy is
[`../docs/tests/TEST-STRATEGY.md`](../docs/tests/TEST-STRATEGY.md).

This file is deliberately a pointer: the inventory used to be maintained here
*and* in the plan, and the two had already drifted.

## Running one service's suite

```bash
cd services/auth-service    # or user-service, post-service
npm ci
npm test
```

Use `npm ci`, not `npm install` — CI asserts the lockfile is unchanged
afterwards, so an install that rewrites it fails the build. No database or
Docker is needed; `mongodb-memory-server` supplies MongoDB in-process.
`npm run test:watch` and `npm run test:coverage` are also defined.

## Before you trust a green run

> The three service suites (`auth.test.js`, `user.test.js`, `post.test.js`)
> **build a replica Express app inside the test file** rather than importing the
> service's own `server.js`, so they do not exercise shipped code. The
> `imageType.test.js` pair is the exception. This is a known, open gap — the
> evidence and the fix are in
> [TEST-PLAN.md §30 C1](../docs/tests/TEST-PLAN.md#critical), and the principle
> it breaks is P1 in
> [TEST-STRATEGY.md §2](../docs/tests/TEST-STRATEGY.md#2-testing-principles-and-risk-based-priorities).

A consequence worth knowing before you debug a failure: because the suites
assert against replicas, a green run does **not** mean the corresponding
behaviour exists in production. `auth.test.js` passes an email-format test
against a regex that exists only in the test file.

## auth-service: one expected local failure

`services/auth-service` also contains `verify-cross-service.integration.test.js`,
which is **deliberately untracked**. Jest picks it up because it matches the
default test pattern, and it fails — so `npm test` in that directory exits
non-zero even though `auth.test.js` passes 18/18. CI never sees it.

To scope a run to the tracked suite:

```bash
cd services/auth-service && npx jest auth.test.js
```

Why it fails, and why it is left in place:
[TEST-PLAN.md Appendix A](../docs/tests/TEST-PLAN.md#appendix-a-repository-inconsistencies-found),
item 6.
