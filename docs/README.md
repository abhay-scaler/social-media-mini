# Documentation Index

Reference documentation for the microservice stack. Start with the
[project README](../README.md) for architecture, setup, and testing; the
documents here go deeper on individual concerns.

## Current documentation

| Document | Contents |
| --- | --- |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Services, ports, networking, proxying, startup ordering, volumes, Supabase |
| [DEPLOYMENT.md](DEPLOYMENT.md) | Deploying to a production VM: ports, HTTPS, backups, troubleshooting |
| [AWS-EC2-DEPLOYMENT.md](AWS-EC2-DEPLOYMENT.md) | Single-instance EC2 runbook, including sizing, security groups, and backup/restore |
| [SECURITY.md](SECURITY.md) | Secret handling, what must never be exposed, production hardening |
| [supabase-setup.md](supabase-setup.md) | Storage bucket setup and the base64 image migration |
| [ci.md](ci.md) | What the GitHub Actions pipeline verifies |
| [tests/TEST-STRATEGY.md](tests/TEST-STRATEGY.md) | Testing policy: levels, ownership, quality gates, coverage, version governance |
| [tests/TEST-PLAN.md](tests/TEST-PLAN.md) | Operational test plan: inventory, commands, per-service analysis, known gaps |

## Where to start

**Understanding the system.** [ARCHITECTURE.md](ARCHITECTURE.md) explains the
request path, how Nginx proxies `/api/` to the gateway and `/socket.io/`
directly to post-service, and why only one port is published. The
[project README](../README.md) covers the same ground more briefly.

**Running or deploying it.** The [project README](../README.md) for local
Docker Compose; [AWS-EC2-DEPLOYMENT.md](AWS-EC2-DEPLOYMENT.md) for a real
instance. Read [SECURITY.md](SECURITY.md) first if the deployment will face the
internet — the committed Compose file carries development values.

**Testing and quality.** [tests/TEST-STRATEGY.md](tests/TEST-STRATEGY.md) is
the policy: what is tested, what the quality gates are, and how coverage should
be read. [tests/TEST-PLAN.md](tests/TEST-PLAN.md) is the operational detail,
including an honest account of where the suite is weak — most importantly that
the three service suites exercise replica applications rather than the shipped
`server.js`.

**Service responsibilities.** [MICROSERVICES.md](../MICROSERVICES.md) at the
repository root covers inter-service communication and health monitoring.
