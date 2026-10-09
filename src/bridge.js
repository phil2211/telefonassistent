// Brücke: Twilio Media Stream (µ-law 8 kHz) <-> xAI Grok Realtime (audio/pcmu)
// - xAI-Sitzung wird erst bei Twilio "start" (= abgenommen) geöffnet
// - KEIN response.create beim Verbindungsaufbau: der Agent wartet auf das Gegenüber
// - eigener 5-s-Stille-Timer ("Bin ich richtig verbunden mit ...?")
// - Barge-in: Twilio "clear" + conversation.item.truncate
// - end_call: Verabschiedung fertig abspielen (Twilio mark), dann auflegen
import WebSocket from 'ws';
import { config, secrets } from './config.js';
import { buildInstructions, END_CALL_TOOL, silencePromptText, SILENCE_GIVEUP_TEXT, FALLBACK_GOODBYE_TEXT } from './prompt.js';

const b64bytes = (s) => Math.floor((s.length * 3) / 4) - (s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0);
const GOODBYE_RE = /(wiederh[öo]ren|wiedersehen|tsch[üu]ss|adieu|sch[öo]nen tag|sch[öo]nen abend)/i;
const FORBIDDEN_RE = /wie kann ich (ihnen|dir) (behilflich sein|helfen)/i;

export class CallBridge {
  /**
   * @param {object} o
   * @param {WebSocket} o.twilioWs  WebSocket der Twilio-Media-Stream-Verbindung (oder Fake im Test)
   * @param {object} o.call  { callId, to, targetName, task, contact }
   * @param {(callSid:string)=>Promise<any>} o.hangup  legt den Anruf auf (Twilio REST)
   * @param {(rec:object)=>void} o.onDone
   * @param {object} [o.overrides]  z.B. { reasoning, model, silencePromptMs } für Tests
   */
  constructor({ twilioWs, call, hangup, onDone, overrides = {}, log }) {
    this.tw = twilioWs;
    this.call = call;
    this.hangupFn = hangup;
    this.onDone = onDone;
    this.opt = {
      model: overrides.model || config.xaiModel,
      reasoning: overrides.reasoning || config.xaiReasoning,
      voice: overrides.voice || config.xaiVoice,
      silencePromptMs: overrides.silencePromptMs ?? config.silencePromptMs,
      silenceGiveUpMs: overrides.silenceGiveUpMs ?? config.silenceGiveUpMs,
      maxCallSeconds: overrides.maxCallSeconds ?? config.maxCallSeconds,
    };
    this.tag = `[${(call.callId || '').slice(0, 8)}]`;
    this.log = log || ((...a) => console.log(new Date().toISOString(), this.tag, ...a));

    this.streamSid = null;
    this.callSid = call.callSid || null;
    this.xai = null;
    this.xaiReady = false;
    this.pendingAudio = []; // vor session.updated empfangenes Audio
    this.inMs = 0; // an xAI gesendete Eingangs-Audiodauer (ms)
    this.inTimeline = []; // [{endMs, wall}] Empfangszeit je Twilio-Chunk
    this.playoutEndWall = 0; // geschätztes Ende der Wiedergabe beim Gegenüber
    this.resp = null; // aktuelle Antwort
    this.responses = new Map();
    this.endCallRejects = 0;
    this.endScheduled = false;
    this.lastAudioDeltaWall = 0;
    this.curItem = null; // { id, bytes }
    this.marks = new Set();
    this.markSeq = 0;
    this.calleeHasSpoken = false;
    this.speechStartWall = {}; // item_id -> wall
    this.pendingTurn = null; // für Latenzmessung
    this.endPhase = false; // Verabschiedung läuft / end_call angefordert
    this.endMark = null;
    this.hungUp = false;
    this.finished = false;
    this.timers = {};
    this.maxWarnPending = false;

    this.rec = {
      callId: call.callId, to: call.to, targetName: call.targetName, task: call.task,
      contactFieldsProvided: Object.keys(call.contact || {}).filter((k) => call.contact[k]),
      model: this.opt.model, reasoning: this.opt.reasoning, voice: this.opt.voice,
      answeredAt: null, streamMs: 0, xaiSessionMs: 0, textMsgCount: 0,
      transcript: [], latencies: [], events: [],
      checks: { agentSpokeFirst: false, silencePromptFired: false, forbiddenPhrase: false, introducedAsAssistant: false },
      endCall: null, hangupReason: null,
    };
  }

