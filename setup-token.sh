#!/usr/bin/env bash
# Copyright M. Bryce Hudson 2026-2029 All Rights Reserved
#
# Unauthorized reproduction, distribution, or transmission of the work is prohibited without prior written permission, with exceptions for brief quotations and specific noncommercial uses under copyright law.
#
# BryceFromIndiana@gmail.com

# Generate an access token for this copy and turn the API gate on.
#
# The API requires a token on EVERY endpoint once require_token is true, so
# this has to be done from a shell rather than from the UI -- otherwise the
# first thing you would do is lock yourself out of the screen you would use to
# fix it.
#
#   ./setup-token.sh              generate and enable
#   ./setup-token.sh --show       print the current token, change nothing
#   ./setup-token.sh --off        disable the gate entirely
#   ./setup-token.sh --force      replace an existing token
#
# Afterwards, paste the token into Config -> Access token in the web UI. It is
# saved the moment you paste it (no SAVE press needed), because SAVE is itself
# an API call that would fail without a valid token.
#
# This used to require python3, which is the one tool that is NOT guaranteed
# here: on Windows `python3` is usually the Microsoft Store's execution alias, a
# stub that prints "Python was not found; run without arguments to install from
# the Microsoft Store" and exits -- so `--show`, the command you run precisely
# when you are locked out, printed the heading and nothing else. PHP is not
# optional on a copy of this app, so it is the fallback, and neither engine is
# trusted: each is probed, and the one that answers is used.
#
# On Windows start.bat -Token does the same job with no interpreter at all.

set -euo pipefail
cd "$(dirname "$0")"

# storage/ must never be served over the web: it holds the access token,
# provider keys, every session transcript and the exec allow/deny lists.
# Apache denies it with this file (which ships in the repo) -- but a copy, a
# moved folder or a stray `git clean` can lose it, and nginx ignores .htaccess
# entirely. Re-create the Apache guard here so the operator cannot expose the
# folder by accident, and print the nginx equivalent for non-Apache hosts.
ensure_storage_guard() {
  [ -d storage ] || return 0
  if [ ! -f storage/.htaccess ]; then
    cat > storage/.htaccess <<'HTACCESS'
# Deny ALL web access to storage/. Ships with the app; do not delete.
<IfModule mod_authz_core.c>
    Require all denied
</IfModule>
<IfModule !mod_authz_core.c>
    Order allow,deny
    Deny from all
</IfModule>
HTACCESS
    echo "Re-created storage/.htaccess (denies web access to storage/)." >&2
  fi
}
ensure_storage_guard

CONFIG="storage/config.json"

if [ ! -f "$CONFIG" ]; then
  echo "No $CONFIG here. Run this from the copy's own directory, not the source." >&2
  exit 1
fi

# ---------------------------------------------------------------------
# Is this Windows (Git Bash / MSYS / Cygwin)?
# ---------------------------------------------------------------------
# Only used to say the right thing in a failure message: there is no sudo and
# no www-data here, so the POSIX advice would send someone down a blind alley.
case "$(uname -s 2>/dev/null || echo unknown)" in
  MINGW*|MSYS*|CYGWIN*) WIN=yes ;;
  *) WIN=no ;;
esac

# ---------------------------------------------------------------------
# Which interpreter can read and write the config
# ---------------------------------------------------------------------
# A name on PATH is not an interpreter. `python3` on Windows is often the
# Microsoft Store stub, which answers with a paragraph of English and exits, so
# each candidate has to PROVE itself by returning "1" from a one-line program.
# `python` is tried as well as `python3`: on the same machine that has a stub
# for one name, the other is frequently a real install.
PY=""
for candidate in python3 python; do
  if command -v "$candidate" >/dev/null 2>&1; then
    if [ "$("$candidate" -c 'print(1)' 2>/dev/null || true)" = "1" ]; then
      PY="$candidate"
      break
    fi
  fi
done

# PHP_BIN can be set by hand for a PHP that is not on PATH, which is the usual
# state of affairs on Windows (the app's own php lives inside XAMPP).
#
# Probed only when it can actually be used: every read and write below picks
# python when python proved itself, so looking for php then is a process start
# spent proving an interpreter that will not be called -- ~150ms, on each run,
# for nothing. (Measured, and worth being exact about: this saves nothing in the
# case where python is BROKEN, because then php is the engine that gets used and
# it has to be found. Both cases are covered -- the tests drive the script 16
# times with a failing python3/python planted ahead of the real ones, and twice
# on this machine's own PATH where a real python answers.) An explicit PHP_BIN is
# still checked here and a bad one is still a hard error, because that is an
# operator's claim about their own host rather than a guess at what a name means.
PHP_BIN="${PHP_BIN:-}"
if [ -n "$PHP_BIN" ]; then
  if [ "$("$PHP_BIN" -r 'echo 1;' 2>/dev/null || true)" != "1" ]; then
    echo "PHP_BIN=$PHP_BIN did not answer, so it is not a working php." >&2
    exit 1
  fi
