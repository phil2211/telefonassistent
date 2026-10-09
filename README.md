# Telefonassistent

Brücke zwischen Twilio (Telefonie) und der xAI-Grok-Echtzeit-Sprach-API. Sie führt ausgehende Anrufe im Auftrag von Philip Eschenbacher: Twilio wählt und streamt das Gesprächsaudio per WebSocket an die Brücke, die Brücke reicht es an Grok weiter und spielt die Antwort zurück.

```
Gegenüber ⇄ Twilio ⇄ Brücke (Node.js, über Tunnel öffentlich) ⇄ xAI Realtime API
```

Technische Details: [docs/TECHNIK.md](docs/TECHNIK.md) · Auftrag: [SPEC.md](SPEC.md) · Doku-Prüfung: [DOCS_CHECK.md](DOCS_CHECK.md)

## Voraussetzungen

- **Node.js 20 oder neuer**
- **Tunnel-Tool:** `cloudflared` (empfohlen, kein Konto nötig) oder `ngrok` (Konto + Authtoken nötig). Der Tunnel macht die lokale Brücke für Twilio erreichbar. `cloudflared` braucht ausgehend Port 7844.
- **Twilio:** bezahltes Konto (im Trial ersetzt Twilio den Audiostream durch eine Ansage) und eine Nummer mit Voice-Funktion.
- **xAI:** API-Schlüssel mit Guthaben.

macOS:
```bash
brew install node cloudflared
git clone https://github.com/phil2211/telefonassistent.git
cd telefonassistent
npm install
```

## Vorher in der Twilio-Konsole prüfen

- **Geo Permissions:** Voice → Settings → Geo permissions → Schweiz freischalten (Mobil und Festnetz).
- **Schweizer Absendernummer:** Für eine +41-Nummer verlangt Twilio eine regulatorische Registrierung (Ausweis, Schweizer Adresse). Status unter Phone Numbers → Regulatory Compliance prüfen. Alternative: eigene Nummer als *Verified Caller ID*.

## Secrets setzen

Die Brücke liest vier Werte ausschließlich aus Umgebungsvariablen:

| Variable | Inhalt |
|---|---|
| `XAI_API_KEY` | xAI-API-Schlüssel |
| `TWILIO_ACCOUNT_SID` | Twilio Account SID (beginnt mit `AC`) |
| `TWILIO_AUTH_TOKEN` | Twilio Auth Token |
| `TWILIO_FROM_NUMBER` | Absendernummer im E.164-Format |

- Im Grok Bot werden sie nur über **Secret-Karten** eingegeben.
- Lokal setzt du sie selbst in deinem Terminal (`export XAI_API_KEY=…` usw.) oder über deinen Passwortmanager.
- **Nie** ins Repo, in Dateien wie `.env`, in Beispiele oder in den Chat schreiben. `.gitignore` schließt `.env`, `run/`, `calls/` und `.call_api_token` aus.

## Starten

### Variante A: cloudflared (automatisch)

```bash
scripts/start.sh
```

Startet die Brücke auf `127.0.0.1:8787` und einen cloudflared-Tunnel und zeigt die öffentliche URL an. `Ctrl+C` oder `scripts/stop.sh` beendet beides.

### Variante B: ngrok (manuell)

```bash
ngrok http 8787                                   # Terminal 1, zeigt https://….ngrok-free.app
PUBLIC_URL=https://<deine-ngrok-adresse> npm start   # Terminal 2
```

### Öffentliche URL an Twilio

In der Twilio-Konsole musst du nichts eintragen. Die Brücke übergibt die öffentliche URL bei jedem Anruf selbst an Twilio (`/twiml` für die Anweisungen, `wss://…/media` für den Audiostream, `/status` für Dauer und Status). Wichtig ist nur, dass `PUBLIC_URL` gesetzt ist; `start.sh` erledigt das automatisch.

## Anruf auslösen

```bash
cp auftrag.example.json auftrag.json   # Zielnummer, Ziel und Auftrag eintragen
scripts/call.sh auftrag.json           # in einem zweiten Terminal
```

- Zielnummern nur im E.164-Format, standardmäßig nur `+41`.
- `POST /call` ist nur lokal erreichbar und durch einen zufälligen Token geschützt.
- Nach dem Anruf liegen Transkript, Dauer, Kosten und Auswertung in `calls/<Datum_Zeit>_<id>/`.

## Wichtigste Einstellungen

| Variable | Standard | Bedeutung |
|---|---|---|
| `XAI_MODEL` | `grok-voice-think-fast-2.0` | Sprachmodell |
| `XAI_VOICE` | `rex` | Stimme |
| `XAI_REASONING` | `high` | `high` oder `none` |
| `MAX_CALL_SECONDS` | `480` | maximale Gesprächsdauer |
| `ALLOWED_TO_PREFIXES` | `+41` | erlaubte Zielnummern |
| `PORT` | `8787` | lokaler Port |

Alle weiteren Optionen: [docs/TECHNIK.md](docs/TECHNIK.md).
