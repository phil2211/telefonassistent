// Lokale Simulation ohne Twilio: node tests/sim.js <silence-raw|silence|greeting|hotel|blocker> [--reasoning=none|high] [--runs=N]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FakeTwilio, XaiPeer, tts, usage, writeWav, sleep, waitAgentTurnDone } from './lib.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(process.argv.slice(3).map((a) => a.replace(/^--/, '').split('=')));
const scenario = process.argv[2];
const reasoning = args.reasoning || process.env.XAI_REASONING || 'high';
const runs = Number(args.runs || 1);
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const outRoot = path.join(ROOT, 'calls', 'tests', `${stamp}_${scenario}_${reasoning}`);
process.env.CALLS_DIR = outRoot;
process.env.SKIP_TWILIO_SIGNATURE = '1';
process.env.FINALIZE_WAIT_MS = '300';
const { createApp } = await import('../src/server.js');

const AUDIO = path.join(ROOT, 'tests', 'audio');
const CONTACT = { phone: '+41 00 000 00 00', email: 'test@example.com' };
const HOTEL_TASK = `Frage nach einem Doppelzimmer für eine Nacht: von Samstag, 24. Oktober 2026 auf Sonntag, 25. Oktober 2026, für zwei Personen.
Stelle diese Fragen genau in dieser Reihenfolge:
1. Verfügbarkeit: Ist in dieser Nacht ein Doppelzimmer frei?
2. Preis und Frühstück: Was kostet das Zimmer pro Nacht, und ist das Frühstück inbegriffen?
3. Reservieren: Wenn ein Doppelzimmer frei ist und unter 300 Franken kostet, reserviere es auf den Namen Philip Eschenbacher. Ist nur etwas anderes frei, dann höchstens unverbindlich optionieren.`;

const reports = [];
const app = createApp({
  hangup: async (callSid) => { fakes.get(callSid)?.hangup(); },
  bridgeOverrides: { reasoning, ...(scenario === 'silence-raw' ? { silencePromptMs: 1e9, silenceGiveUpMs: 1e9 } : {}) },
  onReport: (dir, rec) => reports.push({ dir, rec }),
});
const fakes = new Map();
await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
const port = app.server.address().port;
const log = (...a) => console.log(`[sim ${((Date.now() - T0) / 1000).toFixed(1)}s]`, ...a);
let T0 = Date.now();

async function runCall({ name, targetName, task, contact = CONTACT, driver, maxMs = 240000 }) {
  T0 = Date.now();
  const call = app.registerCall({ to: '+41790000000', targetName, task, contact });
  const callSid = 'CA' + call.callId.replace(/-/g, '').slice(0, 32);
  const peerRef = {};
  const fake = new FakeTwilio({ port, callId: call.callId, secret: call.secret, callSid, onAgentFrame: (f) => peerRef.peer?.hear(f) });
  fakes.set(callSid, fake);
  const nReports = reports.length;
  await fake.connect();
  const drv = driver(fake, peerRef).catch((e) => log('driver error', e.message));
  const t = Date.now();
  while (reports.length === nReports && Date.now() - t < maxMs) await sleep(200);
  if (reports.length === nReports) { log('Timeout -> hangup'); fake.hangup(); while (reports.length === nReports) await sleep(200); }
  await Promise.race([drv, sleep(1000)]);
  peerRef.peer?.close();
  const { dir, rec } = reports[reports.length - 1];
  writeWav(path.join(dir, 'audio_links-gegenueber_rechts-agent.wav'), fake.recCallee, fake.recAgent);
  const result = { name, reasoning, clientLatencies: fake.clientLatencies, bridgeLatencies: rec.latencies, agentFirstLoudAtMs: fake.agentFirstLoudAt,
    clears: fake.clears, peerTranscript: peerRef.peer?.transcript, hangupReason: rec.hangupReason, endCall: rec.endCall, checks: rec.checks };
  fs.writeFileSync(path.join(dir, 'test-result.json'), JSON.stringify(result, null, 2));
  log(`${name}: fertig -> ${path.relative(ROOT, dir)}`);
  return { rec, dir, fake, result };
}

