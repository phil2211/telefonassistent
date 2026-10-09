#!/usr/bin/env bash
# Startet Server + cloudflared Quick Tunnel und gibt die öffentliche URL aus.
# Ctrl+C beendet beides (der Tunnel bleibt nicht offen).
set -euo pipefail
cd "$(dirname "$0")/.."
PORT="${PORT:-8787}"
mkdir -p run
echo $$ > run/start.pid

[ -n "${XAI_API_KEY:-}" ] || { echo "XAI_API_KEY fehlt" >&2; exit 1; }
[ -n "${TWILIO_ACCOUNT_SID:-}" ] && [ -n "${TWILIO_AUTH_TOKEN:-}" ] || echo "WARNUNG: Twilio-Zugang fehlt (nur Simulation möglich)" >&2
[ -n "${TWILIO_FROM_NUMBER:-}" ] || echo "WARNUNG: TWILIO_FROM_NUMBER fehlt, POST /call antwortet mit Fehler" >&2
[ -d node_modules ] || npm install --silent

# CALL_API_TOKEN erzeugen (0600-Datei), Wert wird nicht ausgegeben
node -e "import('./src/config.js').then(m=>m.loadCallApiToken())"

cleanup() {
  echo; echo "Beende Server und Tunnel ..."
  [ -n "${SRV_PID:-}" ] && kill "$SRV_PID" 2>/dev/null || true
  [ -n "${CF_PID:-}" ] && kill "$CF_PID" 2>/dev/null || true
  rm -f run/*.pid
}
trap cleanup EXIT INT TERM

: > run/cloudflared.log
cloudflared tunnel --no-autoupdate --protocol http2 --url "http://127.0.0.1:${PORT}" > run/cloudflared.log 2>&1 &
CF_PID=$!; echo "$CF_PID" > run/cloudflared.pid

PUBLIC_URL=""
for _ in $(seq 1 60); do
  PUBLIC_URL="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' run/cloudflared.log | head -1 || true)"
  [ -n "$PUBLIC_URL" ] && break
  sleep 1
done
[ -n "$PUBLIC_URL" ] || { echo "Tunnel-URL nicht gefunden, siehe run/cloudflared.log" >&2; exit 1; }
export PUBLIC_URL

node src/server.js > >(tee -a run/server.log) 2>&1 &
SRV_PID=$!; echo "$SRV_PID" > run/server.pid

echo "--------------------------------------------------------------"
echo "Öffentliche URL: $PUBLIC_URL"
echo "TwiML:           $PUBLIC_URL/twiml"
echo "Media Stream:    ${PUBLIC_URL/https:/wss:}/media"
echo "Anruf starten:   scripts/call.sh <auftrag.json>   (nur lokal, mit Token)"
echo "Beenden:         Ctrl+C"
echo "--------------------------------------------------------------"
wait "$SRV_PID"
