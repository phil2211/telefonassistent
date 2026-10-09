// Test-Hilfen: Fake-Twilio-Client, xAI-Gegenüber (Rezeptionistin), TTS, WAV-Export
import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';

export const FRAME = 160; // 20 ms µ-law @ 8 kHz
export const SILENCE = Buffer.alloc(FRAME, 0xff);

export function ulawToLinear(u) {
  u = ~u & 0xff;
  let t = ((u & 0x0f) << 3) + 0x84;
  t <<= (u & 0x70) >> 4;
  return u & 0x80 ? 0x84 - t : t - 0x84;
}
export function frameRms(buf) {
  let s = 0; for (let i = 0; i < buf.length; i++) { const v = ulawToLinear(buf[i]); s += v * v; }
  return Math.sqrt(s / buf.length);
}
export const LOUD = 400; // RMS-Schwelle für "Sprache"

export function writeWav(file, left, right) {
  // Stereo: links Gegenüber, rechts Agent (µ-law -> PCM16)
  const n = Math.max(left.length, right.length);
  const data = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) {
    data.writeInt16LE(i < left.length ? ulawToLinear(left[i]) : 0, i * 4);
    data.writeInt16LE(i < right.length ? ulawToLinear(right[i]) : 0, i * 4 + 2);
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(2, 22); h.writeUInt32LE(8000, 24);
  h.writeUInt32LE(32000, 28); h.writeUInt16LE(4, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([h, data]));
}

// xAI TTS (REST) -> µ-law 8 kHz, gecacht
export const usage = { ttsChars: 0, peerSessionMs: 0 };
export async function tts(text, file, voice = 'ara') {
  if (fs.existsSync(file)) return fs.readFileSync(file);
  const res = await fetch('https://api.x.ai/v1/tts', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.XAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, language: 'de', voice_id: voice, output_format: { codec: 'mulaw', sample_rate: 8000 } }),
  });
  if (!res.ok) throw new Error(`TTS ${res.status}: ${(await res.text()).slice(0, 200)}`);
  usage.ttsChars += text.length;
  const buf = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buf);
  return buf;
}

/**
 * Fake-Twilio: verhält sich wie ein Twilio Media Stream (start/media/mark/stop, clear).
 * - sendet alle 20 ms einen Frame vom Gegenüber (aus calleeQueue, sonst Stille)
 * - "spielt" Agent-Audio in Echtzeit ab und bestätigt marks erst nach der Wiedergabe
 */
export class FakeTwilio {
  constructor({ port, callId, secret, callSid, onAgentFrame, log }) {
    Object.assign(this, { port, callId, secret, callSid });
    this.onAgentFrame = onAgentFrame || (() => {});
    this.log = log || (() => {});
    this.streamSid = 'MZ' + Math.random().toString(16).slice(2, 18);
    this.calleeQueue = []; // Buffers
    this.playQueue = []; // {buf} | {mark}
    this.recCallee = []; this.recAgent = [];
    this.lastCalleeLoud = null; this.calleeSpeaking = false;
    this.agentLoudSince = null; this.awaitingAgent = false;
    this.clientLatencies = []; this.agentFirstLoudAt = null; this.clears = 0;
    this.closed = false; this.seq = 0; this.chunk = 0;
  }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`ws://127.0.0.1:${this.port}/media`);
      this.ws.on('open', () => {
        this.send({ event: 'connected', protocol: 'Call', version: '1.0.0' });
        this.send({ event: 'start', sequenceNumber: String(++this.seq), streamSid: this.streamSid, start: {
          accountSid: 'ACtest', streamSid: this.streamSid, callSid: this.callSid, tracks: ['inbound'],
          customParameters: { callId: this.callId, secret: this.secret },
          mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 } } });
        this.t0 = Date.now();
        this.tick(0);
        resolve();
      });
      this.ws.on('message', (d) => this.onMsg(JSON.parse(d.toString())));
      this.ws.on('close', () => { this.closed = true; });
      this.ws.on('error', reject);
    });
  }
  send(o) { if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(o)); }
  now() { return Date.now() - this.t0; }
  say(buf) { // Gegenüber spricht
    this.agentSpokeSinceCallee = false;
    for (let i = 0; i < buf.length; i += FRAME) {
      const f = Buffer.alloc(FRAME, 0xff); buf.copy(f, 0, i, Math.min(i + FRAME, buf.length)); this.calleeQueue.push(f);
    }
  }
  clearCallee() { this.calleeQueue = []; }
  onMsg(m) {
    if (m.event === 'media') {
      const buf = Buffer.from(m.media.payload, 'base64');
      for (let i = 0; i < buf.length; i += FRAME) this.playQueue.push({ buf: buf.subarray(i, i + FRAME) });
    } else if (m.event === 'mark') {
      this.playQueue.push({ mark: m.mark.name });
    } else if (m.event === 'clear') {
      this.clears++;
      const marks = this.playQueue.filter((x) => x.mark);
      this.playQueue = [];
      for (const x of marks) this.send({ event: 'mark', streamSid: this.streamSid, mark: { name: x.mark } });
    }
  }
  tick(n) {
    if (this.closed) return;
    // Gegenüber -> Bridge
    const f = this.calleeQueue.shift() || SILENCE;
    const loud = frameRms(f) > LOUD;
    if (loud) { this.lastCalleeLoud = Date.now(); this.calleeSpeaking = true; }
    else if (this.calleeSpeaking && this.calleeQueue.length === 0 && Date.now() - this.lastCalleeLoud > 200) {
      this.calleeSpeaking = false; this.awaitingAgent = true; this.calleeEndWall = this.lastCalleeLoud;
    }
    this.send({ event: 'media', sequenceNumber: String(++this.seq), streamSid: this.streamSid,
      media: { track: 'inbound', chunk: String(++this.chunk), timestamp: String(n * 20), payload: f.toString('base64') } });
    this.recCallee.push(...f);
    // Agent-Wiedergabe
    let played = null;
    while (this.playQueue.length && this.playQueue[0].mark) {
      this.send({ event: 'mark', streamSid: this.streamSid, mark: { name: this.playQueue.shift().mark } });
    }
    if (this.playQueue.length) played = this.playQueue.shift().buf;
    const pf = played && played.length === FRAME ? played : SILENCE;
    this.recAgent.push(...pf);
    if (frameRms(pf) > LOUD) {
      this.lastAgentLoud = Date.now(); this.agentSpokeSinceCallee = true;
      if (this.agentFirstLoudAt == null) this.agentFirstLoudAt = this.now();
      if (this.awaitingAgent) {
        this.awaitingAgent = false;
        this.clientLatencies.push({ atMs: this.now(), ms: Date.now() - this.calleeEndWall });
      }
    }
    this.onAgentFrame(pf);
    const next = this.t0 + (n + 1) * 20;
    setTimeout(() => this.tick(n + 1), Math.max(0, next - Date.now()));
  }
  hangup() { // wie Twilio nach REST status=completed
    if (this.closed) return;
    this.send({ event: 'stop', sequenceNumber: String(++this.seq), streamSid: this.streamSid, stop: { callSid: this.callSid } });
    setTimeout(() => { this.closed = true; try { this.ws.close(); } catch {} }, 100);
  }
}

