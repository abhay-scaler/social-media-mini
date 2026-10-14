#!/usr/bin/env bash
#
# Source- and artifact-level security checks run by CI (.github/workflows/ci.yml).
# Runnable locally with no dependencies beyond git, bash, and grep:
#
#   ./scripts/ci-security-checks.sh              # source + secret checks
#   ./scripts/ci-security-checks.sh bundle DIR   # scan a built frontend bundle
#
# Only git-tracked files are inspected, so a clean CI checkout and a local
# working tree are checked identically. Historical bug documentation under docs/
# legitimately quotes the patterns below, so docs/ is excluded from the
# regression checks and scanned only for real credentials.

set -uo pipefail

FAILURES=0

fail() {
  printf '  \033[31mFAIL\033[0m  %s\n' "$1"
  FAILURES=$((FAILURES + 1))
}

pass() {
  printf '  \033[32mok\033[0m    %s\n' "$1"
}

# Tracked files excluding documentation, lockfiles, and this script itself --
# the checks below contain the very patterns they search for, so scanning this
# file would always report a false positive.
SELF_PATH='scripts/ci-security-checks.sh'

code_files() {
  git ls-files -z \
    | tr '\0' '\n' \
    | grep -v '^docs/' \
    | grep -v 'package-lock\.json$' \
    | grep -vxF "$SELF_PATH"
}

# Assert a pattern does NOT appear in executable code/config.
refute_pattern() {
  local label="$1" pattern="$2"
  shift 2
  local hits
  hits=$(code_files | { [ "$#" -gt 0 ] && grep -E "$(IFS='|'; echo "$*")" || cat; } \
    | tr '\n' '\0' | xargs -0 -r grep -nE -- "$pattern" 2>/dev/null)
  if [ -n "$hits" ]; then
    fail "$label"
    printf '%s\n' "$hits" | sed 's/^/          /'
  else
    pass "$label"
  fi
}

# Assert a hardening measure IS still present, so it cannot silently regress.
require_pattern() {
  local label="$1" pattern="$2" file="$3"
  if grep -qE -- "$pattern" "$file" 2>/dev/null; then
    pass "$label"
  else
    fail "$label (expected /$pattern/ in $file)"
  fi
}

# ─── bundle mode ──────────────────────────────────────────────────────────────
if [ "${1:-}" = "bundle" ]; then
  DIR="${2:-}"
  echo "Frontend bundle secret scan: ${DIR}"
  if [ -z "$DIR" ] || [ ! -d "$DIR" ]; then
    echo "  FAIL  bundle directory '${DIR}' does not exist (was the build run?)" >&2
    exit 1
  fi

  # Backend-only values that must never be shipped to a browser.
  for pattern in \
    'SUPABASE_SERVICE_ROLE_KEY' \
    'service_role' \
    'SUPABASE_SERVICE_ROLE' \
    'JWT_SECRET' \
    'INTERNAL_SERVICE_TOKEN' \
    'x-internal-token' \
    'MONGO_URI' \
    'mongodb://' \
    'SUPABASE_URL' \
    'eyJhbGciOi'
  do
    if grep -rqiF -- "$pattern" "$DIR" 2>/dev/null; then
      fail "bundle must not contain: $pattern"
      grep -rliF -- "$pattern" "$DIR" 2>/dev/null | sed 's/^/          /'
    else
      pass "bundle free of: $pattern"
    fi
  done

  echo
  if [ "$FAILURES" -gt 0 ]; then
    echo "Bundle scan FAILED with ${FAILURES} problem(s)." >&2
    exit 1
  fi
  echo "Bundle scan passed."
  exit 0
fi

# ─── source mode ──────────────────────────────────────────────────────────────
echo "== Fixed-bug regression checks (executable code and config only) =="

