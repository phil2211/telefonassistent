// Zentrale Konfiguration. Alles über Umgebungsvariablen (keine .env-Datei).
// Secrets werden nie geloggt.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const env = (k, d) => (process.env[k] !== undefined && process.env[k] !== '' ? process.env[k] : d);
const num = (k, d) => Number(env(k, d));

export const config = {
  host: env('HOST', '127.0.0.1'),
  port: num('PORT', 8787),
  publicUrl: (env('PUBLIC_URL', '') || '').replace(/\/+$/, ''),

  principalName: env('PRINCIPAL_NAME', 'Philip Eschenbacher'),
  timezone: env('TZ_CALLS', 'Europe/Zurich'),

  xaiModel: env('XAI_MODEL', 'grok-voice-think-fast-2.0'),
  // "high" (xAI-Default) gewählt: gleiche Latenz wie "none" im Test, hält Reihenfolge-Regeln besser ein (siehe README)
  xaiReasoning: env('XAI_REASONING', 'high'),
  xaiVoice: env('XAI_VOICE', 'rex'),
  vadSilenceMs: num('VAD_SILENCE_MS', 0), // 0 = Server-Default
  vadThreshold: num('VAD_THRESHOLD', 0), // 0 = Server-Default

  bargeInConfirmMs: num('BARGE_IN_CONFIRM_MS', 600), // kurze Einwürfe ("ja", "gerne") unterbrechen den Agenten nicht
  silencePromptMs: num('SILENCE_PROMPT_MS', 5000),
  silenceGiveUpMs: num('SILENCE_GIVEUP_MS', 12000),
  maxCallSeconds: num('MAX_CALL_SECONDS', 480),
  ringTimeoutSeconds: num('RING_TIMEOUT_SECONDS', 30),
  finalizeWaitMs: num('FINALIZE_WAIT_MS', 15000), // auf Twilio-Status 'completed' warten

  // Erlaubte Zielnummern-Präfixe (Schutz gegen Fehlbedienung / Missbrauch)
  allowedToPrefixes: env('ALLOWED_TO_PREFIXES', '+41').split(',').map((s) => s.trim()).filter(Boolean),
  allowRemoteCall: env('ALLOW_REMOTE_CALL', '0') === '1',

  twilioFrom: env('TWILIO_FROM_NUMBER', ''),
  callsDir: env('CALLS_DIR', path.join(ROOT, 'calls')),
  skipTwilioSignature: env('SKIP_TWILIO_SIGNATURE', '0') === '1',

  prices: {
    xaiPerMin: num('PRICE_XAI_PER_MIN', 0.08),
    xaiPerTextMsg: num('PRICE_XAI_PER_TEXT_MSG', 0.004),
    twilioChMobilePerMin: num('PRICE_TWILIO_CH_MOBILE', 0.1802),
    twilioChLandlinePerMin: num('PRICE_TWILIO_CH_LANDLINE', 0.0419),
    twilioStreamPerMin: num('PRICE_TWILIO_STREAM', 0.0044),
  },
};

// Secrets nur über Getter, damit sie nicht versehentlich mit config geloggt werden.
export const secrets = {
  get xaiKey() { return process.env.XAI_API_KEY || ''; },
  get twilioSid() { return process.env.TWILIO_ACCOUNT_SID || ''; },
  get twilioToken() { return process.env.TWILIO_AUTH_TOKEN || ''; },
};

// CALL_API_TOKEN: aus Env oder aus 0600-Datei im Projekt; wird beim ersten Start erzeugt.
export const TOKEN_FILE = path.join(ROOT, '.call_api_token');
export function loadCallApiToken() {
  if (process.env.CALL_API_TOKEN) return process.env.CALL_API_TOKEN;
  if (!fs.existsSync(TOKEN_FILE)) {
    fs.writeFileSync(TOKEN_FILE, crypto.randomBytes(32).toString('hex') + '\n', { mode: 0o600 });
  }
  fs.chmodSync(TOKEN_FILE, 0o600);
  return fs.readFileSync(TOKEN_FILE, 'utf8').trim();
}
