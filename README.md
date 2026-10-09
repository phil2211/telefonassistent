# Telefonassistent

Diese Brücke verbindet Twilio (Telefonie) mit der Echtzeit-Sprach-API von xAI Grok. Sie führt ausgehende Anrufe im Auftrag von Philip Eschenbacher: Twilio wählt und streamt das Gesprächsaudio per WebSocket an die Brücke. Die Brücke reicht es an Grok weiter und spielt die Antwort zurück.

```
Gegenüber ⇄ Twilio ⇄ ngrok-Tunnel ⇄ Brücke (Node.js auf deinem Rechner) ⇄ xAI Realtime API
```

Technische Details: [docs/TECHNIK.md](docs/TECHNIK.md) · Auftrag: [SPEC.md](SPEC.md) · Doku-Prüfung: [DOCS_CHECK.md](DOCS_CHECK.md)

## Voraussetzungen

- **Node.js 20 oder neuer**
- **ngrok** mit kostenlosem Konto. ngrok macht die lokale Brücke für Twilio erreichbar und läuft über den normalen Port 443.
- **Twilio:** bezahltes Konto (im Trial ersetzt Twilio den Audiostream durch eine Ansage) und eine Nummer mit Voice-Funktion.
- **xAI:** API-Schlüssel mit Guthaben.

## Einrichten (einmalig, macOS)

```bash
brew install node ngrok
git clone https://github.com/phil2211/telefonassistent.git
cd telefonassistent
npm install
```

### ngrok einrichten

1. Konto anlegen auf [ngrok.com](https://ngrok.com).
2. Im ngrok-Dashboard unter **Your Authtoken** den Token kopieren und einmalig hinterlegen:
   ```bash
   ngrok config add-authtoken <dein-ngrok-authtoken>
   ```
   Der Token wird in der lokalen ngrok-Konfiguration gespeichert, nicht im Repo.
3. Empfohlen: Im Dashboard unter **Domains** deine kostenlose feste Adresse (Dev Domain) holen, z. B. `https://dein-name.ngrok-free.app`. Dann bleibt die Adresse bei jedem Start gleich. Ohne feste Adresse vergibt ngrok bei jedem Start eine neue.

### In der Twilio-Konsole prüfen

- **Geo Permissions:** Voice → Settings → Geo permissions → Schweiz freischalten (Mobil und Festnetz).
- **Schweizer Absendernummer:** Für eine +41-Nummer verlangt Twilio eine regulatorische Registrierung (Ausweis, Schweizer Adresse). Prüf den Status unter Phone Numbers → Regulatory Compliance. Alternative: deine eigene Nummer als *Verified Caller ID*.

## Secrets setzen

Die Brücke liest vier Werte ausschliesslich aus Umgebungsvariablen:

| Variable | Inhalt |
|---|---|
| `XAI_API_KEY` | xAI-API-Schlüssel |
| `TWILIO_ACCOUNT_SID` | Twilio Account SID (beginnt mit `AC`) |
| `TWILIO_AUTH_TOKEN` | Twilio Auth Token |
| `TWILIO_FROM_NUMBER` | Absendernummer im E.164-Format, z. B. `+41…` |

- Im Grok Bot werden sie nur über **Secret-Karten** eingegeben.
- Lokal setzt du sie selbst im Terminal (`export XAI_API_KEY=…` usw.) oder holst sie aus deinem Passwortmanager.
- **Nie** ins Repo, in eine `.env`-Datei im Repo, in Beispiele oder in den Chat schreiben. `.gitignore` schliesst `.env`, `run/`, `calls/` und `.call_api_token` aus.

## Starten

```bash
export NGROK_URL=https://dein-name.ngrok-free.app   # optional, deine feste ngrok-Adresse
scripts/start.sh
```

`start.sh` startet ngrok und die Brücke auf `127.0.0.1:8787` und zeigt die öffentliche URL an. Unter [http://127.0.0.1:4040](http://127.0.0.1:4040) siehst du im ngrok-Inspector jede Anfrage von Twilio live. Mit `Ctrl+C` oder `scripts/stop.sh` beendest du beides.

### Öffentliche URL an Twilio

In der Twilio-Konsole musst du nichts eintragen. Die Brücke übergibt die ngrok-Adresse bei jedem Anruf selbst an Twilio: `/twiml` für die Anweisungen, `wss://…/media` für den Audiostream und `/status` für Dauer und Status.

## Anruf auslösen

```bash
cp auftrag.example.json auftrag.json   # Zielnummer, Ziel und Auftrag eintragen
scripts/call.sh auftrag.json           # in einem zweiten Terminal
```

- Zielnummern nur im E.164-Format, standardmässig nur `+41`.
- `POST /call` ist nur lokal erreichbar und mit einem zufälligen Token geschützt.
- Nach dem Anruf liegen Transkript, Dauer, Kosten und Auswertung in `calls/<Datum_Zeit>_<id>/`.

## Wichtigste Einstellungen

| Variable | Standard | Bedeutung |
|---|---|---|
| `NGROK_URL` | leer | feste ngrok-Adresse, sonst Zufallsadresse |
| `TUNNEL` | `ngrok` | `cloudflared` als Alternative ohne Konto (braucht Port 7844) |
| `XAI_MODEL` | `grok-voice-think-fast-2.0` | Sprachmodell |
| `XAI_VOICE` | `rex` | Stimme |
| `XAI_REASONING` | `high` | `high` oder `none` |
| `MAX_CALL_SECONDS` | `480` | maximale Gesprächsdauer |
| `ALLOWED_TO_PREFIXES` | `+41` | erlaubte Zielnummern |
| `PORT` | `8787` | lokaler Port |

Alle weiteren Optionen findest du in [docs/TECHNIK.md](docs/TECHNIK.md).