elif [ -z "$PY" ]; then
  for candidate in php /c/xampp/php/php.exe /usr/bin/php /usr/local/bin/php; do
    if command -v "$candidate" >/dev/null 2>&1; then
      if [ "$("$candidate" -r 'echo 1;' 2>/dev/null || true)" = "1" ]; then
        PHP_BIN="$candidate"
        break
      fi
    fi
  done
fi

if [ -z "$PY" ] && [ -z "$PHP_BIN" ]; then
  cat >&2 <<'MSG'
Cannot read storage/config.json: this needs python3 or php, and neither answered.

  php is the one that is not optional on a copy of this app -- if the web UI is
  running, PHP exists somewhere. Either put it on PATH, or point this script at
  it:

      PHP_BIN=/path/to/php ./setup-token.sh --show

  On Windows, `start.bat -Token` prints the same token with no interpreter.
MSG
  exit 1
fi

# Which engine was picked, said only when it was NOT the expected one: a
# fallback is the interesting case, and naming it turns "why did this behave
# differently" into a fact instead of a guess.
engine() {
  if [ -n "$PY" ]; then
    printf '%s' "$PY"
  else
    printf '%s (no working python3 or python here)' "$PHP_BIN"
  fi
}

# Prints the RAW value, never JSON-encoded. Encoding an empty string yields the
# two-character text "" which bash reads as a non-empty token -- so a fresh
# install looked like it already had one and refused to generate.
# The value travels in the environment, not spliced into the program text: a
# config value containing a quote could otherwise reshape the code that reads it.
read_cfg() {
  if [ -n "$PY" ]; then
    ROUTER_CFG="$CONFIG" ROUTER_KEY="$1" "$PY" -c '
import json, os
c = json.load(open(os.environ["ROUTER_CFG"]))
v = (c.get("sandbox") or {}).get(os.environ["ROUTER_KEY"])
print("" if v is None or v is False else v)
'
  else
    ROUTER_CFG="$CONFIG" ROUTER_KEY="$1" "$PHP_BIN" -r '
$c = json_decode((string) @file_get_contents((string) getenv("ROUTER_CFG")), true);
$s = is_array($c["sandbox"] ?? null) ? $c["sandbox"] : [];
$v = $s[(string) getenv("ROUTER_KEY")] ?? null;
echo ($v === null || $v === false) ? "" : (is_bool($v) ? "True" : (string) $v);
'
  fi
}

# true / false / unset -- "the gate is off because nobody set it" and "the gate
# is off because it was turned off" look identical from the token alone.
read_gate_state() {
  if [ -n "$PY" ]; then
    ROUTER_CFG="$CONFIG" "$PY" -c '
import json, os
c = json.load(open(os.environ["ROUTER_CFG"]))
s = c.get("sandbox") or {}
if "require_token" not in s:
    print("unset")
else:
    print("true" if s["require_token"] else "false")
'
  else
    ROUTER_CFG="$CONFIG" "$PHP_BIN" -r '
$c = json_decode((string) @file_get_contents((string) getenv("ROUTER_CFG")), true);
$s = is_array($c["sandbox"] ?? null) ? $c["sandbox"] : [];
if (!array_key_exists("require_token", $s)) { echo "unset"; }
else { echo $s["require_token"] ? "true" : "false"; }
'
  fi
}

# Can a temporary file be created in storage/? That needs write access to the
# DIRECTORY, not just to config.json -- and on a Linux install owned by
# www-data a normal user cannot create one even though the file is world
# writable. Checked up front so the answer is one sentence instead of a stack
# trace. (0 = can write, 3 = cannot.)
can_write_dir() {
  if [ -n "$PY" ]; then
    ROUTER_DIR="$(dirname "$CONFIG")" "$PY" -c '
import os, sys
sys.exit(0 if os.access(os.environ["ROUTER_DIR"], os.W_OK) else 3)
'
  else
    ROUTER_DIR="$(dirname "$CONFIG")" "$PHP_BIN" -r '
exit(is_writable((string) getenv("ROUTER_DIR")) ? 0 : 3);
'
  fi
}

