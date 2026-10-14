#!/usr/bin/env bash
#
# End-to-end verification of the registration saga against a RUNNING stack.
#
#   docker compose -f docker-compose.microservices.yml up -d --wait
#   INTERNAL_SERVICE_TOKEN=<the value the stack was started with> \
#     ./scripts/e2e-registration.sh
#
# Why this exists: the stack-integration job proves every container starts and
# reports healthy, which is not the same as proving registration works. The
# saga spans two services and two databases -- auth-service writes the
# credential record, then calls user-service over an internal, token-
# authenticated endpoint, and rolls the credential record back if that call
# fails. None of that is exercised by a health endpoint.
#
# Everything a browser would do goes through http://localhost (nginx), the only
# published port, so the request path under test is the real one:
#   nginx -> api-gateway -> auth-service -> user-service
#
# The internal-endpoint checks are issued from inside the Docker network
# instead, because that is the only place /sync-user is legitimately reachable.
#
# Requires: a running stack, curl, python3, and docker compose.
# Prints no token value, so it is safe to run in CI with a masked secret.

set -uo pipefail

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.microservices.yml}"
BASE_URL="${BASE_URL:-http://localhost}"
COMPOSE=(docker compose -f "$COMPOSE_FILE")

FAILURES=0
CHECKS=0

fail() {
  printf '  \033[31mFAIL\033[0m  %s\n' "$1"
  [ "$#" -gt 1 ] && printf '%s\n' "$2" | sed 's/^/          /'
  FAILURES=$((FAILURES + 1))
  CHECKS=$((CHECKS + 1))
}

pass() {
  printf '  \033[32mok\033[0m    %s\n' "$1"
  CHECKS=$((CHECKS + 1))
}

section() { printf '\n\033[1m%s\033[0m\n' "$1"; }

die() {
  printf '\n\033[31maborted:\033[0m %s\n' "$1" >&2
  printf 'Later checks depend on this step, so the run cannot continue.\n' >&2
  exit 1
}

if [ -z "${INTERNAL_SERVICE_TOKEN:-}" ]; then
  die "INTERNAL_SERVICE_TOKEN is not set. It must match the value the stack was started with."
fi

for tool in curl python3 docker; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool is required but not installed."
done

TMPDIR_E2E="$(mktemp -d)"
USER_SERVICE_STOPPED=0

cleanup() {
  # The rollback check deliberately stops user-service. Restart it on any exit
  # path so a failure here cannot leave the stack degraded for later steps.
  if [ "$USER_SERVICE_STOPPED" = "1" ]; then
    printf '\nrestoring user-service after the rollback check...\n'
    "${COMPOSE[@]}" start user-service >/dev/null 2>&1 || true
  fi
  rm -rf "$TMPDIR_E2E"
}
trap cleanup EXIT

BODY_FILE="$TMPDIR_E2E/body"
STATUS=""
BODY=""

# request METHOD PATH BODY_OR_EMPTY [HEADER...]
# Sets STATUS and BODY. A connection failure becomes status 000 rather than an
# abort, so a check can assert on it.
request() {
  local method="$1" path="$2" payload="$3"
  shift 3
  local args=(-sS --max-time "${HTTP_TIMEOUT:-30}" -X "$method" -o "$BODY_FILE" -w '%{http_code}')
  if [ -n "$payload" ]; then
    args+=(-H 'content-type: application/json' --data-binary "$payload")
  fi
  local header
  for header in "$@"; do
    args+=(-H "$header")
  done
  STATUS="$(curl "${args[@]}" "$BASE_URL$path" 2>/dev/null)" || STATUS="000"
  BODY="$(cat "$BODY_FILE" 2>/dev/null)"
}

# Read a dotted key out of BODY. Missing or non-JSON yields an empty string.
jfield() {
  printf '%s' "$BODY" | python3 -c '
import json, sys
try:
    doc = json.load(sys.stdin)
except Exception:
    sys.exit(0)
value = doc
for part in sys.argv[1].split("."):
    value = value.get(part) if isinstance(value, dict) else None
print("" if value is None else value)
' "$1"
}

expect_status() {
  local label="$1" want="$2"
  if [ "$STATUS" = "$want" ]; then
    pass "$label (HTTP $STATUS)"
    return 0
  fi
  fail "$label -- expected HTTP $want, got $STATUS" "$BODY"
  return 1
}

