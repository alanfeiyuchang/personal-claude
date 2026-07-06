// Minty — the voice assistant brain. One persistent lightweight claude process
// (stream-json in/out, like sessions but with a scoped system prompt and no UI
// transcript). Given an utterance + app state, it replies with strict JSON:
// what to say aloud, and optionally an action to run on Personal Claude.

import { spawn } from 'node:child_process';
import os from 'node:os';

const MODEL = process.env.PC_MINTY_MODEL || 'haiku';
const ASK_TIMEOUT = 45_000;

const SYSTEM_PROMPT = `You are Minty, the spoken voice assistant embedded in "Personal Claude" — a local web shell that manages Claude Code sessions. The user talks to you; your replies are read aloud by TTS, and you can drive the app.

Each user message is JSON: {"utterance": "...", "sessions": [{"id","name","dir","state"}], "devRoot": "...", "projects": ["dirname", ...]}.

Respond with ONLY one JSON object — no markdown fences, no prose around it:
{
  "say": "what to speak aloud — 1-2 short conversational sentences",
  "action": null
        | {"type": "task", "sessionId": "<existing session id>", "text": "<full task prompt>"}
        | {"type": "task", "newSession": {"dir": "<absolute project dir>", "model": "sonnet", "permissionMode": "bypassPermissions"}, "text": "<full task prompt>"}
        | {"type": "focus", "sessionId": "<id>"}
        | {"type": "interrupt", "sessionId": "<id>"}
}

Rules:
- ALWAYS put the "say" field first in the JSON object — it is spoken aloud while you are still writing the rest.
- Mirror the user's language in "say": reply in whatever they spoke — English, 中文, or natural 中英混合 code-switching (keeping tech terms in English is good). Never translate them into a different language than they used.
- You are Jarvis-like: brief, capable, warm, a bit of personality. Never speak JSON or code aloud in "say".
- When the user describes a coding/app task and the intent is clear enough to act on: emit a "task" action. Write "text" as a complete, self-contained imperative prompt for a Claude Code session (include the concrete details the user gave). Pick the existing session whose dir/name matches the project they mean; if none matches, use newSession with the matching project dir under devRoot.
- When the request is ambiguous (unclear project, unclear goal), ask ONE clarifying question in "say" and set action null. Once it becomes clear in a later turn, act.
- "stop"/"cancel that" → interrupt the running session. "show me X"/"switch to X" → focus.
- Small talk or questions about app state: just answer in "say", action null.
- Keep conversation memory: earlier turns in this conversation are context.`;

class Minty {
  constructor() {
    this.proc = null;
    this.busy = false;
    this._buf = '';
    this._turn = null; // { texts, resolve, timer }
  }

  _ensureStarted() {
    if (this.proc && this.proc.exitCode === null) return;
    this.proc = spawn(
      'claude',
      [
        '-p',
        '--output-format', 'stream-json',
        '--input-format', 'stream-json',
        '--verbose',
        '--include-partial-messages',
        '--model', MODEL,
        '--permission-mode', 'default',
        '--append-system-prompt', SYSTEM_PROMPT,
      ],
      { cwd: os.homedir(), stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env } }
    );
    this._buf = '';
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk) => this._onStdout(chunk));
    this.proc.on('exit', () => {
      // fail the in-flight ask; next ask respawns
      this._turn?.resolve({ say: 'My brain process crashed — try that again.', action: null, error: 'minty process exited' });
      this._turn = null;
      this.busy = false;
    });
  }

  /**
   * @param {(delta: string) => void} [onSayDelta] streamed chunks of the "say"
   *   field as the model writes it — lets the client start TTS early
   * @returns {Promise<{say:string, action:object|null, error?:string}>}
   */
  ask(utterance, appState, onSayDelta) {
    if (this.busy) {
      return Promise.resolve({ say: "One moment — I'm still on your last request.", action: null });
    }
    this._ensureStarted();
    this.busy = true;

    const payload = JSON.stringify({ utterance, ...appState });
    return new Promise((resolve) => {
      const finish = (reply) => {
        clearTimeout(this._turn?.timer);
        this._turn = null;
        this.busy = false;
        resolve(reply);
      };
      this._turn = {
        texts: [],
        extractor: onSayDelta ? new SayExtractor(onSayDelta) : null,
        resolve: finish,
        timer: setTimeout(() => {
          finish({ say: 'That took too long to think about — try again.', action: null, error: 'timeout' });
          try { this.proc.kill('SIGTERM'); } catch { /* respawn next ask */ }
        }, ASK_TIMEOUT),
      };
      this.proc.stdin.write(
        JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: payload }] } }) + '\n'
      );
    });
  }

  _onStdout(chunk) {
    this._buf += chunk;
    let nl;
    while ((nl = this._buf.indexOf('\n')) !== -1) {
      const line = this._buf.slice(0, nl).trim();
      this._buf = this._buf.slice(nl + 1);
      if (!line || !this._turn) continue;
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }
      if (ev.type === 'stream_event') {
        const d = ev.event?.type === 'content_block_delta' ? ev.event.delta : null;
        if (d?.type === 'text_delta' && d.text) this._turn.extractor?.feed(d.text);
      } else if (ev.type === 'assistant') {
        for (const block of ev.message?.content ?? []) {
          if (block.type === 'text' && block.text) this._turn.texts.push(block.text);
        }
      } else if (ev.type === 'result') {
        const raw = this._turn.texts.join('\n').trim();
        this._turn.resolve(parseReply(raw, ev.is_error));
      }
    }
  }

  stop() {
    try { this.proc?.stdin.end(); } catch { /* ignore */ }
  }
}

// Incrementally pulls the value of the "say" key out of a streaming JSON
// object, emitting unescaped text as it arrives.
class SayExtractor {
  constructor(emit) {
    this.emit = emit;
    this.state = 'key'; // key → colon → quote → string → done
    this.tail = '';
    this.escaped = false;
  }

  feed(text) {
    let out = '';
    for (const ch of text) {
      switch (this.state) {
        case 'key':
          this.tail = (this.tail + ch).slice(-5);
          if (this.tail === '"say"') this.state = 'colon';
          break;
        case 'colon':
          if (ch === ':') this.state = 'quote';
          break;
        case 'quote':
          if (ch === '"') this.state = 'string';
          break;
        case 'string':
          if (this.escaped) {
            out += ch === 'n' || ch === 't' ? ' ' : ch === 'r' ? '' : ch;
            this.escaped = false;
          } else if (ch === '\\') this.escaped = true;
          else if (ch === '"') this.state = 'done';
          else out += ch;
          break;
        default:
          break;
      }
    }
    if (out) this.emit(out);
  }
}

function parseReply(raw, isError) {
  if (isError || !raw) {
    return { say: "Sorry, I couldn't process that.", action: null, error: raw || 'empty/error result' };
  }
  // tolerate fences or stray prose around the JSON object
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      const obj = JSON.parse(raw.slice(start, end + 1));
      if (typeof obj.say === 'string') {
        return { say: obj.say, action: validAction(obj.action) };
      }
    } catch { /* fall through */ }
  }
  // model spoke plain text — just say it
  return { say: raw.slice(0, 400), action: null };
}

function validAction(a) {
  if (!a || typeof a !== 'object') return null;
  if (a.type === 'task' && typeof a.text === 'string' && (a.sessionId || a.newSession?.dir)) return a;
  if ((a.type === 'focus' || a.type === 'interrupt') && a.sessionId) return a;
  return null;
}

export const minty = new Minty();