  t() { return Date.now() - (this.t0 || Date.now()); }
  ev(type, extra = {}) { this.rec.events.push({ tMs: this.t(), type, ...extra }); }
  addTranscript(speaker, text, tMs) {
    if (!text || !text.trim()) return;
    this.rec.transcript.push({ tMs: tMs ?? this.t(), speaker, text: text.trim() });
  }

  // ---------- Twilio-Seite ----------
  handleTwilio(msg) {
    switch (msg.event) {
      case 'start': return this.onStart(msg);
      case 'media': return this.onMedia(msg);
      case 'mark': return this.onMark(msg.mark?.name);
      case 'stop': this.ev('twilio_stop'); this.rec.hangupReason ||= 'gegenueber_aufgelegt'; return this.finish();
      default: return undefined;
    }
  }

  sendTwilio(obj) {
    if (this.tw.readyState === WebSocket.OPEN) this.tw.send(JSON.stringify(obj));
  }

  onStart(msg) {
    this.streamSid = msg.start?.streamSid || msg.streamSid;
    this.callSid = msg.start?.callSid || this.callSid;
    this.t0 = Date.now();
    this.rec.answeredAt = new Date(this.t0).toISOString();
    this.rec.callSid = this.callSid;
    this.ev('stream_start');
    this.log('Stream gestartet (abgenommen), öffne xAI-Sitzung');
    this.openXai();
    this.timers.silence = setTimeout(() => this.onSilencePrompt(), this.opt.silencePromptMs);
    const max = this.opt.maxCallSeconds * 1000;
    this.timers.maxWarn = setTimeout(() => this.onMaxWarn(), Math.max(0, max - 30000));
    this.timers.maxHard = setTimeout(() => this.hangup('max_dauer'), max);
  }

  onMedia(msg) {
    if (msg.media?.track && msg.media.track !== 'inbound') return;
    const payload = msg.media?.payload;
    if (!payload) return;
    const bytes = b64bytes(payload); // 8 Bytes = 1 ms
    if (this.xaiReady) this.appendAudio(payload, bytes, Date.now());
    else this.pendingAudio.push({ payload, bytes, wall: Date.now() });
  }

  appendAudio(payload, bytes, wall) {
    this.inMs += bytes / 8;
    this.inTimeline.push({ endMs: this.inMs, wall });
    this.sendXai({ type: 'input_audio_buffer.append', audio: payload });
  }

