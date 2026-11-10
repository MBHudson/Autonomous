#!/usr/bin/env bash
# Copyright M. Bryce Hudson 2026-2029 All Rights Reserved
#
# Unauthorized reproduction, distribution, or transmission of the work is prohibited without prior written permission, with exceptions for brief quotations and specific noncommercial uses under copyright law.
#
# BryceFromIndiana@gmail.com

# tunnel.sh — expose this copy's MCP server over a reverse proxy tunnel.
#   ./tunnel.sh                  both tunnels, port 8080 (or $PORT)
#   ./tunnel.sh ngrok             ngrok only
#   ./tunnel.sh cloudflare 8090   cloudflared only, explicit port
#   ./tunnel.sh 8090              both tunnels against port 8090
#
# start.sh serves the app at the URL root, so the friend URL is always
# <tunnel-url>/api/mcp-server (no /router prefix on this platform).
# ngrok needs an authtoken once:  ngrok config add-authtoken <token>
# A reserved ngrok domain via NGROK_DOMAIN in the environment.
set -u
cd "$(dirname "$0")"

# Binaries the installer may have placed in tools/bin come first, so a copy
# that installed them with INSTALL_TUNNELS=1 needs nothing on PATH.
case ":${PATH:-}:" in
  *":$PWD/tools/bin:"*) ;;
  *) export PATH="$PWD/tools/bin:${PATH:-}" ;;
esac

PROVIDER="${1:-both}"
PORT_ARG="${2:-}"
# Explicit arg wins; a stray PORT=0 (or empty) in the environment falls back
# to 8080, since port 0 is never a usable target here.
PORT="${PORT_ARG:-${PORT:-}}"
case "$PORT" in ''|0) PORT=8080 ;; esac
case "$PROVIDER" in
  [0-9]*) PORT="$PROVIDER"; PROVIDER="both" ;;   # bare number is a port
esac
case "$PROVIDER" in
  ngrok|cloudflare|cf|both|all) ;;
  *) echo "ERROR: unknown provider '$PROVIDER'. Use: ngrok | cloudflare | both [port]"; exit 1 ;;
esac
[ "$PROVIDER" = "all" ] && PROVIDER="both"
[ "$PROVIDER" = "cf" ] && PROVIDER="cloudflare"
if ! [[ "$PORT" =~ ^[0-9]+$ ]] || [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then
  echo "ERROR: port '$PORT' is out of range (1-65535)."; exit 1
fi

say() { printf '%s\n' "$*"; }

# --- the app must actually be listening ------------------------------------
if command -v curl >/dev/null 2>&1; then
  if ! curl -fsS --max-time 3 -o /dev/null "http://127.0.0.1:${PORT}/" 2>/dev/null; then
    say "ERROR: nothing answers on http://127.0.0.1:${PORT}/. Start the app first (./start.sh), or pass its port."
    exit 1
  fi
else
  if ! (echo >/dev/tcp/127.0.0.1/"$PORT") 2>/dev/null; then
    say "ERROR: nothing is listening on 127.0.0.1:${PORT}. Start the app first (./start.sh), or pass its port."
    exit 1
  fi
fi
say "==> App is up at http://127.0.0.1:${PORT}/ — MCP RPC at /api/mcp-server"

# --- binaries ----------------------------------------------------------------
HAVE_NGROK=0; HAVE_CF=0
command -v ngrok >/dev/null 2>&1 && HAVE_NGROK=1
command -v cloudflared >/dev/null 2>&1 && HAVE_CF=1
if { [ "$PROVIDER" = "ngrok" ] || [ "$PROVIDER" = "both" ]; } && [ "$HAVE_NGROK" -eq 0 ]; then
  say "    ngrok not found. Install it (https://ngrok.com/download), then:  ngrok config add-authtoken <token>"
fi
if { [ "$PROVIDER" = "cloudflare" ] || [ "$PROVIDER" = "both" ]; } && [ "$HAVE_CF" -eq 0 ]; then
  say "    cloudflared not found. Install it (https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)."
fi
WANT_NGROK=0; WANT_CF=0
{ [ "$PROVIDER" = "ngrok" ] || [ "$PROVIDER" = "both" ]; } && [ "$HAVE_NGROK" -eq 1 ] && WANT_NGROK=1
{ [ "$PROVIDER" = "cloudflare" ] || [ "$PROVIDER" = "both" ]; } && [ "$HAVE_CF" -eq 1 ] && WANT_CF=1
if [ "$WANT_NGROK" -eq 0 ] && [ "$WANT_CF" -eq 0 ]; then
  say "ERROR: nothing to launch. Install the missing tunnel binary (see above) and run again."
  exit 1
fi

FRIEND_LINE="  Friend URL shape:  https://<tunnel-host>/api/mcp-server   header: Authorization: Bearer <their friend token>"

if [ "$WANT_NGROK" -eq 1 ] && [ "$WANT_CF" -eq 1 ]; then
  NGROK_ARGS=(http "127.0.0.1:${PORT}")
  [ -n "${NGROK_DOMAIN:-}" ] && NGROK_ARGS=(http "--domain=${NGROK_DOMAIN}" "127.0.0.1:${PORT}")
  say "==> Starting ngrok in the background (dashboard: http://127.0.0.1:4040)"
  say "$FRIEND_LINE"
  ngrok "${NGROK_ARGS[@]}" &
  NGROK_PID=$!
  cleanup() { kill "$NGROK_PID" 2>/dev/null; }
  trap cleanup EXIT INT TERM
  say "==> Starting Cloudflare quick tunnel here (Ctrl+C stops both)"
  cloudflared tunnel --url "http://127.0.0.1:${PORT}"
  exit $?
fi

if [ "$WANT_NGROK" -eq 1 ]; then
  NGROK_ARGS=(http "127.0.0.1:${PORT}")
  [ -n "${NGROK_DOMAIN:-}" ] && NGROK_ARGS=(http "--domain=${NGROK_DOMAIN}" "127.0.0.1:${PORT}")
  say "==> Starting ngrok (dashboard: http://127.0.0.1:4040)"
  say "$FRIEND_LINE"
  exec ngrok "${NGROK_ARGS[@]}"
fi

say "==> Starting Cloudflare quick tunnel (random URL each launch; needs no account)"
say "$FRIEND_LINE"
exec cloudflared tunnel --url "http://127.0.0.1:${PORT}"
