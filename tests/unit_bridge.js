// Offline-Test der Bridge-Logik mit Fake-xAI und Fake-Twilio (kein Netzwerk): node tests/unit_bridge.js
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
process.env.CALLS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-ub-'));
const { CallBridge } = await import('../src/bridge.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const twSent = []; const xaiSent = []; let hungUp = null;
const tw = { readyState: 1, send: (s) => twSent.push(JSON.parse(s)), close() {} };
const b = new CallBridge({ twilioWs: tw, call: { callId: 'unit-1', to: '+41790000000', targetName: 'Hotel Test', task: 'T', contact: {} },
  hangup: async (sid) => { hungUp = sid; }, onDone: () => {}, overrides: { silencePromptMs: 1e9 }, log: () => {} });
b.openXai = function () { this.xaiOpenWall = Date.now(); this.xai = { readyState: 1, send: (s) => xaiSent.push(JSON.parse(s)), close() {} }; };
b.handleTwilio({ event: 'start', start: { streamSid: 'MZ1', callSid: 'CA1', customParameters: {} } });
b.onXai({ type: 'session.updated', session: { audio: { output: { format: { type: 'audio/pcmu' } } } } });
assert.ok(!xaiSent.some((e) => e.type === 'response.create'), 'kein response.create beim Verbindungsaufbau');
console.log('PASS kein response.create beim Verbindungsaufbau');

const audio = Buffer.alloc(800, 0x10).toString('base64'); // 100 ms
function response(id, text, endCall) {
  b.onXai({ type: 'response.created', response: { id } });
  b.onXai({ type: 'response.output_item.added', item: { id: id + '-item', type: 'message' } });
  b.onXai({ type: 'response.output_audio.delta', response_id: id, item_id: id + '-item', delta: audio });
  b.onXai({ type: 'response.output_audio_transcript.done', response_id: id, transcript: text });
  if (endCall) b.onXai({ type: 'response.function_call_arguments.done', response_id: id, name: 'end_call', call_id: id + '-call', arguments: JSON.stringify({ status: 'erledigt', summary: 'S' }) });
  b.onXai({ type: 'response.done', response: { id, status: 'completed' } });
}
// 1) end_call ohne Verabschiedung -> abgelehnt, Agent soll sich verabschieden
response('r1', 'Philip Eschenbacher erledigt das selbst.', true);
const out1 = xaiSent.filter((e) => e.item?.type === 'function_call_output').pop();
assert.equal(JSON.parse(out1.item.output).ok, false);
assert.equal(xaiSent[xaiSent.length - 1].type, 'response.create');
assert.equal(b.endPhase, false);
console.log('PASS end_call ohne Verabschiedung wird abgelehnt + response.create');
// 2) mit Verabschiedung -> akzeptiert, mark nach Audio, Auflegen erst nach mark-Echo
response('r2', 'Dann fasse ich kurz zusammen: ... Vielen Dank. Auf Wiederhören.', true);
assert.equal(b.endPhase, true); assert.equal(b.rec.endCall.status, 'erledigt');
await sleep(1300);
const endMark = twSent.filter((m) => m.event === 'mark').map((m) => m.mark.name).find((n) => n.startsWith('end-'));
assert.ok(endMark, 'end-mark gesendet'); assert.equal(hungUp, null, 'noch nicht aufgelegt vor mark-Echo');
b.handleTwilio({ event: 'mark', mark: { name: endMark } });
await sleep(500);
assert.equal(hungUp, 'CA1');
console.log('PASS Verabschiedung wird fertig abgespielt (mark), dann Auflegen via REST');
// 3) Barge-in: clear + truncate
const b2tw = []; const b2x = [];
const b2 = new CallBridge({ twilioWs: { readyState: 1, send: (s) => b2tw.push(JSON.parse(s)), close() {} }, call: { callId: 'unit-2', to: '+41790000000', targetName: 'X', task: 'T' },
  hangup: async () => {}, onDone: () => {}, overrides: { silencePromptMs: 1e9 }, log: () => {} });
b2.openXai = function () { this.xaiOpenWall = Date.now(); this.xai = { readyState: 1, send: (s) => b2x.push(JSON.parse(s)), close() {} }; };
b2.handleTwilio({ event: 'start', start: { streamSid: 'MZ2', callSid: 'CA2', customParameters: {} } });
b2.onXai({ type: 'session.updated', session: {} });
b2.onXai({ type: 'response.created', response: { id: 'x1' } });
b2.onXai({ type: 'response.output_item.added', item: { id: 'it1', type: 'message' } });
for (let i = 0; i < 30; i++) b2.onXai({ type: 'response.output_audio.delta', response_id: 'x1', item_id: 'it1', delta: audio }); // 3 s
b2.onXai({ type: 'response.done', response: { id: 'x1', status: 'completed' } });
b2.onXai({ type: 'input_audio_buffer.speech_started', item_id: 'u1', audio_start_ms: 0 });
await sleep(800);
assert.ok(b2tw.some((m) => m.event === 'clear'));
const tr = b2x.find((e) => e.type === 'conversation.item.truncate');
assert.ok(tr && tr.item_id === 'it1' && tr.audio_end_ms > 400 && tr.audio_end_ms < 1500, JSON.stringify(tr));
console.log(`PASS Barge-in: Twilio clear + truncate bei ${tr.audio_end_ms} ms`);
// 4) kurzer Einwurf (speech_stopped vor Bestätigung) -> kein clear
const before = b2tw.filter((m) => m.event === 'clear').length;
b2.onXai({ type: 'response.created', response: { id: 'x2' } });
for (let i = 0; i < 30; i++) b2.onXai({ type: 'response.output_audio.delta', response_id: 'x2', item_id: 'it2', delta: audio });
b2.onXai({ type: 'response.done', response: { id: 'x2', status: 'completed' } });
b2.onXai({ type: 'input_audio_buffer.speech_started', item_id: 'u2', audio_start_ms: 0 });
await sleep(200);
b2.onXai({ type: 'input_audio_buffer.speech_stopped', item_id: 'u2', audio_end_ms: 300 });
await sleep(700);
assert.equal(b2tw.filter((m) => m.event === 'clear').length, before);
console.log('PASS kurzer Einwurf ("ja") unterbricht den Agenten nicht');
b.finish(); b2.finish();
process.exit(0);