expect_field() {
  local label="$1" key="$2" want="$3" got
  got="$(jfield "$key")"
  if [ "$got" = "$want" ]; then
    pass "$label"
    return 0
  fi
  fail "$label -- expected $key='$want', got '$got'" "$BODY"
  return 1
}

# POST to user-service's /sync-user from INSIDE the Docker network, bypassing
# the gateway, and echo the status code. Node is already present in the gateway
# image; BusyBox wget cannot set an arbitrary header and report a status.
#
# The token is passed through the environment, never on a command line, so it
# does not appear in the container's process list. E2E_TOKEN unset means "send
# no x-internal-token header at all".
internal_sync() {
  local token="$1" payload="$2"
  "${COMPOSE[@]}" exec -T -e "E2E_TOKEN=$token" -e "E2E_SEND=$3" -e "E2E_BODY=$payload" \
    api-gateway node -e '
      (async () => {
        const headers = { "content-type": "application/json" };
        if (process.env.E2E_SEND === "1") {
          headers["x-internal-token"] = process.env.E2E_TOKEN;
        }
        const res = await fetch("http://user-service:3002/sync-user", {
          method: "POST",
          headers,
          body: process.env.E2E_BODY,
        });
        process.stdout.write(String(res.status));
      })().catch((err) => process.stdout.write("ERR:" + err.message));
    ' 2>/dev/null | tr -d '\r'
}

expect_internal_status() {
  local label="$1" want="$2" got="$3"
  if [ "$got" = "$want" ]; then
    pass "$label (HTTP $got)"
  else
    fail "$label -- expected HTTP $want from /sync-user, got '$got'"
  fi
}

user_service_responding() {
  "${COMPOSE[@]}" exec -T api-gateway \
    wget -q -O - http://user-service:3002/health >/dev/null 2>&1
}

wait_for_user_service() {
  local attempt
  for attempt in $(seq 1 60); do
    if user_service_responding; then
      return 0
    fi
    sleep 2
  done
  return 1
}

oid() { openssl rand -hex 12; }

RUN_ID="$(date +%s)-$$"
EMAIL="e2e-${RUN_ID}@example.test"
PASSWORD="E2e-$(openssl rand -hex 12)"
FIRST_NAME="Saga"
LAST_NAME="Verification"

payload_for() {
  python3 -c '
import json, sys
print(json.dumps({
    "firstName": sys.argv[1],
    "lastName": sys.argv[2],
    "email": sys.argv[3],
    "password": sys.argv[4],
}))
' "$FIRST_NAME" "$LAST_NAME" "$1" "$PASSWORD"
}

printf 'Registration saga end-to-end checks\n'
printf '  stack:    %s\n' "$COMPOSE_FILE"
printf '  base URL: %s  (nginx, the only published port)\n' "$BASE_URL"
printf '  test user: %s\n' "$EMAIL"

# ---------------------------------------------------------------------------
section '1. Registration through the real request path'
# ---------------------------------------------------------------------------

request POST /api/auth/register "$(payload_for "$EMAIL")"
expect_status 'POST /api/auth/register is accepted' 201 \
  || die 'registration did not succeed, so nothing downstream can be verified'
expect_field 'registration reports success' message 'User registered successfully'

USER_ID="$(jfield userId)"
if printf '%s' "$USER_ID" | grep -qE '^[0-9a-f]{24}$'; then
  pass "registration returns the new user id ($USER_ID)"
else
  fail "registration did not return a valid user id -- got '$USER_ID'" "$BODY"
  die 'no user id to verify the profile against'
fi

# A 201 is only reachable after the sync to user-service succeeded: the handler
# returns 503 if all three attempts fail. So the status code alone establishes
# that auth-service called user-service and was authorised. The next section
# confirms the resulting record independently.

# ---------------------------------------------------------------------------
section '2. The user profile exists in user-service'
# ---------------------------------------------------------------------------

request POST /api/auth/login \
  "$(python3 -c 'import json,sys; print(json.dumps({"email": sys.argv[1], "password": sys.argv[2]}))' "$EMAIL" "$PASSWORD")"
expect_status 'POST /api/auth/login is accepted' 200 \
  || die 'cannot obtain a token, so the profile cannot be read back'
expect_field 'login returns the same user id' user.id "$USER_ID"

TOKEN="$(jfield token)"
[ -n "$TOKEN" ] || die 'login returned no token'
pass 'login returns a token'