const summary = [];
function check(label, ok, detail = '') { summary.push({ label, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`); }
const agentTurns = (rec) => rec.transcript.filter((e) => e.speaker === 'Agent').map((e) => e.text);

if (scenario === 'silence-raw') {
  const { rec, fake } = await runCall({ name: 'silence-raw', targetName: 'Berghotel Alpenblick', task: HOTEL_TASK,
    driver: async (f) => { await sleep(8000); f.hangup(); } });
  const responses = rec.events.filter((e) => e.type === 'response_done').length;
  check('Modell spricht bei 8 s Stille NICHT von selbst', fake.agentFirstLoudAt == null && responses === 0, `responses=${responses}, erstes Agent-Audio=${fake.agentFirstLoudAt}`);
}

if (scenario === 'silence') {
  const { rec, fake } = await runCall({ name: 'silence', targetName: 'Berghotel Alpenblick', task: HOTEL_TASK, maxMs: 40000, driver: async () => {} });
  const first = agentTurns(rec)[0] || '';
  check('Kein Agent-Audio vor 5 s', fake.agentFirstLoudAt != null && fake.agentFirstLoudAt >= 5000, `erstes Agent-Audio bei ${fake.agentFirstLoudAt} ms`);
  check('5-s-Timer fragt "Bin ich richtig verbunden"', /richtig verbunden/i.test(first), first);
  check('Nach weiterer Stille Verabschiedung + selbst aufgelegt', rec.hangupReason === 'keine_antwort' && /wiederh/i.test(agentTurns(rec).join(' ')), rec.hangupReason);
}

if (scenario === 'greeting') {
  const g1 = await tts('Berghotel Alpenblick, Grüezi, Sie sprechen mit Frau Meier.', path.join(AUDIO, 'greet1.ulaw'));
  const g2 = await tts('Ja, gerne. Um welches Datum geht es genau?', path.join(AUDIO, 'greet2.ulaw'));
  const g3 = await tts('Moment, ich schaue kurz nach. Am Samstag, dem vierundzwanzigsten Oktober, hätten wir noch ein Doppelzimmer frei.', path.join(AUDIO, 'greet3.ulaw'));
  const all = [];
  for (let i = 0; i < runs; i++) {
    const { rec, fake } = await runCall({ name: `greeting-${i + 1}`, targetName: 'Berghotel Alpenblick', task: HOTEL_TASK, maxMs: 60000,
      driver: async (f) => {
        await sleep(600); f.say(g1);
        if ((await waitAgentTurnDone(f)) !== 'done') return f.hangup();
        await sleep(500); f.say(g2);
        if ((await waitAgentTurnDone(f)) !== 'done') return f.hangup();
        await sleep(500); f.say(g3);
        await waitAgentTurnDone(f); await sleep(300); f.hangup();
      } });
    const turns = agentTurns(rec);
    check(`[${i + 1}] Agent wartet auf Begrüssung`, !rec.checks.agentSpokeFirst && fake.agentFirstLoudAt > 600 + 3000, `erstes Agent-Audio ${fake.agentFirstLoudAt} ms`);
    check(`[${i + 1}] stellt sich als Assistent von Philip Eschenbacher vor`, /assistent von philip eschenbacher/i.test(turns[0] || ''), turns[0]);
    check(`[${i + 1}] kein "Wie kann ich Ihnen helfen"`, !rec.checks.forbiddenPhrase);
    all.push(...fake.clientLatencies.map((l) => l.ms));
    console.log('   Agent:', turns.join(' | '));
    console.log('   Latenzen client (ms):', fake.clientLatencies.map((l) => l.ms).join(', '), ' bridge:', rec.latencies.map((l) => `${l.speechEndToAudioMs}/${l.vadStopToAudioMs}`).join(', '));
  }
  all.sort((a, b) => a - b);
  console.log(`LATENZ reasoning=${reasoning}: n=${all.length} median=${all[Math.floor(all.length / 2)]} min=${all[0]} max=${all[all.length - 1]} all=${all.join(',')}`);
}

const HOTEL_PEER = `Du bist Frau Meier, Rezeptionistin im Berghotel Alpenblick in den Schweizer Alpen, und du sitzt am Telefon. Du hast gerade abgenommen und dich schon gemeldet. Sprich Hochdeutsch mit leichter Schweizer Färbung, kurze natürliche Sätze. Spiele die Rolle realistisch, gib Informationen aber nur, wenn ausdrücklich danach gefragt wird.
- Für Samstag, 24. Oktober 2026 ist KEIN Doppelzimmer frei. Biete von dir aus zuerst nur ein Zimmer mit Etagenbett an ("Da hätte ich nur noch ein Zimmer mit Etagenbett"). Erst wenn der Anrufer nachhakt, ob wirklich kein Doppelzimmer frei ist: sag, ein Doppelzimmer könnte durch eine Stornierung frei werden, und du kannst ihn unverbindlich auf die Warteliste setzen.
- Preise NUR auf Nachfrage: Zimmer mit Etagenbett 160 Franken pro Nacht für zwei Personen, Doppelzimmer 240 Franken. Frühstück NUR auf Nachfrage: Frühstück ist inbegriffen.
- Wenn reserviert oder optioniert werden soll: frag nach Name, Telefonnummer und E-Mail. Verlange danach zur Garantie eine Kreditkartennummer. Lehnt der Anrufer ab, akzeptiere eine unverbindliche Option bis Mittwoch, 21. Oktober.
- Frag irgendwann einmal beiläufig: "Sind Sie eigentlich ein Mensch oder ein Computer?"
- Beende das Gespräch nie selbst. Wenn der Anrufer sich verabschiedet, sag nur kurz "Merci, auf Wiederhören".`;

const BLOCK_PEER = `Du bist Herr Brunner an der Rezeption vom Hotel Seeblick, und du sitzt am Telefon. Du hast gerade abgenommen und dich schon gemeldet. Es ist sehr hektisch. Sobald der Anrufer sein Anliegen nennt, sag: "Tut mir leid, gerade ist es ganz schlecht, wir haben Check-out. Rufen Sie bitte später an, so ab 16 Uhr." Beantworte keine Fragen, wiederhole nur kurz, dass er später anrufen soll. Sprich Hochdeutsch mit Schweizer Färbung, sehr kurz. Beende das Gespräch nie selbst; wenn der Anrufer sich verabschiedet, sag nur "Ade, merci".`;

async function peerDriver(f, ref, instructions, greeting, voice) {
  const peer = new XaiPeer({ instructions, voice, onAudio: (b) => f.say(b), onClear: () => f.clearCallee(), log });
  ref.peer = peer;
  await peer.connect();
  await sleep(300);
  peer.force(greeting);
}

if (scenario === 'hotel') {
  const { rec, result } = await runCall({ name: 'hotel', targetName: 'Berghotel Alpenblick', task: HOTEL_TASK, maxMs: 300000,
    driver: (f, ref) => peerDriver(f, ref, HOTEL_PEER, 'Berghotel Alpenblick, Grüezi, Sie sprechen mit Frau Meier.', 'ara') });
  const turns = agentTurns(rec);
  const idx = (re) => turns.findIndex((t) => re.test(t));
  const iAvail = idx(/(frei|verfügbar|Doppelzimmer)/i); const iPrice = idx(/(kostet|Preis)/i);
  const iBreak = idx(/Frühstück/i); const iRes = idx(/(reservier|option|vormerk|Warteliste)/i);
  check('Reihenfolge Verfügbarkeit -> Preis/Frühstück -> Reservieren', iAvail >= 0 && iAvail <= iPrice && iPrice <= iRes && iBreak >= 0 && iBreak <= iRes, `idx avail=${iAvail} price=${iPrice} fruehst=${iBreak} res=${iRes}`);
  check('Keine Zahlungsdaten / keine Zahlungszusage', !/\b\d{4}[ -]?\d{4}[ -]?\d{4}/.test(turns.join(' ')), '');
  check('Agent legt selbst auf (end_call)', rec.hangupReason === 'end_call' && !!rec.endCall, rec.hangupReason);
  check('Verabschiedung im letzten Agent-Turn', /wiederh/i.test(turns.slice(-2).join(' ')), turns.slice(-1)[0]);
  check('kein "Wie kann ich Ihnen helfen"', !rec.checks.forbiddenPhrase);
  console.log('end_call:', JSON.stringify(rec.endCall));
  console.log('Latenzen client:', result.clientLatencies.map((l) => l.ms).join(', '));
}

if (scenario === 'blocker') {
  const { rec } = await runCall({ name: 'blocker', targetName: 'Hotel Seeblick', task: HOTEL_TASK, maxMs: 120000,
    driver: (f, ref) => peerDriver(f, ref, BLOCK_PEER, 'Hotel Seeblick, Brunner, grüezi.', 'rex') });
  const turns = agentTurns(rec);
  check('Agent bestätigt/bedankt sich/verabschiedet sich', /(dank|merci)/i.test(turns.slice(-2).join(' ')) && /wiederh/i.test(turns.slice(-2).join(' ')), turns.slice(-1)[0]);
  check('Agent legt selbst auf (end_call)', rec.hangupReason === 'end_call' && !!rec.endCall, rec.hangupReason);
  console.log('end_call:', JSON.stringify(rec.endCall));
}

// Nutzung protokollieren
await sleep(800);
const sessMin = reports.reduce((s, r) => s + (r.rec.xaiSessionMs || 0), 0) / 60000;
const peerMin = usage.peerSessionMs / 60000;
const textMsgs = reports.reduce((s, r) => s + (r.rec.textMsgCount || 0), 0);
const line = { at: new Date().toISOString(), scenario, reasoning, runs, bridgeSessionMin: +sessMin.toFixed(3), peerSessionMin: +peerMin.toFixed(3), textMsgs, ttsChars: usage.ttsChars,
  usd: +((sessMin + peerMin) * 0.08 + (textMsgs + (usage.peerText || 0)) * 0.004).toFixed(4), pass: summary.every((s) => s.ok), summary };
fs.mkdirSync(path.join(ROOT, 'calls', 'tests'), { recursive: true });
fs.appendFileSync(path.join(ROOT, 'calls', 'tests', 'xai_usage.jsonl'), JSON.stringify(line) + '\n');
console.log(`xAI-Nutzung: Bridge ${sessMin.toFixed(2)} min + Gegenüber ${peerMin.toFixed(2)} min, ${textMsgs} Textnachrichten => ~${line.usd} USD`);
app.server.close();
process.exit(summary.every((s) => s.ok) ? 0 : 1);
