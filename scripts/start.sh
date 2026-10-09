#!/usr/bin/env bash
# Startet Server + Tunnel (Standard: ngrok, alternativ TUNNEL=cloudflared) und gibt die öffentliche URL aus.
# Ctrl+C beendet beides (der Tunnel bleibt nicht offen).
#   TUNNEL=ngrok        (Standard) braucht einmalig: ngrok config add-authtoken <dein-token>
#   NGROK_URL=https://… optional: deine feste ngrok-Adresse (Dev Domain), sonst Zufallsadresse
#   TUNNEL=cloudflared  Quick Tunnel ohne Konto (braucht ausgehend Port 7844)
set -euo pipefail
cd "$(dirname "$0")/.."
PORT="${PORT:-8787}"
TUNNEL="${TUNNEL:-ngrok}"
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
  [ -n "${TUN_PID:-}" ] && kill "$TUN_PID" 2>/dev/null || true
  rm -f run/*.pid
}
trap cleanup EXIT INT TERM

PUBLIC_URL=""
case "$TUNNEL" in
  ngrok)
    command -v ngrok >/dev/null || { echo "ngrok nicht gefunden (macOS: brew install ngrok)" >&2; exit 1; }
    ARGS=(http "$PORT" --log=stdout)
    [ -n "${NGROK_URL:-}" ] && ARGS+=(--url "$NGROK_URL")
    : > run/tunnel.log
    ngrok "${ARGS[@]}" > run/tunnel.log 2>&1 &
    TUN_PID=$!; echo "$TUN_PID" > run/tunnel.pid
    for _ in $(seq 1 30); do
      PUBLIC_URL="$(curl -s http://127.0.0.1:4040/api/tunnels 2>/dev/null \
        | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const t=JSON.parse(s).tunnels.find(x=>x.public_url.startsWith("https"));if(t)console.log(t.public_url)}catch{}})' || true)"
      [ -n "$PUBLIC_URL" ] && break
      kill -0 "$TUN_PID" 2>/dev/null || { echo "ngrok ist abgebrochen, siehe run/tunnel.log (Authtoken gesetzt?)" >&2; exit 1; }
      sleep 1
    done
    ;;
  cloudflared)
    command -v cloudflared >/dev/null || { echo "cloudflared nicht gefunden (macOS: brew install cloudflared)" >&2; exit 1; }
    : > run/tunnel.log
    cloudflared tunnel --no-autoupdate --protocol http2 --url "http://127.0.0.1:${PORT}" > run/tunnel.log 2>&1 &
    TUN_PID=$!; echo "$TUN_PID" > run/tunnel.pid
    for _ in $(seq 1 60); do
      PUBLIC_URL="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' run/tunnel.log | head -1 || true)"
      [ -n "$PUBLIC_URL" ] && break
      sleep 1
    done
    ;;
  *) echo "Unbekannter TUNNEL='$TUNNEL' (ngrok oder cloudflared)" >&2; exit 1 ;;
esac
[ -n "$PUBLIC_URL" ] || { echo "Tunnel-URL nicht gefunden, siehe run/tunnel.log" >&2; exit 1; }
export PUBLIC_URL

node src/server.js > >(tee -a run/server.log) 2>&1 &
SRV_PID=$!; echo "$SRV_PID" > run/server.pid

echo "--------------------------------------------------------------"
echo "Tunnel:          $TUNNEL"
echo "Öffentliche URL: $PUBLIC_URL"
echo "TwiML:           $PUBLIC_URL/twiml"
echo "Media Stream:    ${PUBLIC_URL/https:/wss:}/media"
[ "$TUNNEL" = ngrok ] && echo "ngrok-Inspector: http://127.0.0.1:4040"
echo "Anruf starten:   scripts/call.sh <auftrag.json>   (nur lokal, mit Token)"
echo "Beenden:         Ctrl+C"
echo "--------------------------------------------------------------"
wait "$SRV_PID"
