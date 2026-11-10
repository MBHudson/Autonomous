#!/usr/bin/env bash
# Copyright M. Bryce Hudson 2026-2029 All Rights Reserved
#
# Unauthorized reproduction, distribution, or transmission of the work is prohibited without prior written permission, with exceptions for brief quotations and specific noncommercial uses under copyright law.
#
# BryceFromIndiana@gmail.com

# Start Loop Studio (Linux and macOS). Double-clickable from a file manager on
# most setups, or:  ./start.sh        (port 8080)
#                   ./start.sh 8090   (another port)
#
# Installs what it needs on first run (asks before using sudo):
#   * PHP (7.4+) through apt / dnf / yum / pacman / zypper / brew
#   * the PHP extensions the app uses: curl (required), openssl, mbstring,
#     fileinfo, zip -- installed as packages, then switched on through
#     storage/php-runtime.ini if this PHP has them off (php.ini is not edited)
#   * a CA certificate bundle (tools/cacert.pem) so HTTPS calls verify
#   * the access token (printed once)
set -u
cd "$(dirname "$0")"

say() { printf '%s\n' "$*"; }

# --- package manager -----------------------------------------------------
PM=""
for c in apt-get dnf yum pacman zypper brew; do
  if command -v "$c" >/dev/null 2>&1; then PM="$c"; break; fi
done

SUDO=""
if [ "$(id -u)" != "0" ] && [ "$PM" != "brew" ]; then SUDO="sudo"; fi

# pkg_install <what> -- installs PHP and/or its extensions for this system.
pkg_install() {
  local what="$1" pkgs=""
  case "$PM" in
    apt-get) pkgs="php-cli php-curl php-mbstring php-zip" ;;
    dnf|yum) pkgs="php-cli php-common php-mbstring php-pecl-zip" ;;
    pacman)  pkgs="php" ;;
    zypper)  pkgs="php8 php8-curl php8-mbstring php8-zip php8-fileinfo php8-openssl" ;;
    brew)    pkgs="php" ;;
    *)
      say "  No supported package manager found. Install PHP 7.4+ with the curl"
      say "  extension yourself: https://www.php.net/downloads.php"
      return 1 ;;
  esac
  say ""
  say "  Loop Studio needs $what. It will run:"
  say "    ${SUDO:+$SUDO }$PM install $pkgs"
  if [ -t 0 ]; then
    printf '  Go ahead? [Y/n] '
    read -r ans
    case "$ans" in n|N|no|NO) return 1 ;; esac
  else
    say "  (not a terminal, so not installing; run the command above by hand)"
    return 1
  fi
  case "$PM" in
    apt-get) $SUDO apt-get update -y && $SUDO apt-get install -y $pkgs ;;
    dnf|yum) $SUDO "$PM" install -y $pkgs || $SUDO "$PM" install -y php-cli php-common php-mbstring ;;
    pacman)  $SUDO pacman -S --needed --noconfirm $pkgs ;;
    zypper)  $SUDO zypper --non-interactive install $pkgs ;;
    brew)    brew install $pkgs ;;
  esac
}

# --- PHP -------------------------------------------------------------------
if ! command -v php >/dev/null 2>&1; then
  say "PHP was not found."
  pkg_install "PHP" || exit 1
  hash -r
  if ! command -v php >/dev/null 2>&1; then
    say "  PHP still not found on PATH. Open a new terminal and run ./start.sh again."
    exit 1
  fi
fi

# --- CA certificate bundle -----------------------------------------------
if [ ! -f tools/cacert.pem ]; then
  mkdir -p tools
  say "Downloading CA certificates..."
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --max-time 60 -o tools/cacert.pem https://curl.se/ca/cacert.pem || rm -f tools/cacert.pem
  elif command -v wget >/dev/null 2>&1; then
    wget -q -T 60 -O tools/cacert.pem https://curl.se/ca/cacert.pem || rm -f tools/cacert.pem
  fi
  [ -f tools/cacert.pem ] || say "  (could not download it; HTTPS certificate checks may fail)"
fi

# --- PHP extensions --------------------------------------------------------
PHPARGS=()
setup_php() {
  local line
  PHPARGS=()
  line="$(php serve.php --setup)"
  local rc=$?
  line="${line##*PHPINI=}"
  if [ -n "$line" ]; then PHPARGS=(-c "$line"); fi
  return $rc
}
if ! setup_php; then
  pkg_install "the PHP curl extension" && hash -r && setup_php
  if [ $? -ne 0 ]; then
    say ""
    say "  PHP cannot load the curl extension, so the app could not reach any model."
    exit 1
  fi
fi

