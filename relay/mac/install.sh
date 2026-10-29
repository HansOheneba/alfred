#!/bin/zsh
# Installs the Alfred relay: builds it, saves your forwarding key, and starts
# it in the background whenever Messages receives something.
#
#   ./install.sh             install or update
#   ./install.sh uninstall   stop it and remove everything

set -euo pipefail

LABEL="com.hansopoku.alfred-relay"
SUPPORT="$HOME/Library/Application Support/AlfredRelay"
BIN="$SUPPORT/alfred-relay"
AGENT="$HOME/Library/LaunchAgents/$LABEL.plist"
HERE="${0:A:h}"

if [[ "${1:-}" == "uninstall" ]]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm -f "$AGENT"
  rm -rf "$SUPPORT"
  echo "Alfred relay removed. You can also take it out of Full Disk Access in System Settings."
  exit 0
fi

mkdir -p "$SUPPORT" "$HOME/Library/LaunchAgents"
chmod 700 "$SUPPORT"

echo "Building the relay…"
swiftc -O "$HERE/AlfredRelay.swift" -o "$BIN"

if [[ ! -f "$SUPPORT/config.json" ]]; then
  echo -n "Paste your Alfred forwarding key (Settings → Bank messages, starts with alf_): "
  read -rs KEY
  echo
  if [[ ! "$KEY" =~ ^alf_[A-Za-z0-9_-]{20,64}$ ]]; then
    echo "That doesn't look like a forwarding key." >&2
    exit 1
  fi
  umask 077
  printf '{ "key": "%s", "endpoint": "https://alfred.hansopoku.com/api/ingest/sms" }\n' "$KEY" > "$SUPPORT/config.json"
fi

# Runs when the Messages database changes, and every two minutes as a backstop.
cat > "$AGENT" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$BIN</string></array>
  <key>WatchPaths</key><array><string>$HOME/Library/Messages/chat.db-wal</string></array>
  <key>StartInterval</key><integer>120</integer>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardErrorPath</key><string>$SUPPORT/relay.log</string>
  <key>StandardOutPath</key><string>$SUPPORT/relay.log</string>
</dict>
</plist>
PLIST

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$AGENT"

if "$BIN" --check >/dev/null 2>&1; then
  echo "Installed and running. Recent money texts it can see:"
  "$BIN" --check | tail -5
else
  echo
  echo "Installed. One last step: give it Full Disk Access so it can read Messages."
  echo "  1. System Settings → Privacy & Security → Full Disk Access opens now."
  echo "  2. Click +, press Cmd+Shift+G, paste the path below, and add it:"
  echo "     $BIN"
  echo "  3. Run ./install.sh again to confirm it can see your texts."
  open "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"
fi
