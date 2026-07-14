// Local text-to-speech for Minty via a small Qwen3-TTS server (tts_server.py,
// running under a dedicated venv on MLX). This is the one place that knows
// about that process. Qwen3-TTS reads Chinese/English code-switched text in
// one continuous voice — the browser's speechSynthesis needs a different
// system voice per language, which made Minty sound like two people taking
// turns mid-sentence.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(os.homedir(), '.cache', 'personal-claude');
const VENV_DIR = join(CACHE_DIR, 'tts-venv');
const PYTHON_BIN = join(VENV_DIR, 'bin', 'python');
const SERVER_SCRIPT = join(__dirname, 'tts_server.py');

const HOST = '127.0.0.1';
const PORT = 8780;

export const DEFAULT_VOICE = 'Chelsie';

let proc = null;
let starting = null;

export function ttsAvailable() {
  return existsSync(PYTHON_BIN) && existsSync(SERVER_SCRIPT);
}

async function pingOnce() {
  try {
    const res = await fetch(`http://${HOST}:${PORT}/health`, { signal: AbortSignal.timeout(1000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function ensureStarted() {
  if (await pingOnce()) return true; // already running (this process or a leftover one)
  if (starting) return starting;
  if (!ttsAvailable()) return false;
  starting = (async () => {
    proc = spawn(PYTHON_BIN, [SERVER_SCRIPT, String(PORT)], { stdio: ['ignore', 'pipe', 'pipe'] });
    proc.on('exit', () => { proc = null; });
    // cold start loads the model (~a few seconds on Apple Silicon) — give it
    // real time rather than whisper-server's 30s budget, since it's larger
    const deadline = Date.now() + 60_000;
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

/** @param {string} text @param {string} [voice] @returns {Promise<Buffer>} WAV audio */
export async function synthesize(text, voice = DEFAULT_VOICE) {
  const ok = await ensureStarted();
  if (!ok) throw new Error('local TTS server unavailable (not installed or failed to start)');
  const res = await fetch(`http://${HOST}:${PORT}/speak`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, voice }),
  });
  if (!res.ok) throw new Error(`tts-server HTTP ${res.status}: ${await res.text().catch(() => '')}`);
  return Buffer.from(await res.arrayBuffer());
}

// Cold-starting the TTS server takes a few seconds (MLX model load) — warm it
// up at server startup instead of paying that cost on Minty's first reply,
// same reasoning as warmUpWhisper() in whisper.mjs.
export function warmUpTts() {
  if (!ttsAvailable()) return;
  ensureStarted().catch(() => {});
}

export function stopTts() {
  if (proc) {
    try { proc.kill('SIGTERM'); } catch { /* already gone */ }
    proc = null;
  }
}
