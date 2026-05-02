#!/data/data/com.termux/files/usr/bin/bash
# Termux setup for Jobly.
#
# Run on a fresh Termux install:
#   pkg install -y git
#   git clone <this-repo> ~/jobly && cd ~/jobly
#   bash scripts/termux-setup.sh
#
# After setup:
#   cp .env.example .env   # then edit .env with your real values
#   npm run check
#   npm start              # foreground test
#   sv-enable jobly        # background as a termux service

set -euo pipefail

# cd into the project root regardless of where the user invoked the script from.
JOBLY_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$JOBLY_DIR"
echo "==> Project dir: $JOBLY_DIR"

echo "==> Updating Termux package index"
pkg update -y
pkg upgrade -y

echo "==> Installing runtime + service tools"
# nodejs-lts: Node.js (must be >= 22.13 for the built-in node:sqlite module)
# termux-services: process supervision (sv / runit)
# termux-api: optional, for notifications via wake-lock / termux-notification
#
# We DO NOT install python/make/clang — Jobly uses node:sqlite (built into
# Node) so there are no native modules to compile. This makes Termux setup
# fast and avoids better-sqlite3's Android-NDK compatibility issues.
pkg install -y nodejs-lts termux-services termux-api

echo "==> Disabling Android battery optimization (manual step)"
cat <<'NOTE'

  IMPORTANT — for the bot to keep polling in the background, you need to:
    1. Settings → Apps → Termux → Battery → Unrestricted
    2. Settings → Apps → Termux:Boot → Battery → Unrestricted (if installed)
    3. Optionally install Termux:Boot from F-Droid so the service starts at boot.
    4. Run `termux-wake-lock` in a Termux session to keep the CPU awake.

NOTE

echo "==> Installing npm dependencies (this rebuilds better-sqlite3 from source)"
npm install --no-audit --no-fund

echo "==> Running self-check"
npm run check

SVDIR="$PREFIX/var/service/jobly"

echo "==> Installing termux-services unit at $SVDIR"
mkdir -p "$SVDIR" "$SVDIR/log"
cp "$JOBLY_DIR/termux/service/jobly/run" "$SVDIR/run"
cp "$JOBLY_DIR/termux/service/jobly/log/run" "$SVDIR/log/run"
# `run` and `log/run` must be executable for runit to start them.
chmod +x "$SVDIR/run" "$SVDIR/log/run"

# Bake the absolute path to the project into the run script so runit knows
# where to cd. The shipped template has a placeholder.
sed -i "s|__JOBLY_DIR__|$JOBLY_DIR|g" "$SVDIR/run"

echo
echo "==> Done. Next steps:"
echo "    cp .env.example .env  # then edit .env"
echo "    sv-enable jobly       # start the background service"
echo "    sv status jobly       # check status"
echo "    tail -f $JOBLY_DIR/logs/jobbot-\$(date +%F).log"