refute_pattern "base64 image reads are gone (readAsDataURL)"        'readAsDataURL'
refute_pattern "FileReader image path is gone"                      '\bnew FileReader\b'
refute_pattern "local disk upload storage is gone (diskStorage)"     'diskStorage'
refute_pattern "static /uploads serving is gone"                     'express\.static'
refute_pattern "in-memory verify cache is gone"                      'verifyCache\s*=\s*new Map'
refute_pattern "raw bearer token is not a Redis key"                 'verify:\$\{token\}'
refute_pattern "blocking Redis KEYS scan is gone"                    'redisClient\.keys\('
refute_pattern "client-supplied filename is not used for storage"    '\.originalname'
refute_pattern "client-supplied Content-Type is not trusted"         'req\.file\.mimetype'
# Supersedes an earlier check that hunted one specific compromised literal.
# Matching any hardcoded assignment is strictly broader -- it catches that value
# and every other one -- without republishing a known-bad secret in this script.
#
# Test files are excluded deliberately: a suite must set a throwaway
# JWT_SECRET to run at all, and that value never reaches a deployment. The
# check therefore targets shipped code and configuration only.
JWT_LITERALS=$(code_files \
  | grep -vE '\.test\.js$' \
  | tr '\n' '\0' \
  | xargs -0 -r grep -nE 'JWT_SECRET[[:space:]]*[:=][[:space:]]*["'"'"'][^"'"'"'$}]' 2>/dev/null)
if [ -n "$JWT_LITERALS" ]; then
  fail "JWT secret is never a hardcoded literal (outside tests)"
  printf '%s\n' "$JWT_LITERALS" | sed 's/^/          /'
else
  pass "JWT secret is never a hardcoded literal (outside tests)"
fi

echo
echo "== Browser-side Socket.io must use a relative connection =="
SOCKET_HITS=$(grep -rnE 'io\(\s*["'"'"']https?://' social-media-mini-frontend/src 2>/dev/null)
if [ -n "$SOCKET_HITS" ]; then
  fail "frontend must not hardcode a Socket.io host"
  printf '%s\n' "$SOCKET_HITS" | sed 's/^/          /'
else
  pass "frontend Socket.io connections are origin-relative"
fi

echo
echo "== Hardening measures must still be present =="
require_pattern "auth-service hashes the verify cache key" \
  "createHash\('sha256'\)" services/auth-service/server.js
require_pattern "auth-service refuses to start without JWT_SECRET" \
  'process\.env\.JWT_SECRET' services/auth-service/server.js
require_pattern "post-service validates image bytes" \
  'detectImageType' services/post-service/server.js
require_pattern "user-service validates image bytes" \
  'detectImageType' services/user-service/server.js
require_pattern "post-service uses in-memory multer storage" \
  'memoryStorage' services/post-service/server.js
require_pattern "user-service uses in-memory multer storage" \
  'memoryStorage' services/user-service/server.js
require_pattern "post-service uploads cannot overwrite objects" \
  'upsert: false' services/post-service/server.js
require_pattern "user-service uploads cannot overwrite objects" \
  'upsert: false' services/user-service/server.js

# The internal service boundary. /sync-user accepts a whole profile -- _id,
# email and a pre-hashed password -- and runs before the new user has a token,
# so these four assertions are the only thing keeping it off the open internet.
require_pattern "user-service guards /sync-user with the internal token" \
  'app\.post\("/sync-user", requireInternalAuth' services/user-service/server.js
require_pattern "the internal guard compares in constant time" \
  'timingSafeEqual' services/user-service/internalAuth.js
require_pattern "auth-service refuses to start without INTERNAL_SERVICE_TOKEN" \
  'INTERNAL_SERVICE_TOKEN' services/auth-service/server.js
require_pattern "user-service refuses to start without INTERNAL_SERVICE_TOKEN" \
  'INTERNAL_SERVICE_TOKEN' services/user-service/server.js
