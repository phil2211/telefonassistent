#!/usr/bin/env bash
# Beendet Server und Tunnel, falls start.sh im Hintergrund lief
cd "$(dirname "$0")/.."
for f in run/server.pid run/cloudflared.pid run/start.pid; do [ -f "$f" ] && kill "$(cat "$f")" 2>/dev/null; rm -f "$f"; done
pkill -f "cloudflared tunnel --no-autoupdate --url http://127.0.0.1:${PORT:-8787}" 2>/dev/null || true
echo "gestoppt"
