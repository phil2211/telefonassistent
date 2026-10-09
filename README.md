# Telefonassistent (Twilio ⇄ Bridge ⇄ xAI Grok Voice)

Ausgehende Telefonate im Auftrag von Philip Eschenbacher. Twilio wählt, streamt das Gesprächsaudio (G.711 µ-law, 8 kHz) per WebSocket an diese Bridge, die es 1:1 an die xAI-Realtime-API (`audio/pcmu`, ohne Umwandlung) weiterreicht und die Antwort zurückspielt.

```
Gegenüber ⇄ Twilio (REST + <Connect><Stream>) ⇄ Bridge (Node 20, dieser Dienst, via cloudflared) ⇄ wss://api.x.ai/v1/realtime
```

## Dateien
| Datei | Inhalt |
|---|---|
| `src/server.js` | HTTP + WS: `POST /call`, `POST /twiml`, `POST /status`, `GET /calls/:id`, `GET /health`, WS `/media` |
| `src/bridge.js` | Kern: Audio in beide Richtungen, Stille-Timer, Barge-in, end_call, Latenzmessung, Sicherheits-Obergrenze |
| `src/prompt.js` | Deutscher Systemprompt (alle 9 Gesprächsregeln, Datum Europe/Zurich, Jahreslogik, Wochenend-Kalender), Tool `end_call` |
| `src/twilio.js` | Twilio REST (Anruf starten, auflegen) ohne SDK, Webhook-Signaturprüfung |
| `src/report.js` | Transkript, Kostenschätzung, Auswertung je Anruf |
| `src/config.js` | Konfiguration über Umgebungsvariablen |
| `scripts/start.sh` / `stop.sh` / `call.sh` | Server + Quick Tunnel starten/stoppen, Anruf auslösen |
| `tests/unit.js`, `tests/unit_bridge.js` | Offline-Tests (ohne xAI, ohne Twilio) |
| `tests/sim.js`, `tests/lib.js` | Simulation ohne Twilio: Fake-Twilio-Client + zweite xAI-Sitzung als Rezeptionistin |
| `calls/tests/` | Testprotokolle (Transkripte, Auswertungen, Stereo-WAV, `xai_usage.jsonl`) |

## Auf dem eigenen Mac starten
```bash
brew install node cloudflared      # Node 20+ und cloudflared (kein Cloudflare-Konto nötig)
git clone https://github.com/phil2211/telefonassistent.git && cd telefonassistent
npm install
# Secrets nur lokal setzen, nie committen:
export XAI_API_KEY=... TWILIO_ACCOUNT_SID=... TWILIO_AUTH_TOKEN=... TWILIO_FROM_NUMBER=+41...
scripts/start.sh                   # Server + Tunnel, zeigt öffentliche URL
cp auftrag.example.json auftrag.json   # Zielnummer + Auftrag eintragen
scripts/call.sh auftrag.json       # in zweitem Terminal, löst den Anruf aus
```
Der Tunnel braucht ausgehend Port 7844 (UDP/QUIC oder TCP mit `--protocol http2`). Der Laptop muss während des Anrufs wach bleiben. Transkript und Auswertung landen in `calls/` (nicht im Repo).

## Starten
```bash
export XAI_API_KEY=... TWILIO_ACCOUNT_SID=... TWILIO_AUTH_TOKEN=... TWILIO_FROM_NUMBER=+41...
npm install            # einmalig (nur Abhängigkeit: ws)
scripts/start.sh       # startet Server (127.0.0.1:8787) + cloudflared Quick Tunnel, zeigt öffentliche URL
# in zweitem Terminal:
scripts/call.sh auftrag.json
# Ctrl+C im ersten Terminal beendet Server UND Tunnel (oder scripts/stop.sh)
```

`auftrag.json`:
```json
{
  "to": "+41791234567",
  "target_name": "Berghotel Alpenblick",
  "task": "Frage nach einem Doppelzimmer ... Stelle diese Fragen genau in dieser Reihenfolge: 1. ... 2. ... 3. ...",
  "contact": { "phone": "+41 79 ...", "email": "...", "postal": "..." }
}
```
`contact` ist optional; es werden nur diese freigegebenen Felder genannt. Antwort: `{callId, callSid, status}`. Status: `GET /calls/<callId>` (mit Token).

Nach jedem Anruf: `calls/<Datum_Zeit>_<id>/` mit `transcript.md` (beide Seiten mit Zeitstempel), `auswertung.md` (Ergebnis aus end_call, Dauer, Kosten, Latenzen, Regel-Checks) und `call.json` (Rohdaten inkl. Latenz je Turn).

