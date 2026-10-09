#!/usr/bin/env bash
# Startet einen Anruf: scripts/call.sh auftrag.json
# auftrag.json: {"to":"+41...","target_name":"...","task":"...","contact":{"phone":"...","email":"...","postal":"..."}}
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f "${1:-}" ] || { echo "Nutzung: $0 auftrag.json" >&2; exit 1; }
curl -sS -X POST "http://127.0.0.1:${PORT:-8787}/call" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $(cat .call_api_token)" \
  --data-binary @"$1"
echo
