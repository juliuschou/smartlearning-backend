#!/usr/bin/env bash

set -u

PASS=0
FAIL=0
WARN=0

BACKEND_URL="${BACKEND_URL:-http://127.0.0.1:3000}"
EXPECTED_DB="${EXPECTED_DB:-smartlearning_test}"
POSTGRES_CONTAINER="${POSTGRES_CONTAINER:-smart-learning-pg-test}"
REDIS_CONTAINER="${REDIS_CONTAINER:-smartlearning-redis}"

pass() {
  printf "[PASS] %-32s %s\n" "$1" "${2:-}"
  PASS=$((PASS + 1))
}

fail() {
  printf "[FAIL] %-32s %s\n" "$1" "${2:-}"
  FAIL=$((FAIL + 1))
}

warn() {
  printf "[WARN] %-32s %s\n" "$1" "${2:-}"
  WARN=$((WARN + 1))
}

section() {
  echo
  echo "============================================================"
  echo "$1"
  echo "============================================================"
}

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

section "SmartLearning Environment Doctor"

echo "Time       : $(date -Iseconds)"
echo "Directory  : $(pwd)"
echo "Backend    : $BACKEND_URL"
echo "Expected DB: $EXPECTED_DB"

#
# 1. WSL
#
section "1. Platform"

if grep -qi microsoft /proc/version 2>/dev/null; then
  pass "WSL" "$(uname -r)"
else
  warn "WSL" "Not detected"
fi

if command_exists node; then
  pass "Node.js" "$(node --version)"
else
  fail "Node.js" "node command not found"
fi

if command_exists npm; then
  pass "npm" "$(npm --version)"
else
  fail "npm" "npm command not found"
fi

#
# 2. Docker
#
section "2. Docker"

if ! command_exists docker; then
  fail "Docker CLI" "docker command not found"
else
  pass "Docker CLI" "$(docker --version 2>/dev/null)"

  if docker info >/dev/null 2>&1; then
    pass "Docker daemon" "reachable"
  else
    fail "Docker daemon" "not reachable"
  fi
fi

#
# 3. PostgreSQL
#
section "3. PostgreSQL"

if docker inspect "$POSTGRES_CONTAINER" >/dev/null 2>&1; then
  PG_STATE="$(
    docker inspect \
      --format '{{.State.Status}}' \
      "$POSTGRES_CONTAINER" 2>/dev/null
  )"

  if [ "$PG_STATE" = "running" ]; then
    pass "PostgreSQL container" "$POSTGRES_CONTAINER running"
  else
    fail "PostgreSQL container" "$POSTGRES_CONTAINER state=$PG_STATE"
  fi

  DB_NAME="$(
    docker exec "$POSTGRES_CONTAINER" \
      sh -c 'printf "%s" "${POSTGRES_DB:-}"' \
      2>/dev/null || true
  )"

  if [ -n "$DB_NAME" ]; then
    if [ "$DB_NAME" = "$EXPECTED_DB" ]; then
      pass "Database identity" "$DB_NAME"
    else
      fail "Database identity" "expected=$EXPECTED_DB actual=$DB_NAME"
    fi
  else
    warn "Database identity" "POSTGRES_DB unavailable"
  fi

  if docker exec "$POSTGRES_CONTAINER" \
      pg_isready >/dev/null 2>&1; then
    pass "PostgreSQL readiness" "pg_isready PASS"
  else
    fail "PostgreSQL readiness" "pg_isready FAIL"
  fi
else
  fail "PostgreSQL container" "$POSTGRES_CONTAINER not found"
fi

#
# 4. Redis
#
section "4. Redis"

if docker inspect "$REDIS_CONTAINER" >/dev/null 2>&1; then
  REDIS_STATE="$(
    docker inspect \
      --format '{{.State.Status}}' \
      "$REDIS_CONTAINER" 2>/dev/null
  )"

  if [ "$REDIS_STATE" = "running" ]; then
    pass "Redis container" "$REDIS_CONTAINER running"
  else
    fail "Redis container" "$REDIS_CONTAINER state=$REDIS_STATE"
  fi

  REDIS_PING="$(
    docker exec "$REDIS_CONTAINER" \
      redis-cli ping 2>/dev/null || true
  )"

  if [ "$REDIS_PING" = "PONG" ]; then
    pass "Redis PING" "PONG"
  else
    fail "Redis PING" "${REDIS_PING:-no response}"
  fi
else
  warn "Redis container" "$REDIS_CONTAINER not found"
fi

#
# 5. Backend
#
section "5. Backend"

if command_exists curl; then
  LIVE_STATUS="$(
    curl \
      --silent \
      --output /dev/null \
      --write-out '%{http_code}' \
      --max-time 3 \
      "$BACKEND_URL/health/live" 2>/dev/null || true
  )"

  if [ "$LIVE_STATUS" = "200" ]; then
    pass "Backend /health/live" "HTTP 200"
  else
    fail "Backend /health/live" "HTTP ${LIVE_STATUS:-000}"
  fi

  READY_STATUS="$(
    curl \
      --silent \
      --output /dev/null \
      --write-out '%{http_code}' \
      --max-time 3 \
      "$BACKEND_URL/health/ready" 2>/dev/null || true
  )"

  if [ "$READY_STATUS" = "200" ]; then
    pass "Backend /health/ready" "HTTP 200"
  else
    fail "Backend /health/ready" "HTTP ${READY_STATUS:-000}"
  fi
else
  fail "curl" "curl command not found"
fi

#
# 6. Git working environment
#
section "6. Repository"

if command_exists git && git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  SHA="$(git rev-parse --short HEAD 2>/dev/null)"
  pass "Git repository" "commit=$SHA"

  CHANGES="$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')"

  if [ "$CHANGES" = "0" ]; then
    pass "Working tree" "clean"
  else
    warn "Working tree" "$CHANGES changed/untracked entries"
  fi
else
  warn "Git repository" "not detected"
fi

#
# Summary
#
section "RESULT"

echo "PASS : $PASS"
echo "WARN : $WARN"
echo "FAIL : $FAIL"
echo

if [ "$FAIL" -eq 0 ]; then
  echo "ENVIRONMENT READY"
  exit 0
fi

echo "ENVIRONMENT BLOCKED"
exit 1