# Writing is atomic (temp file + rename) so a crash can never leave a
# half-written config -- which on this copy IS the lockout, since the config
# holds the token.
write_cfg() {
  # $1: "true" or "false" -- $2: the token (may be empty, for --off)
  if ! can_write_dir; then
    echo "Cannot write to $(dirname "$CONFIG") as $(id -un 2>/dev/null || echo "this user")." >&2
    echo >&2
    if [ "$WIN" = yes ]; then
      echo "On Windows there is no sudo to reach for. Either:" >&2
      echo >&2
      echo "  * read the token with  start.bat -Token  -- it needs no write at all, or" >&2
      echo "  * let your user write the storage folder (right-click storage ->" >&2
      echo "    Properties -> Security) and run this again." >&2
    else
      echo "storage/ is owned by www-data, so creating the temporary file needs root." >&2
      echo "Re-run it with sudo:" >&2
      echo >&2
      echo "    sudo ./setup-token.sh ${RERUN_ARGS:-}" >&2
    fi
    exit 1
  fi

  if [ -n "$PY" ]; then
    ROUTER_CFG="$CONFIG" ROUTER_ON="$1" ROUTER_TOKEN="$2" "$PY" -c '
import json, os, sys
f = os.environ["ROUTER_CFG"]
c = json.load(open(f))
if not isinstance(c, dict):
    sys.stderr.write("That file is not a JSON object.\n")
    sys.exit(4)
s = c.setdefault("sandbox", {})
s["require_token"] = os.environ["ROUTER_ON"] == "true"
s["token"] = os.environ["ROUTER_TOKEN"]
tmp = f + ".tmp"
try:
    with open(tmp, "w") as fh:
        json.dump(c, fh, indent=1)
    os.replace(tmp, f)
except OSError as e:
    try:
        os.unlink(tmp)
    except OSError:
        pass
    sys.stderr.write(str(e) + "\n")
    sys.exit(4)
'
  else
    ROUTER_CFG="$CONFIG" ROUTER_ON="$1" ROUTER_TOKEN="$2" "$PHP_BIN" -r '
$f = (string) getenv("ROUTER_CFG");
$c = json_decode((string) @file_get_contents($f), true);
if (!is_array($c)) {
    fwrite(STDERR, "That file is not a JSON object.\n");
    exit(4);
}
if (!is_array($c["sandbox"] ?? null)) { $c["sandbox"] = []; }
$c["sandbox"]["require_token"] = getenv("ROUTER_ON") === "true";
$c["sandbox"]["token"] = (string) getenv("ROUTER_TOKEN");
$tmp = $f . ".tmp";
if (@file_put_contents($tmp, json_encode($c, JSON_PRETTY_PRINT)) === false) {
    fwrite(STDERR, "Could not write $tmp\n");
    exit(4);
}
if (!@rename($tmp, $f)) {
    @unlink($tmp);
    fwrite(STDERR, "Could not replace $f\n");
    exit(4);
}
'
  fi
  echo "Wrote $CONFIG"
}

gen() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  elif [ -n "$PY" ]; then
    "$PY" -c "import secrets;print(secrets.token_hex(32))"
  else
    "$PHP_BIN" -r 'echo bin2hex(random_bytes(32));'
  fi
}

case "${1:-}" in
  --show)
    echo "Token now in use:"
    token=$(read_cfg token)
    if [ -n "$token" ]; then
      echo "$token"
    else
      echo "  (none set -- run ./setup-token.sh to create one)"
    fi
    echo
    case "$(read_gate_state)" in
      true)
        echo "require_token = true"
        echo "  Every endpoint requires this token. Paste it into Config -> Access"
        echo "  token in each browser (it saves on paste; there is no SAVE button)."
        ;;
      false)
        echo "require_token = false"
        echo "  The gate is OFF: only requests from this machine are answered, and"
        echo "  any other device gets 403 until a token is set."
        ;;
      *)
        echo "require_token = unset"
        echo "  The gate is OFF (nobody has set this key): only requests from this"
        echo "  machine are answered, and any other device gets 403."
        ;;
    esac
    if [ "$WIN" = yes ]; then
      echo
      echo "Windows: start.bat -Token prints this too, with no interpreter."
    fi
    echo
    echo "Read with: $(engine)"
    exit 0
    ;;
  --off)
    RERUN_ARGS="--off"
    write_cfg false ""
    cat <<'MSG'
API gate disabled, and the stored token cleared.

With no token to check, this copy answers ONLY requests from the machine it runs
on: a request arriving from any other address gets 403 ("local requests only").

Note what "cleared" means: re-arming later (./setup-token.sh) generates a NEW
token, and every browser that had the old one pasted must be given the new one.
MSG
    exit 0
    ;;
  --force) ;;
  "")
    ;;
  *)
    echo "Unknown option: $1" >&2; sed -n '2,14p' "$0"; exit 1
    ;;
esac

existing=$(read_cfg token)
if [ -n "$existing" ] && [ "${1:-}" != "--force" ]; then
  echo "A token is already set. Replacing it locks out any other browser or"
  echo "device that has the old one saved."
  echo
  echo "  Current: $existing"
  echo
  echo "Run ./setup-token.sh --force to replace it, or --show to see it."
  exit 1
fi

new=$(gen)
# Remembered separately so the error path can echo the flags without echoing
# the token itself.
RERUN_ARGS="--force"
write_cfg true "$new"

cat <<EOF

Done. API gate is ON and every endpoint now requires this token.

  $new

Next: open the web UI, go to Config -> Access token, paste it. It saves on
paste -- do not look for a SAVE button, there isn't one for this field.

Anyone else using this copy (another browser, another device) needs the same
token pasted into their Config tab too.

To see it again later:  ./setup-token.sh --show
EOF
