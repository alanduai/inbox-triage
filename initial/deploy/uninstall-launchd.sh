#!/bin/sh
# Stops the background service and removes it from launchd. Leaves the data folder alone.
set -eu
LABEL="com.inbox-triage"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/$LABEL.plist"
echo "Removed $LABEL."
