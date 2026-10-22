#!/usr/bin/env bash
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

set -euo pipefail
cd "$(dirname "$0")"

CONFIG="storage/config.json"

if [ ! -f "$CONFIG" ]; then
  echo "No $CONFIG here. Run this from the copy's own directory, not the source." >&2
  exit 1
fi

# Prints the RAW value, never JSON-encoded. Encoding an empty string yields the
# two-character text "" which bash reads as a non-empty token -- so a fresh
# install looked like it already had one and refused to generate.
read_cfg() {
  python3 -c "
import json
c=json.load(open('$CONFIG'))
v=c.get('sandbox',{}).get('$1')
print('' if v is None or v is False else v)
"
}
# Writing is atomic (temp file + os.replace) so a crash can never leave a
# half-written config -- which on this copy IS the lockout, since the config
# holds the token.
#
# That needs write access to the DIRECTORY, not just to config.json. Apache
# creates storage/ as www-data, so a normal user cannot create the temp file
# even though config.json itself is world-writable. Say so plainly instead of
# letting python print a PermissionError traceback.
write_cfg() {
  # A plain boolean probe, no stderr redirection: writing the diagnostic to a
  # temp file made the whole check fail for an unrelated reason, so it then
  # reported "cannot write" even when running as root, which it can.
  if ! python3 -c "
import os,sys
d = os.path.dirname('$CONFIG') or '.'
sys.exit(0 if os.access(d, os.W_OK) else 3)
"; then
    echo "Cannot write to $(dirname "$CONFIG") as $(id -un)." >&2
    echo >&2
    echo "storage/ is owned by www-data, so creating the temporary file needs root." >&2
    echo "Re-run it with sudo:" >&2
    echo >&2
    echo "    sudo ./setup-token.sh${RERUN_ARGS:+ $RERUN_ARGS}" >&2
    exit 1
  fi

  if ! python3 -c "
import json,os,sys
f='$CONFIG'
c=json.load(open(f))
s=c.setdefault('sandbox',{})
s['require_token']=bool($1)
s['token']='''$2'''
tmp=f+'.tmp'
try:
    with open(tmp,'w') as fh:
        json.dump(c,fh,indent=1)
    os.replace(tmp,f)
except OSError as e:
    try: os.unlink(tmp)
    except OSError: pass
    sys.stderr.write(str(e)+'\n'); sys.exit(4)
"; then
    echo >&2
    echo "Writing $CONFIG failed. Try:  sudo ./setup-token.sh $*" >&2
    exit 1
  fi
  echo "Wrote $CONFIG"
}

gen() {
  if command -v openssl >/dev/null 2>&1; then openssl rand -hex 32
  else python3 -c "import secrets;print(secrets.token_hex(32))"; fi
}

case "${1:-}" in
  --show)
    echo "Token now in use:"
    read_cfg token
    echo
    echo "require_token = $(read_cfg require_token)"
    exit 0
    ;;
  --off)
    RERUN_ARGS="--off"
    write_cfg False ""
    echo "API gate disabled. Anyone who can reach this server can read your"
    echo "agents' conversations and post commands to it. Only do this if the"
    echo "server is unreachable from the internet (localhost, Tailscale, LAN)."
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
write_cfg True "$new"

cat <<EOF

Done. API gate is ON and every endpoint now requires this token.

  $new

Next: open the web UI, go to Config -> Access token, paste it. It saves on
paste -- do not look for a SAVE button, there isn't one for this field.

Anyone else using this copy (another browser, another device) needs the same
token pasted into their Config tab too.

To see it again later:  ./setup-token.sh --show
EOF