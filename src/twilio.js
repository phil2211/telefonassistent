// Minimaler Twilio-REST-Client (ohne SDK) + Webhook-Signaturprüfung.
import crypto from 'node:crypto';
import { secrets, config } from './config.js';

const API = 'https://api.twilio.com/2010-04-01';

function authHeader() {
  return 'Basic ' + Buffer.from(`${secrets.twilioSid}:${secrets.twilioToken}`).toString('base64');
}

async function twilioPost(path, params) {
  const res = await fetch(`${API}/Accounts/${secrets.twilioSid}${path}`, {
    method: 'POST',
    headers: { Authorization: authHeader(), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 300) }; }
  if (!res.ok) {
    const err = new Error(`Twilio ${res.status}: ${body.message || body.raw || 'Fehler'} (code ${body.code ?? '-'})`);
    err.status = res.status; err.code = body.code;
    throw err;
  }
  return body;
}

export async function createCall({ to, from, twimlUrl, statusUrl, timeLimit, timeout }) {
  const params = new URLSearchParams();
  params.set('To', to);
  params.set('From', from);
  params.set('Url', twimlUrl);
  params.set('Method', 'POST');
  params.set('StatusCallback', statusUrl);
  params.set('StatusCallbackMethod', 'POST');
  for (const e of ['initiated', 'ringing', 'answered', 'completed']) params.append('StatusCallbackEvent', e);
  params.set('Timeout', String(timeout));
  params.set('TimeLimit', String(timeLimit)); // harte Obergrenze auf Twilio-Seite
  return twilioPost('/Calls.json', params);
}

export async function hangupCall(callSid) {
  return twilioPost(`/Calls/${encodeURIComponent(callSid)}.json`, { Status: 'completed' });
}

// https://www.twilio.com/docs/usage/webhooks/webhooks-security
export function validateTwilioSignature(fullUrl, params, signature) {
  if (config.skipTwilioSignature) return true;
  if (!signature || !secrets.twilioToken) return false;
  const data = fullUrl + Object.keys(params).sort().map((k) => k + params[k]).join('');
  const expected = crypto.createHmac('sha1', secrets.twilioToken).update(Buffer.from(data, 'utf8')).digest('base64');
  const a = Buffer.from(expected); const b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Schweizer Mobilnummern: +4175..+4179 (Rest: Festnetz-Tarif)
export function isChMobile(e164) { return /^\+417[5-9]\d{7}$/.test(e164 || ''); }
