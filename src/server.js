// HTTP + WebSocket-Server: POST /call, POST /twiml, POST /status, WS /media
import http from 'node:http';
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';
import { config, secrets, loadCallApiToken } from './config.js';
import { createCall, hangupCall, validateTwilioSignature } from './twilio.js';
import { CallBridge } from './bridge.js';
import { writeReport } from './report.js';

const E164 = /^\+[1-9]\d{6,14}$/;
const log = (...a) => console.log(new Date().toISOString(), ...a);
const xmlEsc = (s) => String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
const maskNum = (n) => (n ? String(n).replace(/(\+\d{4})\d+(\d{2})/, '$1•••$2') : n);

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'Content-Type': type });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}
function tokenOk(req, token) {
  const h = req.headers.authorization || '';
  const got = h.startsWith('Bearer ') ? h.slice(7) : (req.headers['x-call-token'] || '');
  const a = Buffer.from(String(got)); const b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const viaTunnel = (req) => Boolean(req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.headers['cf-ray']);

export function createApp({ hangup = hangupCall, bridgeOverrides = {}, onReport } = {}) {
  const callApiToken = loadCallApiToken();
  const calls = new Map(); // callId -> call

  function finalize(call) {
    if (call.reportDir || !call.rec) return;
    clearTimeout(call.finalizeTimer);
    const rec = { ...call.rec, twilioStatus: call.status, twilioDurationSec: call.twilioDurationSec };
    call.reportDir = writeReport(rec);
    log(`[${call.callId.slice(0, 8)}] Auswertung gespeichert: ${call.reportDir}`);
    onReport?.(call.reportDir, rec);
  }

  function registerCall(data) {
    const call = { ...data, callId: data.callId || crypto.randomUUID(), secret: crypto.randomBytes(16).toString('hex'), status: 'created', createdAt: Date.now() };
    calls.set(call.callId, call);
    return call;
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://local');
    try {
      if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true });

      // --- Auftraggeber-API (geschützt) ---
      if (url.pathname === '/call' || url.pathname.startsWith('/calls/')) {
        if (viaTunnel(req) && !config.allowRemoteCall) return send(res, 403, { error: 'nur lokal erlaubt' });
        if (!tokenOk(req, callApiToken)) return send(res, 401, { error: 'unauthorized' });
      }
      if (req.method === 'POST' && url.pathname === '/call') {
        let b; try { b = JSON.parse(await readBody(req)); } catch { return send(res, 400, { error: 'JSON erwartet' }); }
        const { to, target_name: targetName, task, contact } = b || {};
        if (!E164.test(to || '')) return send(res, 400, { error: 'to muss E.164 sein, z.B. +41791234567' });
        if (!config.allowedToPrefixes.some((p) => to.startsWith(p))) return send(res, 400, { error: `Zielnummer nicht erlaubt (ALLOWED_TO_PREFIXES=${config.allowedToPrefixes.join(',')})` });
        if (!targetName || !task) return send(res, 400, { error: 'target_name und task sind Pflicht' });
        if (contact && typeof contact !== 'object') return send(res, 400, { error: 'contact muss ein Objekt {phone,email,postal} sein' });
        if (!config.publicUrl.startsWith('https://')) return send(res, 500, { error: 'PUBLIC_URL (https) fehlt' });
        if (!config.twilioFrom) return send(res, 500, { error: 'TWILIO_FROM_NUMBER fehlt' });
        if (!secrets.twilioSid || !secrets.twilioToken) return send(res, 500, { error: 'Twilio-Zugang fehlt' });
        const cleanContact = contact ? { phone: contact.phone || undefined, email: contact.email || undefined, postal: contact.postal || undefined } : {};
        const call = registerCall({ to, targetName, task, contact: cleanContact });
        try {
          const tw = await createCall({
            to, from: config.twilioFrom,
            twimlUrl: `${config.publicUrl}/twiml?callId=${call.callId}`,
            statusUrl: `${config.publicUrl}/status?callId=${call.callId}`,
            timeLimit: config.maxCallSeconds + 60, timeout: config.ringTimeoutSeconds,
          });
          call.callSid = tw.sid; call.status = tw.status;
          log(`[${call.callId.slice(0, 8)}] Anruf gestartet an ${maskNum(to)} (${targetName}) sid=${tw.sid}`);
          return send(res, 200, { callId: call.callId, callSid: tw.sid, status: tw.status });
        } catch (err) {
          calls.delete(call.callId);
          log('Twilio createCall fehlgeschlagen:', err.message);
          return send(res, 502, { error: err.message });
        }
      }
      if (req.method === 'GET' && url.pathname.startsWith('/calls/')) {
        const c = calls.get(url.pathname.slice(7));
        if (!c) return send(res, 404, { error: 'unbekannt' });
        return send(res, 200, { callId: c.callId, status: c.status, durationSec: c.twilioDurationSec, reportDir: c.reportDir || null });
      }

      // --- Twilio-Webhooks (signiert) ---
      if (req.method === 'POST' && (url.pathname === '/twiml' || url.pathname === '/status')) {
        const raw = await readBody(req);
        const params = Object.fromEntries(new URLSearchParams(raw));
        const fullUrl = config.publicUrl + req.url;
        if (!validateTwilioSignature(fullUrl, params, req.headers['x-twilio-signature'])) {
          log('Ungültige Twilio-Signatur auf', url.pathname);
          return send(res, 403, { error: 'bad signature' });
        }
        const call = calls.get(url.searchParams.get('callId') || '');
        if (url.pathname === '/twiml') {
          if (!call) return send(res, 200, '<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>', 'text/xml');
          const wss = config.publicUrl.replace(/^https:/, 'wss:') + '/media';
          const xml = `<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Stream url="${xmlEsc(wss)}">`
            + `<Parameter name="callId" value="${xmlEsc(call.callId)}"/><Parameter name="secret" value="${xmlEsc(call.secret)}"/>`
            + '</Stream></Connect></Response>';
          return send(res, 200, xml, 'text/xml');
        }
        // /status
        if (call) {
          call.status = params.CallStatus || call.status;
          if (params.CallDuration) call.twilioDurationSec = Number(params.CallDuration);
          log(`[${call.callId.slice(0, 8)}] Status: ${call.status}${params.CallDuration ? ` (${params.CallDuration} s)` : ''}`);
          if (['completed', 'busy', 'no-answer', 'failed', 'canceled'].includes(call.status)) {
            if (call.bridge && !call.rec) {
              // Stream läuft noch / wird gerade beendet: onDone() finalisiert
            } else if (!call.rec) {
              // nie abgenommen -> Mini-Auswertung
              call.rec = { callId: call.callId, to: call.to, targetName: call.targetName, task: call.task, answeredAt: new Date().toISOString(), streamMs: 0, xaiSessionMs: 0, textMsgCount: 0, transcript: [], latencies: [], checks: {}, endCall: null, hangupReason: `twilio_${call.status}` };
            }
            if (call.rec) finalize(call);
          }
        }
        return send(res, 204, '', 'text/plain');
      }
      return send(res, 404, { error: 'not found' });
    } catch (err) {
      log('Fehler:', err.message);
      return send(res, 500, { error: 'internal' });
    }
  }

  const server = http.createServer(handle);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });
  server.on('upgrade', (req, socket, head) => {
    if (new URL(req.url, 'http://local').pathname !== '/media') return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => onMediaConnection(ws));
  });

  function onMediaConnection(ws) {
    let bridge = null;
    const authTimer = setTimeout(() => { if (!bridge) ws.close(); }, 10000);
    ws.on('message', (data) => {
      let msg; try { msg = JSON.parse(data.toString()); } catch { return; }
      if (!bridge) {
        if (msg.event !== 'start') return;
        const p = msg.start?.customParameters || {};
        const call = calls.get(p.callId || '');
        const ok = call && p.secret && call.secret.length === String(p.secret).length
          && crypto.timingSafeEqual(Buffer.from(call.secret), Buffer.from(String(p.secret)));
        if (!ok || call.bridge) { log('Media-Stream abgelehnt (unbekannter Anruf/falsches Secret)'); return ws.close(); }
        clearTimeout(authTimer);
        call.callSid = msg.start.callSid || call.callSid;
        bridge = new CallBridge({
          twilioWs: ws, call, hangup, overrides: bridgeOverrides,
          onDone: (rec) => {
            call.rec = rec;
            // auf Twilio-Status "completed" (Dauer) warten, max. 15 s
            if (call.status === 'completed') finalize(call);
            else call.finalizeTimer = setTimeout(() => finalize(call), config.finalizeWaitMs);
          },
        });
        call.bridge = bridge;
      }
      bridge.handleTwilio(msg);
    });
    ws.on('close', () => { clearTimeout(authTimer); if (bridge && !bridge.finished) { bridge.rec.hangupReason ||= 'stream_geschlossen'; bridge.finish(); } });
  }

  return { server, calls, registerCall, finalize };
}

// Direkt gestartet
if (import.meta.url === `file://${process.argv[1]}`) {
  const { server } = createApp();
  server.listen(config.port, config.host, () => {
    log(`Telefonassistent läuft auf http://${config.host}:${config.port} (PUBLIC_URL=${config.publicUrl || '-'}, Modell ${config.xaiModel}, reasoning=${config.xaiReasoning}, Stimme ${config.xaiVoice})`);
    if (!secrets.xaiKey) log('WARNUNG: XAI_API_KEY fehlt');
    if (!config.twilioFrom) log('WARNUNG: TWILIO_FROM_NUMBER fehlt, POST /call ist deaktiviert');
  });
}
