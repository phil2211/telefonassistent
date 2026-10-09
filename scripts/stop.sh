#!/usr/bin/env bash
# Beendet Server und Tunnel, falls start.sh im Hintergrund lief
cd "$(dirname "$0")/.."
for f in run/server.pid run/tunnel.pid run/start.pid; do [ -f "$f" ] && kill "$(cat "$f")" 2>/dev/null; rm -f "$f"; done
echo "gestoppt"