# GET /me and GET /:userId both read user-service's own MongoDB through its own
# model. The record is only there if /sync-user ran, so these are a direct
# observation of the saga's second leg rather than an inference from the 201.
request GET /api/users/me '' "authorization: Bearer $TOKEN"
expect_status 'GET /api/users/me returns the synced profile' 200
expect_field 'the profile carries the id auth-service issued' _id "$USER_ID"
expect_field 'the profile carries the registered email' email "$EMAIL"
expect_field 'the profile carries the registered first name' firstName "$FIRST_NAME"
expect_field 'the profile carries the registered last name' lastName "$LAST_NAME"

if [ -z "$(jfield password)" ]; then
  pass 'the profile response does not expose the password hash'
else
  fail 'the profile response exposed a password field'
fi

# /:userId has no cache layer in front of it, so this cannot be served from
# Redis -- it is necessarily a read from user-service's database.
request GET "/api/users/$USER_ID" '' "authorization: Bearer $TOKEN"
expect_status 'GET /api/users/:userId returns the synced profile' 200
expect_field 'the uncached read returns the same email' email "$EMAIL"

# ---------------------------------------------------------------------------
section '3. /sync-user is unreachable from a client'
# ---------------------------------------------------------------------------

FORGED_ID="$(oid)"
FORGED_PAYLOAD="$(python3 -c '
import json, sys
print(json.dumps({
    "_id": sys.argv[1],
    "firstName": "Forged",
    "lastName": "Profile",
    "email": sys.argv[2],
    "password": "$2b$10$forgedhashforgedhashforgedhashforgedhashforgedhashfor",
    "createdAt": "2020-01-01T00:00:00.000Z",
}))
' "$FORGED_ID" "forged-${RUN_ID}@example.test")"

# The gateway strips x-internal-token from every proxied request, so even the
# correct secret must not get a client into /sync-user.
request POST /api/users/sync-user "$FORGED_PAYLOAD" \
  "x-internal-token: $INTERNAL_SERVICE_TOKEN"
expect_status 'the gateway strips a client-supplied internal token, even a valid one' 401

request POST /api/users/sync-user "$FORGED_PAYLOAD"
expect_status 'POST /api/users/sync-user without a token is rejected' 401

request GET "/api/users/$FORGED_ID" '' "authorization: Bearer $TOKEN"
expect_status 'the forged profile was never created' 404

# ---------------------------------------------------------------------------
section '4. The internal guard, exercised inside the network'
# ---------------------------------------------------------------------------

# Derived from the real token so the lengths match regardless of how long the
# configured secret is. Never printed.
SAME_LENGTH_WRONG="${INTERNAL_SERVICE_TOKEN%?}$(
  if [ "${INTERNAL_SERVICE_TOKEN: -1}" = "a" ]; then printf 'b'; else printf 'a'; fi
)"
MULTIBYTE_WRONG="${INTERNAL_SERVICE_TOKEN%?}é"

NEG_PAYLOAD="$(python3 -c '
import json, sys
print(json.dumps({
    "_id": sys.argv[1],
    "firstName": "Internal",
    "lastName": "Negative",
    "email": sys.argv[2],
    "password": "$2b$10$negativehashnegativehashnegativehashnegativehashnegat",
    "createdAt": "2020-01-01T00:00:00.000Z",
}))
' "$(oid)" "internal-neg-${RUN_ID}@example.test")"

expect_internal_status 'no x-internal-token header is rejected' 401 \
  "$(internal_sync '' "$NEG_PAYLOAD" 0)"
expect_internal_status 'an empty x-internal-token is rejected' 401 \
  "$(internal_sync '' "$NEG_PAYLOAD" 1)"
expect_internal_status 'a wrong token of the same length is rejected' 401 \
  "$(internal_sync "$SAME_LENGTH_WRONG" "$NEG_PAYLOAD" 1)"
expect_internal_status 'a wrong token of a different length is rejected' 401 \
  "$(internal_sync 'let-me-in' "$NEG_PAYLOAD" 1)"

# Regression: comparing string length rather than byte length let a multibyte
# header reach crypto.timingSafeEqual with mismatched buffers, which throws a
# RangeError -- a 500 with a stack trace on an unauthenticated path. This must
# be a clean 401.
MULTIBYTE_STATUS="$(internal_sync "$MULTIBYTE_WRONG" "$NEG_PAYLOAD" 1)"
expect_internal_status 'a multibyte token of the same character length is rejected' 401 \
  "$MULTIBYTE_STATUS"
