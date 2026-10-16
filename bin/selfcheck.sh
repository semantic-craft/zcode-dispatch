#!/bin/sh
# zcode-dispatch self-check: launchd state, /health, last N log lines, jobs, and Stop-hook reports.
N="${1:-10}"; S="$HOME/.local/state/zcode-dispatch"
launchctl list | grep zcode-dispatch || echo "launchd: not loaded"
"$(dirname "$0")/zcode-probe" --live || echo "zcode-probe: protocol path NOT usable (exit $?) — dispatch falls back to app scheduler"
# host/port: env > ~/.config/zcode-dispatch/config.json > this node's tailnet IPv4
CONF="${ZCODE_DISPATCH_CONFIG:-$HOME/.config/zcode-dispatch/config.json}"
cfg() { [ -f "$CONF" ] && python3 -c 'import json,sys; v=json.load(open(sys.argv[1])).get(sys.argv[2]); print(v if v is not None else "")' "$CONF" "$1" 2>/dev/null; }
TS="$(command -v tailscale || echo /Applications/Tailscale.app/Contents/MacOS/Tailscale)"
HOST="${DISPATCH_HOST:-$(cfg host)}"; [ -n "$HOST" ] || HOST="$("$TS" ip -4 2>/dev/null | head -n 1)"
PORT="${DISPATCH_PORT:-$(cfg port)}"; PORT="${PORT:-7791}"
if [ -n "$HOST" ]; then curl -s -m 5 "http://$HOST:$PORT/health"; echo; else echo "health: cannot determine host (set DISPATCH_HOST / config.json host / bring tailscale up)"; fi
tail -n "$N" "$S/logs/dispatch.log" 2>/dev/null
ls -t "$S/jobs/"*.json 2>/dev/null | head -n "$N" | while read -r f; do python3 -c 'import json,sys;j=json.load(open(sys.argv[1]));print(j["id"],j["state"],j["project"],j.get("session_id") or "",j.get("error") or "")' "$f"; done
tail -n 5 "$S/reports/reports.jsonl" 2>/dev/null | python3 -c 'import json,sys
for l in sys.stdin:
  r=json.loads(l); print("report:",r.get("job_id"),r.get("session_id"),"yobiru="+str(r.get("yobiru_reported")),r.get("yobiru_receipt") or "")' 2>/dev/null
tail -n 3 "$HOME/.tailmsg/adapters/zcode-state/events.jsonl" 2>/dev/null
