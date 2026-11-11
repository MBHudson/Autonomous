#!/usr/bin/env bash
#
# Copyright 2026 M. Bryce Hudson
# SPDX-License-Identifier: Apache-2.0
#
# ============================================
# CHECK-GUARDS.SH -- prove the serving rules refuse what they promise
# ============================================
#
# The README says storage/, the test tree and dotfiles are never served, and
# that no cross-origin header comes back. Those are claims about a deployment,
# so this makes the requests a stranger would and fails when one of them
# answers. Every check here is a REFUSAL: a 200 is the bug.
#
# Usage:
#   ./tools/check-guards.sh                          # boots serve.php on a free port
#   ./tools/check-guards.sh https://host/router      # checks a running copy
#   ./tools/check-guards.sh --token ABC https://host/router
#
#   --serve     start a throwaway `php -S` copy of this tree and check that
#   --token T   send X-Router-Token: T, and require the API to answer 200
#
# Exit codes: 0 every path refused, 1 something answered, 2 usage/setup problem.
#
# No dependencies beyond bash, curl and (for --serve) php. It writes nothing
# except a log in the temp directory, and it kills only the server it started.

set -u

ROOT=$(cd "$(dirname "$0")/.." && pwd)
BASE=""
TOKEN=""
SERVE=0
SRV=""
LOG="${TMPDIR:-/tmp}/check-guards.$$.log"

usage() {
    sed -n '15,34p' "$0" | sed 's/^# \{0,1\}//'
}

cleanup() {
    if [ -n "$SRV" ]; then
        kill "$SRV" 2>/dev/null
        wait "$SRV" 2>/dev/null
    fi
}
trap cleanup EXIT INT TERM

while [ $# -gt 0 ]; do
    case "$1" in
        --serve)  SERVE=1; shift ;;
        --token)  TOKEN="${2:-}"; shift 2 ;;
        -h|--help) usage; exit 0 ;;
        http://*|https://*) BASE="$1"; shift ;;
        *)
            echo "check-guards: unknown argument: $1" >&2
            exit 2
            ;;
    esac
done

if [ -z "$BASE" ]; then
    SERVE=1
fi

if [ "$SERVE" = 1 ] && [ -z "$BASE" ]; then
    command -v php >/dev/null 2>&1 || { echo "check-guards: php not found" >&2; exit 2; }
    PORT=$(( 8300 + ($$ % 400) ))
    # exec so the recorded pid is php itself, not a wrapper shell.
    ( cd "$ROOT" && exec php -S "127.0.0.1:$PORT" serve.php ) >"$LOG" 2>&1 &
    SRV=$!
    BASE="http://127.0.0.1:$PORT"
    up=0
    for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
        code=$(curl -s -o /dev/null -m 1 -w '%{http_code}' "$BASE/api/state" 2>/dev/null)
        if [ "$code" != "000" ]; then up=1; break; fi
        sleep 0.25
    done
    if [ "$up" != 1 ]; then
        echo "check-guards: serve.php did not answer on $BASE" >&2
        sed -n '1,20p' "$LOG" >&2 2>/dev/null
        exit 2
    fi
    echo "check-guards: checking this tree at $BASE"
else
    echo "check-guards: checking $BASE"
fi

fail=0
pass=0

# --- the four paths that decide everything else -----------------------------
for p in storage/config.json storage/sessions tests/js/run.mjs .git/config; do
    code=$(curl -s -o /dev/null -m 10 -w '%{http_code}' "$BASE/$p" 2>/dev/null)
    case "$code" in
        403|404)
            printf 'refused  %-26s %s\n' "$p" "$code"
            pass=$((pass + 1))
            ;;
        *)
            printf 'OPEN     %-26s %s\n' "$p" "${code:-no answer}"
            fail=$((fail + 1))
            ;;
    esac
done

# --- no cross-origin header for a foreign origin ----------------------------
if curl -s -D - -o /dev/null -m 10 -H 'Origin: https://evil.example' "$BASE/api/state" 2>/dev/null \
     | grep -qi '^access-control-allow-origin'; then
    echo "OPEN     cross-origin request      an Access-Control-Allow-Origin came back"
    fail=$((fail + 1))
else
    echo "refused  cross-origin request      no Access-Control-Allow-Origin"
    pass=$((pass + 1))
fi

# --- the API, graded only when a token was supplied -------------------------
if [ -n "$TOKEN" ]; then
    code=$(curl -s -o /dev/null -m 10 -w '%{http_code}' -H "X-Router-Token: $TOKEN" "$BASE/api/sessions" 2>/dev/null)
    if [ "$code" = "200" ]; then
        echo "ok       authenticated API         200"
        pass=$((pass + 1))
    else
        echo "FAIL     authenticated API         $code (wanted 200)"
        fail=$((fail + 1))
    fi
else
    code=$(curl -s -o /dev/null -m 10 -w '%{http_code}' "$BASE/api/sessions" 2>/dev/null)
    case "$code" in
        401)  note="a token is set; the request carried none" ;;
        403)  note="no token set; this caller is not on this machine" ;;
        503)  note="no token set at all yet (fresh copy)" ;;
        200)  note="no token set and the caller is on this machine (local-only mode) -- or this is not this app" ;;
        *)    note="unexpected" ;;
    esac
    printf 'info     %-26s %s -- %s\n' "api/sessions" "$code" "$note"
fi

echo
if [ "$fail" -eq 0 ]; then
    echo "All $pass refusals held. storage, tests, dotfiles and CORS are closed."
    exit 0
fi
echo "$fail of $((pass + fail)) checks did NOT hold -- fix that before anything else."
exit 1
