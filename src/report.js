// Schreibt nach jedem Anruf: transcript.md, call.json (Rohdaten), auswertung.md
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { isChMobile } from './twilio.js';

const r2 = (x) => Math.round(x * 10000) / 10000;

export function estimateCost(rec) {
  const p = config.prices;
  const xaiMin = rec.xaiSessionMs / 60000;
  const xaiAudio = xaiMin * p.xaiPerMin;
  const xaiText = (rec.textMsgCount || 0) * p.xaiPerTextMsg;
  // Twilio rechnet pro angefangene Minute
  const callSec = rec.twilioDurationSec ?? Math.ceil((rec.streamMs || 0) / 1000);
  const billedMin = callSec > 0 ? Math.ceil(callSec / 60) : 0;
  const mobile = isChMobile(rec.to);
  const voiceRate = mobile ? p.twilioChMobilePerMin : p.twilioChLandlinePerMin;
  const streamMin = rec.streamMs > 0 ? Math.ceil(rec.streamMs / 60000) : 0;
  const twilioVoice = billedMin * voiceRate;
  const twilioStream = streamMin * p.twilioStreamPerMin;
  return {
    currency: 'USD',
    xai_session_minutes: r2(xaiMin),
    xai_audio: r2(xaiAudio),
    xai_text_messages: rec.textMsgCount || 0,
    xai_text: r2(xaiText),
    twilio_billed_minutes: billedMin,
    twilio_rate: voiceRate,
    twilio_rate_type: mobile ? 'CH Mobil' : 'CH Festnetz/sonst',
    twilio_voice: r2(twilioVoice),
    twilio_stream_minutes: streamMin,
    twilio_stream: r2(twilioStream),
    total: r2(xaiAudio + xaiText + twilioVoice + twilioStream),
  };
}

function fmtT(ms) {
  const s = Math.max(0, ms) / 1000;
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${(s - m * 60).toFixed(1).padStart(4, '0')}`;
}

export function latencyStats(lat) {
  const vals = lat.map((l) => l.speechEndToAudioMs).filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!vals.length) return null;
  const q = (p) => vals[Math.min(vals.length - 1, Math.floor(p * vals.length))];
  return { n: vals.length, min: vals[0], median: q(0.5), p90: q(0.9), max: vals[vals.length - 1],
    under1500: vals.filter((v) => v < 1500).length };
}

export function writeReport(rec, { dir } = {}) {
  const ts = new Date(rec.answeredAt || Date.now());
  const stamp = new Intl.DateTimeFormat('sv-SE', { timeZone: config.timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .format(ts).replace(' ', '_').replace(/:/g, '-');
  const outDir = dir || path.join(config.callsDir, `${stamp}_${(rec.callId || 'call').slice(0, 8)}`);
  fs.mkdirSync(outDir, { recursive: true });
  const cost = estimateCost(rec);
  const stats = latencyStats(rec.latencies || []);
  rec.cost = cost; rec.latencyStats = stats;

  const lines = [`# Transkript: ${rec.targetName} (${rec.to})`, '',
    `Beginn (abgenommen): ${new Intl.DateTimeFormat('de-CH', { timeZone: config.timezone, dateStyle: 'full', timeStyle: 'medium' }).format(ts)} (${config.timezone})`, ''];
  for (const e of rec.transcript) lines.push(`[${fmtT(e.tMs)}] **${e.speaker}:** ${e.text}`);
  fs.writeFileSync(path.join(outDir, 'transcript.md'), lines.join('\n') + '\n');
  fs.writeFileSync(path.join(outDir, 'call.json'), JSON.stringify(rec, null, 2));

  const durSec = rec.twilioDurationSec ?? Math.round((rec.streamMs || 0) / 1000);
  const ec = rec.endCall;
  const checks = rec.checks || {};
  const yn = (b) => (b ? 'ja' : 'nein');
  const a = [
    `# Auswertung: Anruf bei ${rec.targetName}`, '',
    `**Ergebnis:** ${ec ? `${ec.status}. ${ec.summary}` : `kein end_call (Ende: ${rec.hangupReason || 'unbekannt'})`}`, '',
    '## Eckdaten',
    `- Zielnummer: ${rec.to}`,
    `- Dauer: ${durSec} s (${Math.floor(durSec / 60)}:${String(durSec % 60).padStart(2, '0')} min)`,
    `- Beendet durch: ${rec.hangupReason || '-'}`,
    `- Kosten (Schätzung): ${cost.total.toFixed(3)} USD (xAI ${cost.xai_audio.toFixed(3)} + Text ${cost.xai_text.toFixed(3)}, Twilio ${cost.twilio_billed_minutes} min x ${cost.twilio_rate} ${cost.twilio_rate_type} = ${cost.twilio_voice.toFixed(3)}, Stream ${cost.twilio_stream.toFixed(4)})`,
    stats ? `- Antwortzeit (Ende Gegenüber bis erstes Agent-Audio): Median ${stats.median} ms, p90 ${stats.p90} ms, max ${stats.max} ms, ${stats.under1500}/${stats.n} Antworten unter 1.5 s` : '- Antwortzeit: keine Messwerte',
    '',
    '## Regel-Checks (automatisch)',
    `- Agent hat zuerst gesprochen (unaufgefordert): ${yn(checks.agentSpokeFirst)}`,
    `- 5-s-Nachfrage "Bin ich richtig verbunden" ausgelöst: ${yn(checks.silencePromptFired)}`,
    `- Verbotene Floskel ("Wie kann ich Ihnen helfen"): ${yn(checks.forbiddenPhrase)}`,
    `- Als "Assistent von ${config.principalName}" vorgestellt: ${yn(checks.introducedAsAssistant)}`,
    `- Agent hat selbst aufgelegt (end_call): ${yn(!!ec)}`,
    '',
    'Volles Transkript: transcript.md, Rohdaten: call.json',
  ];
  fs.writeFileSync(path.join(outDir, 'auswertung.md'), a.join('\n') + '\n');
  return outDir;
}
