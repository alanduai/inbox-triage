#!/bin/sh
# Installs inbox-triage as a background service for the logged-in user (a launchd agent),
# so it starts at login and restarts if it stops. Run from the initial/ folder after `npm run build`.
set -eu

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(command -v node)"
LABEL="com.inbox-triage"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

if [ ! -f "$APP_DIR/dist/src/cli.js" ]; then
  echo "Build first: npm run build" >&2
  exit 1
fi
case "$APP_DIR$NODE" in
  *"&"*|*"<"*|*">"*) echo "Paths with &, < or > are not supported: $APP_DIR, $NODE" >&2; exit 1 ;;
esac

mkdir -p "$APP_DIR/data/logs" "$HOME/Library/LaunchAgents"
chmod 700 "$APP_DIR/data"

cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>--disable-warning=ExperimentalWarning</string>
    <string>$APP_DIR/dist/src/cli.js</string>
    <string>run</string>
  </array>
  <key>WorkingDirectory</key><string>$APP_DIR</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>$APP_DIR/data/logs/service.log</string>
  <key>StandardErrorPath</key><string>$APP_DIR/data/logs/service.log</string>
</dict>
</plist>
PLIST_EOF

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "Installed $LABEL. Log: $APP_DIR/data/logs/service.log"
echo "Stop it with: deploy/uninstall-launchd.sh"
