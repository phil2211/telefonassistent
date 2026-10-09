# Testergebnisse (lokal, ohne Twilio), 7.10.2026

Alle Protokolle unter `calls/tests/<Zeit>_<Szenario>_<reasoning>/…` (transcript.md, auswertung.md, call.json, test-result.json, Stereo-WAV links Gegenüber / rechts Agent). Nutzung: `calls/tests/xai_usage.jsonl`.

| Test | Ergebnis |
|---|---|
| Offline (`npm run test:unit`) | 20/20 bestanden (Auth, Tunnel-Sperre, E.164/Präfix, TwiML, Signatur, Media-Secret, Kosten, Prompt, kein response.create, end_call-Sperre, mark-Auflegen, Barge-in, Einwurf) |
| 1a Stille roh (8 s, Timer aus) | PASS: 0 Antworten, kein Audio vom Modell |
| 1b Stille mit Timer | PASS: erstes Agent-Audio bei 5.6 s: "Guten Tag, hier ist der Assistent von Philip Eschenbacher. Bin ich richtig verbunden mit Berghotel Alpenblick?"; nach weiterer Stille Verabschiedung und selbst aufgelegt |
| 2 Begrüssung (TTS "Berghotel Alpenblick, Grüezi …") | PASS in 8/8 Läufen: wartet, stellt sich als "Assistent von Philip Eschenbacher" vor, nennt Anliegen + erste Frage, nie "Wie kann ich Ihnen helfen" |
| 3 Berghotel komplett (xAI spielt Frau Meier) | letzter Lauf (high, finaler Prompt) PASS, siehe unten; frühere Läufe deckten Fehler auf, die behoben wurden |
| 3b Blocker "Rufen Sie später an" | PASS: "Dann fasse ich kurz zusammen: … ich soll ab 16 Uhr zurückrufen. Vielen Dank für Ihre Hilfe. Auf Wiederhören." + end_call (abgeblockt), 30 s |

## Latenz (Ende Sprache Gegenüber → erstes Agent-Audio)
Zwei Messungen: **Client** = im Fake-Twilio gemessen (letzter hörbarer Frame des Gegenübers → erster hörbarer Agent-Frame, entspricht dem Höreindruck ohne Netz). **Bridge** = in der Bridge (VAD-`audio_end_ms` → erstes Audio-Byte an Twilio; diese Zahl steht auch in echten Anrufen in der Auswertung, sie ist eher 100–300 ms zu pessimistisch).

| Setting | Client Median / p90 | Anteil < 1.5 s | Bridge Median |
|---|---|---|---|
| Begrüssung, reasoning none (9 Turns) | 1282 / 1422 ms | 9/9 | 1321 ms |
| Begrüssung, reasoning high (6 Turns) | 1261 / 1400 ms | 6/6 | 1458 ms |
| Hotel, none (19 Turns) | 1302 / 1522 ms | 16/19 | 1598 ms |
| Hotel, high (20 Turns) | 1381 / 1599 ms | 16/20 | 1495 ms |

- Zusammensetzung: ca. 0.75–0.8 s wartet der Server-VAD auf Stille, danach 0.6–0.9 s bis zum ersten Audio. `reasoning=none` bringt messbar **nichts**, `high` hält die Reihenfolge-Regeln besser ein → **gewählt: high** (Default, `XAI_REASONING=none` umschaltbar).
- Versuch `VAD_SILENCE_MS=500` (1 Lauf): Bridge-Wert sank auf ~1.1–1.35 s, Client-Wert war aber nicht besser (1.8–2.0 s); nicht übernommen, beim echten Anruf erneut prüfen.
- Echter Anruf: + Twilio/Mobilnetz-Laufzeit (geschätzt 0.1–0.3 s). Ziel "in der Regel < 1.5 s" ist damit knapp; im Echttest nachmessen.

## Berghotel, letzter Lauf (reasoning high), gekürzt
Frau Meier meldet sich → Agent stellt sich vor, fragt nach Doppelzimmer 24./25.10. → "nur Etagenbett" → Agent: "Ist ein Doppelzimmer wirklich nicht möglich?" → Warteliste angeboten → Agent: "Gerne, gleich. Was kostet das Zimmer …" (unterbrochen) → nennt Name, Telefon, E-Mail → fasst zusammen, stellt die offene Preis/Frühstück-Frage erneut → 240 CHF inkl. Frühstück → "Vielen Dank für Ihre Hilfe, Frau Meier. Auf Wiederhören." → end_call (teilweise). Kreditkarte im Vorlauf abgelehnt ("erledigt Philip Eschenbacher selbst").

## Gefundene und behobene Fehler
1. Byte-Zählung aus Base64 um 1.25 % zu hoch → Latenzmessung driftete. Behoben.
2. Agent nahm die Warteliste vor Preis/Frühstück an (Regel 6) → Prompt: "Gerne, gleich" + offene Fragen zuerst, unterbrochene Frage wiederholen, Vollständigkeits-Check vor Abschluss.
3. "Ich setze Sie auf die Warteliste" (Rollenverwechslung) → Prompt: Agent bittet, bietet nichts an.
4. Abschluss nur mit "Auf Wiederhören" ohne Zusammenfassung → Prompt-Vorlage in 3 Schritten + end_call wird ohne Verabschiedung abgelehnt.
5. Beispiel-Zusammenfassung im Prompt wurde wörtlich nachgeplappert → durch generische Formulierung ersetzt.
6. Standard-Verabschiedung (force_message) wurde abgeschnitten, weil xAI `response.done` vor dem Audio-Ende schickt → Auflegen erst, wenn 0.8 s kein Audio mehr kam + Twilio-mark.
7. Kurze Einwürfe ("Gerne.") würgten den Agenten ab → Barge-in erst nach 0.6 s bestätigt.
8. Telefonnummer einmal als "plus vierzig …" gesprochen → Prompt enthält jetzt die Ziffernfolge zum Vorlesen ("plus vier eins, null null, …"). **Noch nicht mit xAI nachgetestet.**

## Offene Punkte / Grenzen
- Simulation zweier KIs: beide unterbrechen sich häufiger als Menschen; echter Test mit Philip nötig.
- Latenz knapp an 1.5 s; im Echtanruf messen, ggf. `VAD_SILENCE_MS` 500–600 testen.
- Anrufbeantworter-Erkennung (Twilio AMD) nicht eingebaut; bei Mailbox würde der Agent auf die Ansage reagieren.
- Auswertung wird als Datei geschrieben, nicht automatisch verschickt.
- Prompt-Änderung Nr. 8 und der end_call-Ablehnungspfad sind nur offline getestet.
