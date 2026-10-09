# Auftrag (Philip Eschenbacher, wörtlich übernommen von dr eggbot)

AUFTRAG: Ausgehender KI-Telefonassistent mit Twilio und dem xAI-Grok-Echtzeitmodell

Ziel
Baue einen kleinen Dienst, der im Auftrag von [NAME] ausgehende Telefonate führt (z. B. Hotelzimmer reservieren, Termine vereinbaren, Auskünfte einholen). Twilio übernimmt die Telefonie, das xAI-Grok-Echtzeitmodell (Sprache zu Sprache) führt das Gespräch, und der Dienst verbindet beide.

Hintergrund
- Bisher liefen die Anrufe über Speko mit GPT-Live. Problem: Das Modell spricht sofort nach dem Abheben, statt auf die Begrüssung zu warten.
- Ein Test über Speko mit xAI-Bausteinen im Cascade-Modus (Spracherkennung, dann Grok 4.3, dann Sprachausgabe) hat korrekt gewartet, war aber mit 3 bis 6 Sekunden Antwortzeit zu langsam. Ausserdem wurden Fragen übersprungen, und das Modell ist am Ende verstummt, statt sich zu verabschieden.
- xAI selbst kann keine ausgehenden Anrufe starten. Die SIP-Anbindung von xAI ist nur für eingehende Anrufe gedacht. Darum braucht es Twilio plus eine eigene Brücke.

Technische Eckdaten (Stand Okt. 2026, bitte gegen die aktuellen Docs prüfen)
- xAI Realtime API: wss://api.x.ai/v1/realtime?model=grok-voice-latest. Kompatibel mit der OpenAI Realtime API. Unterstützt Deutsch und Telefon-Audio G.711 µ-law mit 8 kHz nativ, also keine Umwandlung nötig. Preis ca. 0.08 USD pro Audiominute.
  Docs: https://docs.x.ai/developers/model-capabilities/audio/speech-to-speech
- Twilio: Ausgehender Anruf über die REST API mit TwiML <Connect><Stream>. Damit wird das Gesprächsaudio per WebSocket an den Dienst gestreamt.
- Bestehende Vorlagen als Ausgangspunkt:
  https://github.com/jeffhuber/twilio-grok-voice-bridge
  https://github.com/kevinchau/openclaw-voice-bridge
- Alternativen, falls Twilio ungeeignet ist: LiveKit SIP mit xAI-Plugin, Pipecat (Grok Realtime) oder Voximplant.

Architektur
Gegenüber am Telefon <-> Twilio <-> Bridge-Dienst (Node oder Python, öffentlich per HTTPS/WSS erreichbar, z. B. über einen cloudflared- oder ngrok-Tunnel) <-> xAI Realtime API

Ablauf eines Anrufs
1. Endpunkt POST /call nimmt Zielnummer (E.164), Gesprächsauftrag und freigegebene Kontaktdaten entgegen.
2. Der Dienst startet über Twilio den Anruf und verbindet den Media Stream.
3. Der Dienst öffnet eine xAI-Realtime-Sitzung mit Systemprompt (siehe unten), language_hint "de", µ-law-Audio und turn_detection server_vad.
4. Das Audio wird in beide Richtungen durchgereicht.
5. WICHTIG: Kein response.create beim Verbindungsaufbau. Der Agent spricht erst, nachdem die angerufene Person etwas gesagt hat. Bleibt es ca. 5 Sekunden still, fragt der Agent: "Bin ich richtig verbunden mit [ZIEL]?"
6. Ein Tool end_call lässt den Agenten nach der Verabschiedung selbst auflegen.
7. Transkript, Dauer und Kosten werden gespeichert und dem Auftraggeber als Auswertung geschickt.

Gesprächsregeln für den Systemprompt
1. Nie zuerst sprechen, sondern auf die Begrüssung warten und darauf reagieren.
2. Der Agent ist der Anrufer, nicht die angerufene Firma. Nie "Wie kann ich Ihnen helfen?" sagen.
3. Vorstellen als "Assistent von [NAME]". Auf Nachfrage offen sagen, dass es ein KI-Assistent ist.
4. Hochdeutsch, höflich, kurze Sätze, nur eine Frage auf einmal, nicht mit "Mhm" unterbrechen.
5. Das heutige Datum in den Prompt schreiben und "dieses Jahr" bzw. "nächstes Jahr" korrekt verwenden.
6. Fragen in der vorgegebenen Reihenfolge stellen und keine überspringen, z. B. erst Verfügbarkeit, dann Preis und Frühstück, dann reservieren.
7. Wird etwas anderes angeboten als gewünscht (z. B. Etagenbett statt Doppelzimmer), nicht einfach annehmen. Nachhaken, Alternative und Preis notieren und höchstens unverbindlich optionieren.
8. Nur die freigegebenen Kontaktdaten nennen: [TELEFON], [E-MAIL], [POSTADRESSE]. Keine Zahlungsdaten herausgeben und keine Zahlung zusagen.
9. Auch wenn das Gegenüber abblockt ("rufen Sie später an"): kurz bestätigen, zusammenfassen, bedanken und verabschieden. Nie einfach verstummen.

Benötigte Zugänge (als Umgebungsvariablen oder Secrets, nie im Klartext im Chat)
- XAI_API_KEY mit Guthaben
- TWILIO_ACCOUNT_SID und TWILIO_AUTH_TOKEN (oder ein Twilio API Key)
- Eine Twilio-Nummer, die ausgehende Anrufe machen kann, mit freigeschalteten Anrufen in die Schweiz (Geo Permissions)
- Öffentliche URL für Twilio-Webhook und Media Stream

Kosten
xAI ca. 0.08 USD pro Minute plus Twilio-Minutenpreis für Schweizer Mobilnummern (noch nicht geprüft). Für eine Schweizer Absendernummer kann Twilio eine regulatorische Registrierung verlangen (nicht geprüft).

Erfolgskriterien
- Testanruf an [EIGENE TESTNUMMER]: Der Agent wartet hörbar auf die Begrüssung und antwortet danach in der Regel unter 1.5 Sekunden.
- Alle Fragen werden in der richtigen Reihenfolge gestellt, das Gespräch endet mit Zusammenfassung und Verabschiedung, und der Agent legt selbst auf.
- Transkript und Kosten liegen nach dem Anruf vor.

Testszenario zum Üben
Der Auftraggeber spielt ein Berghotel. Der Agent fragt nach einem Doppelzimmer für eine Nacht an einem bestimmten Wochenende, dann nach Preis und Frühstück, und versucht anschliessend zu reservieren.

[NAME] = Philip Eschenbacher
