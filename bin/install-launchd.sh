#!/bin/sh
# Render launchd/<label>.plist.template for this user/checkout into ~/Library/LaunchAgents.
# Fills __HOME__ ($HOME), __REPO__ (this checkout) and __NODE__ (node on PATH). Does not load/restart;
# prints the commands (restart only when /health shows running=0).
set -eu
LABEL=dev.semantic-craft.zcode-dispatch
REPO="$(cd "$(dirname "$0")/.." && pwd)"
NODE="${NODE_BIN:-$(command -v node)}"; [ -n "$NODE" ] || { echo "node not found (set NODE_BIN)" >&2; exit 2; }
OUT="${1:-$HOME/Library/LaunchAgents/$LABEL.plist}"
mkdir -p "$(dirname "$OUT")" "$HOME/.local/state/zcode-dispatch/logs"
sed -e "s#__HOME__#$HOME#g" -e "s#__REPO__#$REPO#g" -e "s#__NODE__#$NODE#g" "$REPO/launchd/$LABEL.plist.template" > "$OUT.tmp" && mv "$OUT.tmp" "$OUT"
echo "wrote $OUT"
echo "to (re)load: launchctl bootout gui/\$(id -u)/$LABEL 2>/dev/null; launchctl bootstrap gui/\$(id -u) $OUT"