/** Zweite xAI-Realtime-Sitzung als simuliertes Gegenüber (Rezeptionistin) */
export class XaiPeer {
  constructor({ instructions, voice = 'ara', onAudio, onClear, log }) {
    Object.assign(this, { instructions, voice, onAudio, onClear, log: log || (() => {}) });
    this.transcript = []; this.ready = false;
  }
  connect() {
    return new Promise((resolve, reject) => {
      this.openWall = Date.now();
      this.ws = new WebSocket('wss://api.x.ai/v1/realtime?model=grok-voice-think-fast-2.0', { headers: { Authorization: `Bearer ${process.env.XAI_API_KEY}` } });
      this.ws.on('open', () => this.ws.send(JSON.stringify({ type: 'session.update', session: {
        instructions: this.instructions, voice: this.voice, turn_detection: { type: 'server_vad' }, reasoning: { effort: 'none' },
        audio: { input: { format: { type: 'audio/pcmu' }, transcription: { language_hint: 'de' } }, output: { format: { type: 'audio/pcmu' } } } } })));
      this.ws.on('message', (d) => {
        const e = JSON.parse(d.toString());
        if (e.type === 'session.updated' && !this.ready) { this.ready = true; resolve(); }
        else if (e.type === 'response.output_audio.delta' || e.type === 'response.audio.delta') this.onAudio(Buffer.from(e.delta, 'base64'));
        else if (e.type === 'response.output_audio_transcript.done') this.transcript.push(e.transcript);
        else if (e.type === 'input_audio_buffer.speech_started') this.onClear?.();
        else if (e.type === 'error') this.log('peer error', JSON.stringify(e.error).slice(0, 200));
      });
      this.ws.on('error', reject);
      this.ws.on('close', () => { usage.peerSessionMs += Date.now() - this.openWall; this.closedFlag = true; });
    });
  }
  hear(frame) { if (this.ready && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: frame.toString('base64') })); }
  force(text) { usage.peerText = (usage.peerText || 0) + 1; this.ws.send(JSON.stringify({ type: 'conversation.item.create', item: { type: 'force_message', role: 'assistant', content: [{ type: 'output_text', text }] } })); }
  close() { try { this.ws.close(); } catch {} }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// wartet, bis der Agent geantwortet hat und wieder still ist
export async function waitAgentTurnDone(fake, { quietMs = 1200, timeoutMs = 45000 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fake.closed) return 'closed';
    if (fake.agentSpokeSinceCallee && fake.playQueue.length === 0 && Date.now() - fake.lastAgentLoud > quietMs) return 'done';
    await sleep(100);
  }
  return 'timeout';
}