# --- Tunnel binaries (only with INSTALL_TUNNELS=1) ---------------------------
# ngrok + cloudflared into tools/bin (no sudo, no package manager), so Config
# -> Tunnels can expose the MCP server off-LAN. Opt-in on purpose: these open
# a public door into this machine, and the app never installs network-facing
# software unasked. Usage:  INSTALL_TUNNELS=1 ./start.sh
install_tunnels() {
  mkdir -p tools/bin
  local os arch
  case "$(uname -s)" in
    Darwin) os="darwin" ;;
    Linux)  os="linux" ;;
    *) say "  Tunnel binaries: $(uname -s) is not covered; install ngrok and cloudflared by hand."; return 0 ;;
  esac
  case "$(uname -m)" in
    x86_64)  arch="amd64" ;;
    aarch64|arm64) arch="arm64" ;;
    *) say "  Tunnel binaries: $(uname -m) is not covered; install ngrok and cloudflared by hand."; return 0 ;;
  esac
  # cloudflared ships a static binary; ngrok a tarball. Pinned to files that
  # do not move ("latest" for cloudflared, the v3-stable line for ngrok).
  if [ ! -x tools/bin/cloudflared ]; then
    say "Downloading cloudflared..."
    if [ "$os" = "darwin" ]; then
      fetch_to "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-${arch}" tools/bin/cloudflared \
      && chmod +x tools/bin/cloudflared || say "  (could not download cloudflared; install it by hand)"
    else
      fetch_to "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${arch}" tools/bin/cloudflared \
      && chmod +x tools/bin/cloudflared || say "  (could not download cloudflared; install it by hand)"
    fi
  else
    say "  cloudflared already in tools/bin"
  fi
  if [ ! -x tools/bin/ngrok ]; then
    say "Downloading ngrok..."
    if fetch_to "https://bin.equinox.io/c/bNyj59tP22/ngrok-v3-stable-${os}-${arch}.tgz" tools/ngrok.tgz; then
      if tar -xzf tools/ngrok.tgz -C tools/bin ngrok 2>/dev/null && [ -x tools/bin/ngrok ]; then
        say "  ngrok ready (run: ./tunnel.sh, after: ngrok config add-authtoken <token>)"
      else
        say "  (could not unpack ngrok; install it by hand: https://ngrok.com/download)"
      fi
      rm -f tools/ngrok.tgz
    else
      say "  (could not download ngrok; install it by hand: https://ngrok.com/download)"
    fi
  else
    say "  ngrok already in tools/bin"
  fi
}

# fetch_to <url> <dest> -- curl first, wget second, like the CA bundle above.
fetch_to() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --max-time 120 -o "$2" "$1"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -T 120 -O "$2" "$1"
  else
    return 1
  fi
}

if [ "${INSTALL_TUNNELS:-0}" = "1" ]; then
  install_tunnels
fi

# Free port at or above the request, so a second copy just works.
PORT="$(php ${PHPARGS[@]+"${PHPARGS[@]}"} serve.php --free-port "${1:-8080}")" || exit 1

# --check fails loudly on old PHP, an unwritable storage/ or missing curl;
# --ensure-token creates the access token exactly once, printing it.
php ${PHPARGS[@]+"${PHPARGS[@]}"} serve.php --check || exit 1
NEW_TOKEN="$(php ${PHPARGS[@]+"${PHPARGS[@]}"} serve.php --ensure-token)" || exit 1
if [ "$NEW_TOKEN" != "TOKEN=exists" ]; then
  say ""
  say "  First run: paste this token into Config -> Access token in the app:"
  say ""
  say "    ${NEW_TOKEN#TOKEN=}"
  say ""
fi

URL="http://127.0.0.1:${PORT}/"
# Worker pool. The built-in server handles ONE request at a time by default,
# and a streamed model reply holds that one slot for the whole reply (up to
# 12 minutes). Everything else in the browser -- the approval poller, state
# sync, and every other agent in a fan-out -- queues behind it, and once the
# listen backlog overflows the connection is refused and the browser reports
# "NetworkError when attempting to fetch resource". Measured here: a request
# issued during a 3-second stream took 2.6s with one worker, 2ms with four.
# POSIX only (PHP's cli-server forks; Windows cannot do this -- see start.bat).
export PHP_CLI_SERVER_WORKERS="${PHP_CLI_SERVER_WORKERS:-8}"
say "  Loop Studio at ${URL}  (Ctrl+C here stops it)"
if command -v open >/dev/null 2>&1; then
  open "$URL" >/dev/null 2>&1 &          # macOS
elif command -v xdg-open >/dev/null 2>&1; then
  xdg-open "$URL" >/dev/null 2>&1 &      # Linux
fi
exec php ${PHPARGS[@]+"${PHPARGS[@]}"} -S "127.0.0.1:${PORT}" serve.php
