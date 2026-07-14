// Local speech-to-text for Minty via whisper.cpp's whisper-server (PLAN.md-style
// adapter: this is the one place that knows about the whisper-cpp process).
// Whisper handles code-switched Chinese/English far better than the browser's
// Web Speech API, which locks the whole utterance to one BCP-47 language.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

const BIN = '/opt/homebrew/opt/whisper-cpp/bin/whisper-server';
const MODEL = join(os.homedir(), '.cache', 'personal-claude', 'ggml-large-v3-turbo.bin');
const HOST = '127.0.0.1';
const PORT = 8778;

let proc = null;
let starting = null;

export function whisperAvailable() {
  return existsSync(BIN) && existsSync(MODEL);
}

async function pingOnce() {
  try {
    const res = await fetch(`http://${HOST}:${PORT}/`, { signal: AbortSignal.timeout(1000) });
    return res.ok || res.status === 404;
  } catch {
    return false;
  }
}

async function ensureStarted() {
  if (await pingOnce()) return true; // already running (this process or a leftover one)
  if (starting) return starting;
  if (!whisperAvailable()) return false;
  starting = (async () => {
    proc = spawn(
      BIN,
      ['--model', MODEL, '--language', 'auto', '--host', HOST, '--port', String(PORT)],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );
    proc.on('exit', () => { proc = null; });
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (await pingOnce()) return true;
      await new Promise((r) => setTimeout(r, 300));
    }
    return false;
  })();
  const ok = await starting;
  starting = null;
  return ok;
}

/** @param {Buffer} wavBuffer 16-bit PCM WAV @param {string} language 'auto' | 'en' | … */
export async function transcribe(wavBuffer, language = 'auto') {
  const ok = await ensureStarted();
  if (!ok) throw new Error('local whisper server unavailable (not installed or failed to start)');
  const form = new FormData();
  form.append('file', new Blob([wavBuffer], { type: 'audio/wav' }), 'audio.wav');
  form.append('response_format', 'json');
  form.append('language', language === 'en' ? 'en' : 'auto');
  const res = await fetch(`http://${HOST}:${PORT}/inference`, { method: 'POST', body: form });
  if (!res.ok) throw new Error(`whisper-server HTTP ${res.status}`);
  const data = await res.json();
  return String(data.text || '').trim();
}

// Cold-starting whisper-server takes ~8s (Metal shader compile + loading the
// 1.5GB model), and it used to only spawn lazily on the first /transcribe
// call — so the first Space press of a session paid that whole cost inline.
// Call this at server startup instead so it's already warm by the time
// anyone uses Minty.
export function warmUpWhisper() {
  if (!whisperAvailable()) return;
  ensureStarted().catch(() => {});
}

export function stopWhisper() {
  if (proc) {
    try { proc.kill('SIGTERM'); } catch { /* already gone */ }
    proc = null;
  }
}