## Sicherheit
- `POST /call` braucht `Authorization: Bearer <CALL_API_TOKEN>`. Der Token wird beim ersten Start zufällig erzeugt und in `.call_api_token` (Rechte 0600) abgelegt, nie ausgegeben. `scripts/call.sh` liest ihn von dort.
- `POST /call` wird über den Tunnel grundsätzlich abgelehnt (403), nur lokal erlaubt (`ALLOW_REMOTE_CALL=1` hebt das auf).
- Zielnummern nur E.164 und nur mit erlaubtem Präfix (`ALLOWED_TO_PREFIXES`, Standard `+41`).
- `/twiml` und `/status` prüfen die Twilio-Signatur (`X-Twilio-Signature`). Der Media-Stream wird nur mit callId + zufälligem Einmal-Secret aus der TwiML angenommen.
- Max. Gesprächsdauer 8 min (`MAX_CALL_SECONDS`): 30 s vorher Aufforderung zum Abschluss, dann hartes Auflegen; zusätzlich `TimeLimit` bei Twilio.
- Secrets nur aus Umgebungsvariablen, werden nicht geloggt oder gespeichert.

## Gesprächsablauf (technisch)
1. `POST /call` → Twilio REST `Calls` mit `Url=/twiml`, `StatusCallback=/status`, `Timeout=30`, `TimeLimit`.
2. Abgenommen → TwiML `<Connect><Stream url="wss://…/media">` mit Parametern → Twilio `start`.
3. Erst jetzt wird die xAI-Sitzung geöffnet (spart Kosten beim Klingeln). Audio, das vor `session.updated` ankommt (~0.7–0.9 s), wird gepuffert und nachgeschickt, damit die Begrüssung nicht verloren geht.
4. `session.update`: `audio/pcmu` in/out, `server_vad`, `transcription.language_hint: "de"` (+ Keyterms Zielname/Philip), Stimme `rex`, `reasoning.effort`, Tool `end_call`. **Kein `response.create`.**
5. 5 s ohne Sprache des Gegenübers → `force_message` "Guten Tag, hier ist der Assistent von Philip Eschenbacher. Bin ich richtig verbunden mit <Ziel>?". Weitere 12 s Stille → Verabschiedung und Auflegen.
6. Barge-in: spricht das Gegenüber > 0.6 s in Agent-Audio hinein → Twilio `clear` + `conversation.item.truncate` (auf die tatsächlich abgespielte Länge). Kurze Einwürfe ("ja", "gerne") unterbrechen nicht.
7. `end_call`: wird nur akzeptiert, wenn der Agent sich hörbar verabschiedet hat; sonst bekommt er die Anweisung, erst zusammenzufassen, zu danken und sich zu verabschieden (danach Standard-Verabschiedung als Netz). Dann Twilio-`mark` hinter das letzte Audio, nach dessen Wiedergabe Auflegen per REST (`Status=completed`).
8. Auswertung schreiben, sobald Stream beendet und Twilio-Status `completed` (mit Dauer) da ist.

## Konfiguration (Umgebungsvariablen)
| Variable | Standard | Bedeutung |
|---|---|---|
| `XAI_MODEL` | `grok-voice-think-fast-2.0` | gepinnt (Alias `grok-voice-latest` zeigt derzeit darauf) |
| `XAI_REASONING` | `high` | `high` oder `none` (siehe Testergebnisse) |
| `XAI_VOICE` | `rex` | männliche Stimme ("der Assistent"); Liste: `GET https://api.x.ai/v1/tts/voices` |
| `VAD_SILENCE_MS`, `VAD_THRESHOLD` | Server-Default | Feintuning Sprechpausen-Erkennung |
| `BARGE_IN_CONFIRM_MS` | 600 | ab wann Hineinsprechen den Agenten stoppt |
| `SILENCE_PROMPT_MS` / `SILENCE_GIVEUP_MS` | 5000 / 12000 | Stille-Nachfrage / Aufgeben |
| `MAX_CALL_SECONDS` | 480 | Obergrenze |
| `ALLOWED_TO_PREFIXES` | `+41` | erlaubte Zielnummern |
| `PORT`, `HOST`, `PUBLIC_URL` | 8787, 127.0.0.1, (von start.sh) | |
| `PRICE_*` | 0.08 / 0.004 / 0.1802 / 0.0419 / 0.0044 | Kostenschätzung (USD) |

## Tests
```bash
npm run test:unit                       # offline, kostenlos
node tests/sim.js silence-raw           # 8 s Stille, 5-s-Timer aus: Modell darf nichts sagen
node tests/sim.js silence               # 5-s-Nachfrage + Aufgeben
node tests/sim.js greeting --runs=2 --reasoning=high|none   # Begrüssung + Latenz
node tests/sim.js hotel                 # Berghotel komplett (zweite xAI-Sitzung spielt Frau Meier)
node tests/sim.js blocker               # "Rufen Sie später an"
```
Simulationen kosten xAI-Guthaben (ca. 0.08 USD pro Sitzungsminute, Hotel ≈ 0.28 USD, da zwei Sitzungen). Ergebnisse siehe `TESTERGEBNISSE.md`.
