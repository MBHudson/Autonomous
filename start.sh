#!/usr/bin/env bash
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