require_pattern "the gateway strips a client-supplied internal token" \
  'INTERNAL_TOKEN_HEADER' services/api-gateway/server.js
require_pattern "the gateway strips it before any proxy route sees it" \
  'delete req\.headers\[name\]' services/api-gateway/server.js

# http-proxy-middleware v3 moved proxy callbacks under `on`, and
# createProxyMiddleware ignores unrecognised top-level options SILENTLY. The
# gateway shipped `onProxyReq`, so its header removal never ran and a client
# could present a valid internal token to /sync-user. Asserting that the text
# removeHeader(...) was present did NOT catch that -- the dead code was there.
# Assert the registration mechanism instead, in both directions.
require_pattern "the gateway registers proxy callbacks under the v3 on API" \
  '^  on: \{' services/api-gateway/server.js

V3_REMOVED=$(grep -nE '^[[:space:]]*(onProxyReq|onError|onProxyRes|logLevel)[[:space:]]*:' \
  services/api-gateway/server.js 2>/dev/null)
if [ -n "$V3_REMOVED" ]; then
  fail "the gateway uses proxy options removed in v3 (ignored silently, so the callback never runs)"
  printf '%s\n' "$V3_REMOVED" | sed 's/^/          /'
else
  pass "the gateway uses no proxy options removed in v3"
fi

# Regression lock: the guard compared STRING length before calling
# timingSafeEqual, which throws a RangeError unless the BYTE lengths match. A
# multibyte header could therefore turn an unauthenticated request into a 500
# with a stack trace. Comparing the buffers' own lengths is what fixed it, so
# assert the buffers are what gets measured.
require_pattern "the internal guard compares byte length, not string length" \
  'a\.length !== b\.length' services/user-service/internalAuth.js

echo
echo "== Committed secrets =="

# .env must never be tracked; only the example template may be.
TRACKED_ENV=$(git ls-files | grep -E '(^|/)\.env($|\.)' | grep -v '^\.env\.example$')
if [ -n "$TRACKED_ENV" ]; then
  fail "environment files must not be tracked"
  printf '%s\n' "$TRACKED_ENV" | sed 's/^/          /'
else
  pass ".env is not tracked (only .env.example)"
fi

# .env must be covered by .gitignore.
if git check-ignore -q .env 2>/dev/null; then
  pass ".env is covered by .gitignore"
else
  fail ".env is not covered by .gitignore"
fi

# Credential-shaped literal assignments, excluding obvious placeholders and
# test fixtures. Supabase/JWT values must come from the environment.
SECRET_HITS=$(code_files | tr '\n' '\0' | xargs -0 -r grep -nE \
  "(SERVICE_ROLE_KEY|JWT_SECRET|API_KEY|api_key|SECRET_KEY)\s*[:=]\s*['\"][A-Za-z0-9_@!.+/-]{12,}['\"]" \
  2>/dev/null | grep -viE "your-|change-me|example|placeholder|dummy|testsecret|test-secret|ci-|process\.env")
if [ -n "$SECRET_HITS" ]; then
  fail "hardcoded credential-shaped literals found"
  printf '%s\n' "$SECRET_HITS" | sed 's/^/          /'
else
  pass "no hardcoded credential literals in code or config"
fi

# A real Supabase service-role key is a JWT; placeholders are not.
JWT_LITERAL=$(code_files | tr '\n' '\0' | xargs -0 -r grep -nE 'eyJhbGciOi[A-Za-z0-9_-]{10,}' 2>/dev/null)
if [ -n "$JWT_LITERAL" ]; then
  fail "JWT-shaped literal found (possible leaked key)"
  printf '%s\n' "$JWT_LITERAL" | sed 's/^/          /'
else
  pass "no JWT-shaped literals in code or config"
fi

echo
if [ "$FAILURES" -gt 0 ]; then
  echo "Security checks FAILED with ${FAILURES} problem(s)." >&2
  exit 1
fi
echo "All security checks passed."