  wallForInputMs(ms) {
    // Empfangszeit des Chunks, der die Eingangsposition ms enthält
    const tl = this.inTimeline;
    let lo = 0; let hi = tl.length - 1;
    if (hi < 0) return null;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (tl[mid].endMs < ms) lo = mid + 1; else hi = mid; }
    const c = tl[lo];
    return c.wall - (c.endMs - ms); // innerhalb des Chunks interpolieren
  }

  sendMark(prefix) {
    const name = `${prefix}-${++this.markSeq}`;
    this.marks.add(name);
    this.sendTwilio({ event: 'mark', streamSid: this.streamSid, mark: { name } });
    return name;
  }

  onMark(name) {
    if (!name) return;
    this.marks.delete(name);
    if (this.endMark && name === this.endMark) {
      this.log('Verabschiedung fertig abgespielt, lege auf');
      setTimeout(() => this.hangup(this.rec.hangupReason || 'end_call'), 300);
    }
    if (name.startsWith('resp-') && this.marks.size === 0 && !this.endPhase && this.resp == null) {
      this.ev('agent_playback_done');
    }
  }

  agentAudible() { return this.playoutEndWall > Date.now() + 40; }

  // ---------- xAI-Seite ----------
  openXai() {
    const url = `wss://api.x.ai/v1/realtime?model=${encodeURIComponent(this.opt.model)}`;
    this.xaiOpenWall = Date.now();
    const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${secrets.xaiKey}` } });
    this.xai = ws;
    ws.on('open', () => {
      this.ev('xai_open', { connectMs: Date.now() - this.xaiOpenWall });
      const session = {
        instructions: buildInstructions({ targetName: this.call.targetName, task: this.call.task, contact: this.call.contact }),
        voice: this.opt.voice,
        turn_detection: { type: 'server_vad' },
        audio: {
          input: {
            format: { type: 'audio/pcmu' },
            transcription: { language_hint: 'de', keyterms: [this.call.targetName, config.principalName].filter(Boolean).map((s) => s.slice(0, 50)) },
          },
          output: { format: { type: 'audio/pcmu' } },
        },
        tools: [END_CALL_TOOL],
        reasoning: { effort: this.opt.reasoning },
      };
      if (config.vadSilenceMs) session.turn_detection.silence_duration_ms = config.vadSilenceMs;
      if (config.vadThreshold) session.turn_detection.threshold = config.vadThreshold;
      // Bewusst KEIN response.create: der Agent spricht erst nach dem Gegenüber.
      this.sendXai({ type: 'session.update', session });
    });
    ws.on('message', (data) => {
      let e; try { e = JSON.parse(data.toString()); } catch { return; }
      this.onXai(e);
    });
    ws.on('error', (err) => { this.log('xAI-Fehler:', err.message); this.ev('xai_error', { message: err.message }); });
    ws.on('close', (code) => {
      this.xaiCloseWall = Date.now();
      this.ev('xai_close', { code });
      if (!this.finished && !this.hungUp) {
        this.log('xAI-Sitzung unerwartet geschlossen', code);
        this.hangup('xai_getrennt');
      }
    });
  }

  sendXai(obj) {
    if (this.xai && this.xai.readyState === WebSocket.OPEN) {
      if (obj.type === 'conversation.item.create' && obj.item?.type !== 'function_call_output') this.rec.textMsgCount++;
      this.xai.send(JSON.stringify(obj));
    }
  }

  onXai(e) {
    switch (e.type) {
      case 'session.updated': {
        if (this.xaiReady) return;
        this.xaiReady = true;
        const fmt = e.session?.audio?.output?.format?.type;
        this.ev('xai_ready', { outputFormat: fmt, sinceStartMs: this.t() });
        this.log(`xAI bereit nach ${this.t()} ms (output ${fmt}), sende ${this.pendingAudio.length} gepufferte Chunks`);
        for (const c of this.pendingAudio) this.appendAudio(c.payload, c.bytes, c.wall);
        this.pendingAudio = [];
        if (this.silencePromptDue) this.onSilencePrompt();
        return;
      }
      case 'input_audio_buffer.speech_started': {
        this.speechStartWall[e.item_id] = Date.now();
        this.pendingTurn = null;
        if (!this.calleeHasSpoken) {
          this.calleeHasSpoken = true;
          clearTimeout(this.timers.silence);
          clearTimeout(this.timers.giveUp);
        }
        this.ev('callee_speech_started', { audio_start_ms: e.audio_start_ms });
        // Barge-in erst bestätigen: kurze Einwürfe ("ja", "gerne") sollen den Agenten nicht abwürgen
        clearTimeout(this.timers.bargeIn);
        if (this.agentAudible() && !this.endPhase) {
          this.timers.bargeIn = setTimeout(() => this.bargeIn(), config.bargeInConfirmMs);
        } else this.bargeIn();
        return;
      }
      case 'input_audio_buffer.speech_stopped': {
        const now = Date.now();
        const endMs = e.audio_end_ms;
        const speechEndWall = Number.isFinite(endMs) ? this.wallForInputMs(endMs) : null;
        if (this.timers.bargeIn) { clearTimeout(this.timers.bargeIn); this.timers.bargeIn = null; this.ev('backchannel_ignored'); }
        this.pendingTurn = { speechStoppedWall: now, speechEndWall, itemId: e.item_id };
        this.ev('callee_speech_stopped', { audio_end_ms: endMs, vadDelayMs: speechEndWall ? now - speechEndWall : null });
        return;
      }
      case 'conversation.item.input_audio_transcription.completed': {
        const w = this.speechStartWall[e.item_id];
        this.addTranscript('Gegenüber', e.transcript, w ? w - this.t0 : undefined);
        return;
      }
      case 'response.created': {
        const r = { id: e.response?.id, hadAudio: false, firstAudioWall: null, transcript: '', startT: this.t(), done: false, transcriptAdded: false };
        this.responses.set(r.id, r);
        this.resp = r;
        return;
      }
      case 'response.output_item.added': {
        if (e.item?.type === 'message') this.curItem = { id: e.item.id, bytes: 0 };
        return;
      }
      case 'response.output_audio.delta':
      case 'response.audio.delta': {
        if (!e.delta) return;
        const now = Date.now();
        this.lastAudioDeltaWall = now;
        const r = this.respFor(e.response_id);
        if (!this.curItem || (e.item_id && this.curItem.id !== e.item_id)) this.curItem = { id: e.item_id, bytes: 0 };
        if (!r.hadAudio) {
          r.hadAudio = true;
          r.firstAudioWall = now;
          r.startT = this.t();
          if (!this.calleeHasSpoken && !this.rec.checks.silencePromptFired) this.rec.checks.agentSpokeFirst = true;
          if (this.pendingTurn) {
            const lat = {
              turn: this.rec.latencies.length + 1,
              tMs: this.t(),
              speechEndToAudioMs: this.pendingTurn.speechEndWall ? Math.round(now - this.pendingTurn.speechEndWall) : null,
              vadStopToAudioMs: now - this.pendingTurn.speechStoppedWall,
            };
            this.rec.latencies.push(lat);
            this.log(`Latenz Turn ${lat.turn}: ${lat.speechEndToAudioMs} ms (ab VAD-Stopp ${lat.vadStopToAudioMs} ms)`);
            this.pendingTurn = null;
          }
        }
        const bytes = b64bytes(e.delta);
        this.curItem.bytes += bytes;
        this.playoutEndWall = Math.max(now, this.playoutEndWall) + bytes / 8;
        this.sendTwilio({ event: 'media', streamSid: this.streamSid, media: { payload: e.delta } });
        return;
      }
      case 'response.output_audio_transcript.delta': {
        this.respFor(e.response_id).transcript += e.delta || '';
        return;
      }
      case 'response.output_audio_transcript.done': {
        const r = this.respFor(e.response_id);
        r.transcript = e.transcript ?? r.transcript;
        r.transcriptDone = true;
        if (!r.transcriptAdded) { r.transcriptAdded = true; this.onAgentText(r.transcript, r.startT); }
        return;
      }
      case 'response.function_call_arguments.done': {
        if (e.name === 'end_call') {
          let args = {}; try { args = JSON.parse(e.arguments || '{}'); } catch { /* ignore */ }
          this.respFor(e.response_id).endCall = { call_id: e.call_id, args };
        }
        return;
      }
      case 'response.done': {
        const r = this.respFor(e.response?.id);
        const status = e.response?.status;
        r.done = true;
        this.ev('response_done', { status, hadAudio: r.hadAudio, usage: e.response?.usage });
        if (this.resp === r) this.resp = null;
        if (r.hadAudio) this.sendMark('resp');
        // Transkript nachtragen, falls kein transcript.done kommt (z.B. abgebrochen)
        setTimeout(() => {
          if (!r.transcriptAdded && r.transcript) { r.transcriptAdded = true; this.onAgentText(r.transcript + (status === 'cancelled' ? ' […]' : ''), r.startT); }
        }, 1500);
        if (r.endCall) this.onEndCall(r);
        else if (this.endPhase && !this.endScheduled) this.scheduleEndAfterAudio();
        else if (this.maxWarnPending) { this.maxWarnPending = false; this.sendXai({ type: 'response.create' }); }
        return;
      }
      case 'conversation.item.truncated':
        this.ev('truncated', { item_id: e.item_id, audio_end_ms: e.audio_end_ms });
        return;
      case 'error':
        this.log('xAI error event:', JSON.stringify(e.error || e).slice(0, 300));
        this.ev('xai_error_event', { error: e.error || e });
        return;
      default:
    }
  }

  respFor(id) {
    if (id && this.responses.has(id)) return this.responses.get(id);
    if (this.resp && (!id || this.resp.id === id)) return this.resp;
    const r = { id, hadAudio: false, transcript: '', startT: this.t(), done: false, transcriptAdded: false };
    if (id) this.responses.set(id, r);
    return r;
  }

  // end_call nur akzeptieren, wenn sich der Agent hörbar verabschiedet hat (Regel 9)
  onEndCall(r) {
    const { call_id: callId, args } = r.endCall;
    const text = r.transcript || this.lastAgentText || '';
    const saidGoodbye = GOODBYE_RE.test(text) && r.hadAudio;
    if (!saidGoodbye && this.endCallRejects < 1) {
      this.endCallRejects++;
      this.ev('end_call_rejected', { status: args.status });
      this.log('end_call ohne Verabschiedung -> Agent soll erst zusammenfassen und sich verabschieden');
      this.sendXai({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: callId,
        output: JSON.stringify({ ok: false, error: 'Noch nicht aufgelegt: Du hast dich noch nicht verabschiedet. Fasse jetzt in ein bis zwei Sätzen das Ergebnis zusammen, bedanke dich, sag "Auf Wiederhören" und rufe danach end_call erneut auf.' }) } });
      this.sendXai({ type: 'response.create' });
      return;
    }
    this.rec.endCall = { status: args.status, summary: args.summary, tMs: this.t() };
    this.log('end_call:', args.status);
    this.ev('end_call', args);
    this.addTranscript('System', `end_call (${args.status || '-'})`);
    this.sendXai({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: callId, output: JSON.stringify({ ok: true, info: 'Anruf wird beendet.' }) } });
    this.endPhase = true;
    this.rec.hangupReason = 'end_call';
    if (!saidGoodbye) { this.log('Standard-Verabschiedung'); this.forceSay(FALLBACK_GOODBYE_TEXT, false); }
    this.scheduleEndAfterAudio();
  }

  // wartet, bis xAI kein Audio mehr liefert, setzt dann einen Twilio-mark und legt nach dessen Wiedergabe auf
  scheduleEndAfterAudio() {
    if (this.endScheduled) return;
    this.endScheduled = true;
    const startWait = Date.now();
    const poll = () => {
      const idle = Date.now() - (this.lastAudioDeltaWall || 0);
      if ((this.resp || idle < 800) && Date.now() - startWait < 10000) { this.timers.endPoll = setTimeout(poll, 100); return; }
      this.endMark = this.sendMark('end');
      const remain = Math.max(0, this.playoutEndWall - Date.now());
      this.timers.endFallback = setTimeout(() => this.hangup(this.rec.hangupReason || 'end_call'), remain + 3000);
    };
    this.timers.endPoll = setTimeout(poll, 300);
  }

  onAgentText(text, startT) {
    if (!text) return;
    this.lastAgentText = text;
    this.addTranscript('Agent', text, startT);
    if (FORBIDDEN_RE.test(text)) this.rec.checks.forbiddenPhrase = true;
    if (new RegExp(`assistent(in)? von ${config.principalName.split(' ')[0]}`, 'i').test(text)) this.rec.checks.introducedAsAssistant = true;
  }

  bargeIn() {
    this.timers.bargeIn = null;
    if (this.endPhase) return; // Verabschiedung nicht abwürgen
    const audible = this.agentAudible();
    if (!audible && !this.resp) return;
    const now = Date.now();
    this.ev('barge_in', { audible, responseActive: !!this.resp });
    if (audible) {
      this.sendTwilio({ event: 'clear', streamSid: this.streamSid });
      if (this.curItem && this.curItem.bytes > 0) {
        const sentMs = this.curItem.bytes / 8;
        const unplayed = Math.max(0, this.playoutEndWall - now);
        const played = Math.max(0, Math.floor(sentMs - unplayed));
        this.sendXai({ type: 'conversation.item.truncate', item_id: this.curItem.id, content_index: 0, audio_end_ms: played });
      }
      this.playoutEndWall = now;
    }
    if (this.resp) this.sendXai({ type: 'response.cancel' });
  }

  forceSay(text, interruptible = true) {
    this.sendXai({
      type: 'conversation.item.create',
      item: { type: 'force_message', role: 'assistant', interruptible, content: [{ type: 'output_text', text }] },
    });
  }

  onSilencePrompt() {
    if (this.calleeHasSpoken || this.endPhase || this.hungUp) return;
    if (!this.xaiReady) { this.silencePromptDue = true; return; }
    this.silencePromptDue = false;
    this.rec.checks.silencePromptFired = true;
    this.ev('silence_prompt');
    this.log('5 s Stille: frage nach, ob richtig verbunden');
    this.forceSay(silencePromptText(this.call.targetName));
    this.timers.giveUp = setTimeout(() => {
      if (this.calleeHasSpoken || this.endPhase) return;
      this.ev('silence_giveup');
      this.endPhase = true;
      this.rec.hangupReason = 'keine_antwort';
      this.forceSay(SILENCE_GIVEUP_TEXT, false);
    }, this.opt.silenceGiveUpMs);
  }

  onMaxWarn() {
    if (this.endPhase || this.hungUp) return;
    this.ev('max_warn');
    this.sendXai({
      type: 'conversation.item.create',
      item: { type: 'message', role: 'system', content: [{ type: 'input_text', text: 'Die maximale Gesprächsdauer ist fast erreicht. Fasse jetzt in einem Satz zusammen, bedanke dich, verabschiede dich und rufe danach end_call auf.' }] },
    });
    if (this.resp || this.agentAudible()) this.maxWarnPending = true;
    else this.sendXai({ type: 'response.create' });
  }

  async hangup(reason) {
    if (this.hungUp) return;
    this.hungUp = true;
    this.rec.hangupReason = this.rec.hangupReason || reason;
    if (reason === 'max_dauer') this.rec.hangupReason = 'max_dauer';
    this.ev('hangup', { reason });
    this.log('Lege auf:', reason);
    try { if (this.callSid) await this.hangupFn(this.callSid); } catch (err) { this.log('Auflegen fehlgeschlagen:', err.message); }
    // Twilio schickt danach "stop" und schliesst den WS; Sicherheitsnetz:
    setTimeout(() => this.finish(), 4000);
  }

  finish() {
    if (this.finished) return;
    this.finished = true;
    Object.values(this.timers).forEach((t) => clearTimeout(t));
    const now = Date.now();
    this.rec.streamMs = this.t0 ? now - this.t0 : 0;
    try { if (this.xai && this.xai.readyState <= WebSocket.OPEN) this.xai.close(); } catch { /* ignore */ }
    this.rec.xaiSessionMs = this.xaiOpenWall ? (this.xaiCloseWall || now) - this.xaiOpenWall : 0;
    this.rec.transcript.sort((a, b) => a.tMs - b.tMs);
    try { if (this.tw.readyState === WebSocket.OPEN) this.tw.close(); } catch { /* ignore */ }
    this.log(`Anruf beendet (${this.rec.hangupReason}), Dauer ${Math.round(this.rec.streamMs / 1000)} s`);
    this.onDone?.(this.rec);
  }
}
