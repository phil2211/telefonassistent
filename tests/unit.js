// Offline-Tests ohne xAI und ohne Twilio-Anruf: node tests/unit.js
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

delete process.env.TWILIO_FROM_NUMBER; // Sicherheit: kein echter Anruf möglich
process.env.CALL_API_TOKEN = 'unit-test-token';
process.env.PUBLIC_URL = 'https://example.trycloudflare.com';
process.env.CALLS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-unit-'));
process.env.TWILIO_AUTH_TOKEN ||= 'dummy';
const { createApp } = await import('../src/server.js');
const { estimateCost } = await import('../src/report.js');
const { spokenPhone, buildInstructions } = await import('../src/prompt.js');
const { validateTwilioSignature, isChMobile } = await import('../src/twilio.js');

const app = createApp({ hangup: async () => {} });
await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${app.server.address().port}`;
const post = (p, body, headers = {}) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
const auth = { Authorization: 'Bearer unit-test-token' };
let n = 0; const ok = (m) => { n++; console.log('PASS', m); };

// /call Schutz
assert.equal((await post('/call', { to: '+41790000000', target_name: 'X', task: 'Y' })).status, 401); ok('/call ohne Token -> 401');
assert.equal((await post('/call', { to: '+41790000000', target_name: 'X', task: 'Y' }, { Authorization: 'Bearer falsch' })).status, 401); ok('/call falscher Token -> 401');
assert.equal((await post('/call', { to: '+41790000000', target_name: 'X', task: 'Y' }, { ...auth, 'CF-Connecting-IP': '1.2.3.4' })).status, 403); ok('/call über Tunnel -> 403');
assert.equal((await post('/call', { to: '0790000000', target_name: 'X', task: 'Y' }, auth)).status, 400); ok('/call ohne E.164 -> 400');
assert.equal((await post('/call', { to: '+4930123456', target_name: 'X', task: 'Y' }, auth)).status, 400); ok('/call Nicht-CH-Nummer -> 400 (ALLOWED_TO_PREFIXES)');
assert.equal((await post('/call', { to: '+41790000000', target_name: 'X' }, auth)).status, 400); ok('/call ohne task -> 400');
const r = await post('/call', { to: '+41790000000', target_name: 'X', task: 'Y' }, auth);
assert.equal(r.status, 500); assert.match((await r.json()).error, /TWILIO_FROM_NUMBER/); ok('/call ohne Absendernummer -> 500, kein Twilio-Aufruf');

// /twiml mit Signaturprüfung
const call = app.registerCall({ to: '+41790000000', targetName: 'Berghotel <Test>', task: 'T', contact: {} });
const twimlPath = `/twiml?callId=${call.callId}`;
const params = { CallSid: 'CA123', AccountSid: 'AC123' };
const sign = (p, prm) => crypto.createHmac('sha1', process.env.TWILIO_AUTH_TOKEN).update(process.env.PUBLIC_URL + p + Object.keys(prm).sort().map((k) => k + prm[k]).join('')).digest('base64');
const form = new URLSearchParams(params).toString();
let res = await fetch(base + twimlPath, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': 'bad' }, body: form });
assert.equal(res.status, 403); ok('/twiml mit falscher Signatur -> 403');
res = await fetch(base + twimlPath, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': sign(twimlPath, params) }, body: form });
const xml = await res.text();
assert.equal(res.status, 200);
assert.match(xml, /<Connect><Stream url="wss:\/\/example\.trycloudflare\.com\/media">/);
assert.match(xml, new RegExp(`<Parameter name="callId" value="${call.callId}"/>`));
assert.match(xml, new RegExp(`<Parameter name="secret" value="${call.secret}"/>`));
ok('/twiml liefert <Connect><Stream> mit callId/secret');

// Media-WS: falsches Secret wird abgelehnt
await new Promise((resolve) => {
  const ws = new WebSocket(base.replace('http', 'ws') + '/media');
  ws.on('open', () => ws.send(JSON.stringify({ event: 'start', start: { streamSid: 'MZ1', callSid: 'CA1', customParameters: { callId: call.callId, secret: 'falsch' } } })));
  ws.on('close', resolve);
});
ok('Media-Stream mit falschem Secret wird geschlossen');

// Kosten
const c = estimateCost({ to: '+41791234567', xaiSessionMs: 150000, textMsgCount: 2, twilioDurationSec: 151, streamMs: 150000 });
assert.equal(c.twilio_billed_minutes, 3); assert.equal(c.twilio_rate, 0.1802);
assert.equal(c.xai_audio, 0.2); assert.equal(c.xai_text, 0.008); assert.equal(c.twilio_stream, 0.0132);
assert.equal(c.total, +(0.2 + 0.008 + 3 * 0.1802 + 0.0132).toFixed(4));
assert.equal(estimateCost({ to: '+41441234567', xaiSessionMs: 60000, twilioDurationSec: 60, streamMs: 60000 }).twilio_rate, 0.0419);
ok('Kostenschätzung (Mobil/Festnetz, pro angefangene Minute)');

assert.ok(isChMobile('+41791234567') && !isChMobile('+41441234567')); ok('CH-Mobil-Erkennung');
assert.equal(spokenPhone('+41 00 000 00 00'), 'plus vier eins, null null, null null null, null null, null null'); ok('Telefonnummer Ziffer für Ziffer');
const instr = buildInstructions({ targetName: 'Hotel', task: 'T', contact: { email: 'a@b.ch' }, now: new Date('2026-12-30T10:00:00Z') });
assert.match(instr, /"Dieses Jahr" bedeutet 2026, "nächstes Jahr" bedeutet 2027/);
assert.match(instr, /Assistent von Philip Eschenbacher/); assert.match(instr, /KI-Assistent/);
assert.doesNotMatch(instr, /Telefon:/); ok('Prompt: Datum/Jahr, KI-Offenheit, nur freigegebene Kontaktdaten');
assert.equal(validateTwilioSignature('https://x/y', { a: '1' }, 'nope'), false); ok('Signaturprüfung lehnt ab');

app.server.close();
console.log(`\n${n} Tests bestanden`);
process.exit(0);
