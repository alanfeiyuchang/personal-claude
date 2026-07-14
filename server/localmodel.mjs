// Local model gateway — runs a small LiteLLM proxy in front of a local Ollama
// model (Qwen3 8B), translating the Anthropic Messages API that `claude -p`
// speaks into Ollama's chat API. This is the one place that knows about that
// translation layer: both Minty (minty.mjs) and regular sessions
// (session.mjs) just point the `claude` CLI's ANTHROPIC_BASE_URL at the
// proxy when this model is selected — nothing else about how they spawn or
// talk to the CLI changes, since the CLI still owns the whole agent loop
// (MCP tools, streaming, multi-turn memory).

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

// User-facing model value: shows up in the model picker (ui/src/models.ts)
// and is the literal --model flag passed to `claude` when selected — the
// proxy's config maps this alias to the real Ollama model underneath.
export const LOCAL_MODEL = 'qwen3-8b';
const OLLAMA_MODEL = 'qwen3:8b';

const OLLAMA_HOST = '127.0.0.1';
const OLLAMA_PORT = 11434; // ollama's standard default — reuse a system-wide `ollama serve` if one's already up
const PROXY_HOST = '127.0.0.1';
const PROXY_PORT = 4321;
// dummy — the proxy only binds to localhost and forwards to a localhost-only
// Ollama instance, so there's nothing to actually authenticate
const AUTH_TOKEN = 'personal-claude-local';

const CACHE_DIR = join(os.homedir(), '.cache', 'personal-claude');
const VENV_DIR = join(CACHE_DIR, 'qwen-proxy-venv');
const LITELLM_BIN = join(VENV_DIR, 'bin', 'litellm');
const CONFIG_PATH = join(CACHE_DIR, 'litellm-config.yaml');
const OLLAMA_BIN = '/opt/homebrew/opt/ollama/bin/ollama';

const CONFIG_YAML = `model_list:
  - model_name: ${LOCAL_MODEL}
    litellm_params:
      model: ollama_chat/${OLLAMA_MODEL}
      api_base: http://${OLLAMA_HOST}:${OLLAMA_PORT}
      # Qwen3 defaults to an extended "thinking" mode — without this it burns
      # 5-10x the latency on internal reasoning tokens before answering, and
      # (empirically) is *more* likely to wander from a strict output format,
      # not less. Off is strictly better for Minty's short spoken replies.
      think: false
litellm_settings:
  drop_params: true
`;

let ollamaProc = null;
let proxyProc = null;
let starting = null;

export function isLocalModel(model) {
  return model === LOCAL_MODEL;
}

export function localModelAvailable() {
  return existsSync(OLLAMA_BIN) && existsSync(LITELLM_BIN);
}

export function localModelEnv() {
  return {
    ANTHROPIC_BASE_URL: `http://${PROXY_HOST}:${PROXY_PORT}`,
    ANTHROPIC_AUTH_TOKEN: AUTH_TOKEN,
    // the CLI otherwise tries to hit Anthropic's own auth/telemetry endpoints
    CLAUDE_CODE_SKIP_AUTH_HEALTHCHECK: '1',
  };
}

async function pingOnce(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1000) });
    return res.ok || res.status === 404 || res.status === 401;
  } catch {
    return false;
  }
}

async function waitUntilUp(url, deadlineMs) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (await pingOnce(url)) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

async function ensureOllama() {
  if (await pingOnce(`http://${OLLAMA_HOST}:${OLLAMA_PORT}/api/tags`)) return true;
  if (!existsSync(OLLAMA_BIN)) return false;
  ollamaProc = spawn(OLLAMA_BIN, ['serve'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, OLLAMA_HOST: `${OLLAMA_HOST}:${OLLAMA_PORT}` },
  });
  ollamaProc.on('exit', () => { ollamaProc = null; });
  return waitUntilUp(`http://${OLLAMA_HOST}:${OLLAMA_PORT}/api/tags`, 15_000);
}

async function ensureProxy() {
  if (await pingOnce(`http://${PROXY_HOST}:${PROXY_PORT}/health/liveliness`)) return true;
  if (!existsSync(LITELLM_BIN)) return false;
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, CONFIG_YAML);
  proxyProc = spawn(
    LITELLM_BIN,
    ['--config', CONFIG_PATH, '--host', PROXY_HOST, '--port', String(PROXY_PORT)],
    { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } }
  );
  proxyProc.on('exit', () => { proxyProc = null; });
  // first boot imports litellm's (large) dependency tree — give it real time
  return waitUntilUp(`http://${PROXY_HOST}:${PROXY_PORT}/health/liveliness`, 45_000);
}

/** Starts Ollama + the translation proxy if they aren't already up. Safe to call repeatedly. */
export async function ensureLocalModelReady() {
  if (starting) return starting;
  starting = (async () => {
    if (!localModelAvailable()) {
      throw new Error(`local model not set up (missing ${!existsSync(OLLAMA_BIN) ? 'ollama' : 'litellm venv'})`);
    }
    if (!(await ensureOllama())) throw new Error('ollama did not come up in time');
    if (!(await ensureProxy())) throw new Error('local model proxy did not come up in time');
  })();
  try {
    await starting;
  } finally {
    starting = null;
  }
}

/** Fire-and-forget: gets Ollama + the proxy past their cold start before the
 * first Space press / session, same reasoning as warmUpWhisper() in
 * whisper.mjs. Safe to call even if the local model was never set up. */
export function warmUpLocalModel() {
  if (!localModelAvailable()) return;
  ensureLocalModelReady().catch(() => {});
}

export function stopLocalModel() {
  try { proxyProc?.kill('SIGTERM'); } catch { /* already gone */ }
  proxyProc = null;
  // leave `ollama serve` running — it's a shared local daemon, other apps
  // (or a future Personal Claude launch) may still want it
}