if [ "$MULTIBYTE_STATUS" = "500" ]; then
  fail 'the multibyte token crashed the guard into a 500 (byte-length regression)'
else
  pass 'the multibyte token did not crash the guard'
fi

# Positive control: the guard is gating on the secret, not refusing everything.
POS_ID="$(oid)"
POS_PAYLOAD="$(python3 -c '
import json, sys
print(json.dumps({
    "_id": sys.argv[1],
    "firstName": "Internal",
    "lastName": "Positive",
    "email": sys.argv[2],
    "password": "$2b$10$positivehashpositivehashpositivehashpositivehashposi",
    "createdAt": "2020-01-01T00:00:00.000Z",
}))
' "$POS_ID" "internal-pos-${RUN_ID}@example.test")"

expect_internal_status 'the correct token is accepted' 201 \
  "$(internal_sync "$INTERNAL_SERVICE_TOKEN" "$POS_PAYLOAD" 1)"

request GET "/api/users/$POS_ID" '' "authorization: Bearer $TOKEN"
expect_status 'a profile written through the internal endpoint is readable' 200

# ---------------------------------------------------------------------------
section '5. The saga rolls back when user-service is unavailable'
# ---------------------------------------------------------------------------

ROLLBACK_EMAIL="rollback-${RUN_ID}@example.test"

printf '  stopping user-service to force the sync to fail...\n'
if "${COMPOSE[@]}" stop user-service >/dev/null 2>&1; then
  USER_SERVICE_STOPPED=1
else
  fail 'could not stop user-service, so the rollback path cannot be exercised'
fi

if [ "$USER_SERVICE_STOPPED" = "1" ]; then
  if user_service_responding; then
    fail 'user-service still answers after being stopped; the rollback check would be meaningless'
  else
    pass 'user-service is unreachable'

    # Three attempts with linear backoff, so allow well over the ~3s that takes.
    HTTP_TIMEOUT=90 request POST /api/auth/register "$(payload_for "$ROLLBACK_EMAIL")"
    expect_status 'registration fails closed with 503 when the profile service is down' 503
    expect_field 'the 503 names the unavailable dependency' message \
      'Registration failed: user profile service unavailable. Please try again.'

    # The credential record must have been deleted, or the email would be
    # claimed by a user who has no profile and can never get one.
    request POST /api/auth/login \
      "$(python3 -c 'import json,sys; print(json.dumps({"email": sys.argv[1], "password": sys.argv[2]}))' "$ROLLBACK_EMAIL" "$PASSWORD")"
    expect_status 'the rolled-back credentials do not authenticate' 401

    printf '  restarting user-service...\n'
    if "${COMPOSE[@]}" start user-service >/dev/null 2>&1 && wait_for_user_service; then
      USER_SERVICE_STOPPED=0
      pass 'user-service is healthy again'

      # The strongest statement of a clean rollback: the address is free.
      request POST /api/auth/register "$(payload_for "$ROLLBACK_EMAIL")"
      expect_status 'the rolled-back email can register again' 201
      ROLLBACK_USER_ID="$(jfield userId)"

      request POST /api/auth/login \
        "$(python3 -c 'import json,sys; print(json.dumps({"email": sys.argv[1], "password": sys.argv[2]}))' "$ROLLBACK_EMAIL" "$PASSWORD")"
      expect_status 'the re-registered user can log in' 200
      RETRY_TOKEN="$(jfield token)"

      if [ -n "$RETRY_TOKEN" ] && [ -n "$ROLLBACK_USER_ID" ]; then
        request GET /api/users/me '' "authorization: Bearer $RETRY_TOKEN"
        expect_status 'the re-registered user has a profile' 200
        expect_field 'the retried registration synced the right id' _id "$ROLLBACK_USER_ID"
      else
        fail 'could not verify the re-registered profile (missing token or id)'
      fi
    else
      fail 'user-service did not become healthy again after restart'
    fi
  fi
fi

# ---------------------------------------------------------------------------
printf '\n'
if [ "$FAILURES" -eq 0 ]; then
  printf '\033[32mAll %d registration checks passed.\033[0m\n' "$CHECKS"
  exit 0
fi
printf '\033[31m%d of %d registration checks failed.\033[0m\n' "$FAILURES" "$CHECKS"
exit 1
