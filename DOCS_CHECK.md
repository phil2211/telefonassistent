# Doku-Check (beim Bau am 7.10.2026 selbst verifiziert)

Hinweis: Die vom Hauptagenten erwähnte DOCS_CHECK.md lag auf dieser Box nicht vor; diese Datei enthält die beim Bau geprüften Fakten.

## xAI Speech to Speech (docs.x.ai, live geprüft)
- Endpunkt `wss://api.x.ai/v1/realtime?model=…`, Auth `Authorization: Bearer XAI_API_KEY`. Region us-east-1. Max. Sitzung 120 min.
- Modelle: `grok-voice-latest` = Alias für `grok-voice-think-fast-2.0` (hier gepinnt).
- `reasoning.effort`: `high` (Default) oder `none`; im `session.updated` bestätigt.
- Audio: `audio.input/output.format.type = "audio/pcmu"` (8 kHz, G.711 µ-law) nativ → keine Umwandlung zu Twilio.
- `turn_detection: {type: "server_vad"}`; Session startet mit `turn_detection: null`. Ohne `response.create` spricht das Modell nicht (getestet: 8 s Stille → 0 Antworten).
- `audio.input.transcription.language_hint: "de"`, `keyterms` (max. 100).
- `force_message` (xAI-Erweiterung): verbatim TTS-Satz ohne Modell. Achtung: `response.done` kommt vor dem Ende des Audios → Auflegen erst, wenn kein Audio mehr kommt.
- `conversation.item.truncate`, `response.cancel`, `input_audio_buffer.speech_started/stopped` (mit `audio_start_ms`/`audio_end_ms`), `turn_detection.idle_timeout_ms` (nicht genutzt, eigener Timer).
- Preise: Audio ab 0.08 USD/min (gesendet oder empfangen, gezählt als Sitzungszeit), 0.004 USD pro `conversation.item.create` (ausser `function_call_output`). `response.create` kostenlos.
- TTS REST `POST /v1/tts` mit `output_format: {codec: "mulaw", sample_rate: 8000}` (für Testaudio genutzt).
- Stimmen: `GET /v1/tts/voices` (28 multilingual, z.B. rex, eve, ara).

## Twilio (Werte aus dem Auftrag des Hauptagenten übernommen, nicht neu geprüft)
- Ausgehend: REST `Calls` + TwiML `<Connect><Stream>`; Media-Stream-Events `connected/start/media/mark/stop`, Steuer-Events `media/mark/clear`.
- Trial-Konten ersetzen den Stream durch eine Ansage → bezahltes Konto nötig.
- Preise (USD/min): CH-Mobil 0.1802, CH-Festnetz 0.0419, Media Stream 0.0044, je angefangene Minute.
- Konto-Status (read-only am 7.10.2026, 16:20): Trial, 0 Nummern, 0 verifizierte Caller IDs, Guthaben 0.00 USD.
