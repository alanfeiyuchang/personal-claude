// Minty — the voice assistant brain. One persistent lightweight claude process
// (stream-json in/out, like sessions but with a scoped system prompt and no UI
// transcript). Given an utterance + app state, it replies with strict JSON:
// what to say aloud, and optionally an action to run on Personal Claude.

import { spawn } from 'node:child_process';
import os from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOCAL_MODEL, isLocalModel, ensureLocalModelReady, localModelEnv } from './localmodel.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Minty's brain defaults to Claude Haiku (cloud): via the local Qwen3 8B
// path it was ~20s/reply, didn't stream (so the orb sat silent until the
// whole reply landed), and was unreliable at the strict-JSON dispatcher
// protocol. Local Qwen stays a first-class option — switch to it at runtime
// via the orb's brain toggle (the 'set_minty_model' WS message), or make it
// the default here with PC_MINTY_MODEL=qwen3-8b.
export const CLOUD_MODEL = 'haiku';
const DEFAULT_MODEL = process.env.PC_MINTY_MODEL || CLOUD_MODEL;
const ASK_TIMEOUT = 45_000;

const SYSTEM_PROMPT = `You are Minty, the spoken voice assistant embedded in "Personal Claude". Replies are read aloud by TTS.

You ALWAYS output exactly one JSON object and nothing else — no markdown fences, no quotes around it, no text before or after it, both fields inside the SAME object:
{"say": "1-2 short spoken sentences", "action": null | {...}}

WRONG (never do this — two separate pieces of output):
"Switching to the website session."
{"type": "focus", "sessionId": "sess-xyz"}

RIGHT (one object, action nested inside it):
{"say": "Switching to the website session.", "action": {"type": "focus", "sessionId": "sess-xyz"}}

"action" is null, or one of:
{"type": "task", "sessionId": "<id>", "text": "<full task prompt>"}
{"type": "task", "newSession": {"dir": "<absolute project dir>", "model": "sonnet", "permissionMode": "bypassPermissions"}, "text": "<full task prompt>"}
{"type": "focus", "sessionId": "<id>"}
{"type": "interrupt", "sessionId": "<id>"}

Each user message is JSON: {"utterance", "sessions": [{"id","name","dir","state","active"}], "activeSessionId", "activeSession": {"id","name","dir","state","currentTool","recentMessages":[{"role","text"}]} | null, "devRoot", "projects": [...]}.

Rules:
- "this session" / "it" / "what's it doing" / "stop it" / no session named → activeSessionId. Answer "what's it doing/working on" straight from "activeSession" — don't call a tool for that. Only pick a different session when the user names one (by name/project).
- Mirror the user's language: English, 中文, or natural 中英混合 — never translate them into a different language than they used.
- Jarvis-like: brief, capable, warm. Never speak JSON, field names, or code aloud in "say".
- Clear coding/app task → "task" action with a complete, self-contained imperative prompt (target activeSessionId unless another session's named; newSession only if none fit). Ambiguous → ask ONE clarifying question, action null.
- NEVER say "I'll do X" / "let me do X" / "creating X now" and then leave action null — that's a broken promise the user can't see through. If you're describing an action in "say", that exact action MUST be in "action" in the SAME reply. If you're not ready to act (missing info), ask a clarifying question instead of a vague promise. Decide fresh each turn — don't just repeat how you phrased an earlier reply.
- You have MCP tools (list_sessions, get_session_info, get_session_transcript, get_session_last_output, get_ui_state, get_session_context) for anything the payload doesn't already answer.
- Keep conversation memory: earlier turns are context.`;

class Minty {
  constructor() {
    this.model = DEFAULT_MODEL;
    this.proc = null;
    this.busy = false;
    this._buf = '';
    this._starting = null; // in-flight _ensureStarted() promise, dedupes concurrent callers
    // FIFO of in-flight turns. Normally at most one (busy gates concurrent
    // asks), but interrupt() lets a new ask() start while an aborted turn is
    // still draining its output from the CLI process, so this can briefly
    // hold two: the aborted one (ignored once its 'result' arrives) and the
    // live one.
    this._turns = [];
  }

  usesLocalModel() {
    return isLocalModel(this.model);
  }

  // Switches Minty's brain to a different model. Since a running process
  // can't have its ANTHROPIC_BASE_URL changed (that's only set at spawn
  // time — see _spawnClaude), this can't be a live in-place switch the way
  // session.mjs's setModel() is for regular sessions: it has to kill the
  // current process and let the next ask() respawn fresh with the new
  // model/env. That does mean conversation memory doesn't carry across a
  // model switch — same trade-off as an interrupt.
  setModel(model) {
    if (model !== LOCAL_MODEL && model !== CLOUD_MODEL) throw new Error(`unknown minty model: ${model}`);
    if (model === this.model) return;
    this.model = model;
    // the 'exit' handler below settles any in-flight turns and clears state;
    // next ask() sees no live proc and calls _spawnClaude() with this.model
    try { this.proc?.kill('SIGTERM'); } catch { /* already gone */ }
  }

  // interrupt() frees `busy` as soon as it fires, which can be while the
  // *current* ask() is still awaiting this very method (e.g. a slow local
  // model cold start) — without dedup, the next ask() would call this again
  // concurrently and spawn a second, orphaned `claude` process.
  _ensureStarted() {
    if (this.proc && this.proc.exitCode === null) return Promise.resolve();
    if (!this._starting) {
      this._starting = this._spawnClaude().finally(() => { this._starting = null; });
    }
    return this._starting;
  }

  async _spawnClaude() {
    // only pays the readiness-check cost on cold start / after a crash — an
    // already-running proc (the common case) skips straight past this
    let extraEnv = {};
    let systemPrompt = SYSTEM_PROMPT;
    if (isLocalModel(this.model)) {
      await ensureLocalModelReady();
      extraEnv = localModelEnv();
      // Qwen3 is a reasoning model: by default it emits a long <think>…</think>
      // trace before its actual reply, which for a voice dispatcher just means
      // seconds of "thinking…" latency (and risks blowing past ASK_TIMEOUT on
      // harder asks) with no quality upside for what is short JSON output. Its
      // native `/no_think` soft-switch turns that off per-turn — passed as
      // prompt *text* so the proxy's drop_params can't strip it the way it
      // would a `think:false` request param. Cloud models (Haiku) never see
      // this, since it's meaningless literal text to them.
      systemPrompt = `${SYSTEM_PROMPT}\n\n/no_think`;
    }
    const mcpConfigPath = resolve(__dirname, '../.mcp.json');
    this.proc = spawn(
      'claude',
      [
        '-p',
        '--output-format', 'stream-json',
        '--input-format', 'stream-json',
        '--verbose',
        '--include-partial-messages',
        '--model', this.model,
        // Minty is a conversational dispatcher, not a coding agent — it
        // should never have Write/Edit/Bash/etc. available. Without this,
        // an ambiguous utterance can lead the model to try acting on the
        // filesystem via those built-in tools (seen in practice), and
        // since nothing here handles the resulting permission-request
        // control event, the turn would just hang until ASK_TIMEOUT.
        // '--tools ""' removes the built-in set entirely; the MCP
        // query tools stay available via --mcp-config below and are all
        // read-only, so bypassPermissions is safe for them specifically.
        '--tools', '',
        '--permission-mode', 'bypassPermissions',
        '--append-system-prompt', systemPrompt,
        '--mcp-config', mcpConfigPath,
      ],
      { cwd: os.homedir(), stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, ...extraEnv } }
    );
    this._buf = '';
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk) => this._onStdout(chunk));
    this.proc.on('exit', () => {
      // fail every in-flight turn; next ask respawns
      const turns = this._turns;
      this._turns = [];
      this.busy = false;
      for (const t of turns) {
        t.settle({ say: 'My brain process crashed — try that again.', action: null, error: 'minty process exited' });
      }
    });
  }

  /**
   * @param {(delta: string) => void} [onSayDelta] streamed chunks of the "say"
   *   field as the model writes it — lets the client start TTS early
   * @returns {Promise<{say:string, action:object|null, error?:string, aborted?:boolean}>}
   */
  async ask(utterance, appState, onSayDelta) {
    if (this.busy) {
      return { say: "One moment — I'm still on your last request.", action: null };
    }
    this.busy = true; // claimed synchronously, before any await, so concurrent asks bounce cleanly

    let settled = false;
    const turn = {
      texts: [],
      extractor: onSayDelta ? new SayExtractor(onSayDelta) : null,
      aborted: false,
      settle: null,
      timer: null,
    };
    const result = new Promise((resolve) => {
      turn.settle = (reply) => {
        if (settled) return;
        settled = true;
        clearTimeout(turn.timer);
        this.busy = false;
        resolve(reply);
      };
      turn.timer = setTimeout(() => {
        turn.aborted = true; // whatever it eventually outputs gets dropped
        turn.settle({ say: 'That took too long to think about — try again.', action: null, error: 'timeout' });
        try { this.proc?.kill('SIGTERM'); } catch { /* respawn next ask */ }
      }, ASK_TIMEOUT);
    });
    // pushed before _ensureStarted() so interrupt() can still cancel a turn
    // that's stuck waiting on a cold local-model start (up to ~45s the first
    // time Ollama/the proxy have to boot)
    this._turns.push(turn);

    // nothing gets written to stdin below in either of these cases, so
    // _onStdout will never see a 'result' line to shift this turn off with —
    // drop it ourselves or it wedges every turn queued behind it forever
    const dropUnsent = () => {
      const idx = this._turns.indexOf(turn);
      if (idx !== -1) this._turns.splice(idx, 1);
    };

    try {
      await this._ensureStarted();
    } catch (err) {
      turn.aborted = true;
      dropUnsent();
      turn.settle({ say: "My brain isn't available right now — check the server logs.", action: null, error: err.message });
      return result;
    }
    if (turn.aborted) {
      dropUnsent(); // interrupted while starting up
      return result;
    }

    const payload = JSON.stringify({ utterance, ...appState });
    this.proc.stdin.write(
      JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: payload }] } }) + '\n'
    );
    return result;
  }

  // Abandons the oldest in-flight turn so a new ask() can start right away —
  // used when the user interrupts Minty mid-thought (Space/click while
  // thinking or speaking). The CLI process keeps computing that turn in the
  // background (it can't be cancelled mid-turn without losing the
  // conversation memory the *other*, already-completed turns carry), but its
  // eventual output is now unroutable to any live caller and gets discarded
  // in _onStdout once its 'result' line arrives.
  interrupt() {
    const turn = this._turns[0];
    if (!turn || turn.aborted) return;
    turn.aborted = true;
    turn.extractor = null;
    turn.settle({ say: '', action: null, aborted: true }); // settle() itself frees `busy`
  }

  _onStdout(chunk) {
    this._buf += chunk;
    let nl;
    while ((nl = this._buf.indexOf('\n')) !== -1) {
      const line = this._buf.slice(0, nl).trim();
      this._buf = this._buf.slice(nl + 1);
      const turn = this._turns[0];
      if (!line || !turn) continue;
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }
      if (ev.type === 'stream_event') {
        const d = ev.event?.type === 'content_block_delta' ? ev.event.delta : null;
        if (d?.type === 'text_delta' && d.text) turn.extractor?.feed(d.text);
      } else if (ev.type === 'assistant') {
        for (const block of ev.message?.content ?? []) {
          if (block.type === 'text' && block.text) turn.texts.push(block.text);
        }
      } else if (ev.type === 'result') {
        this._turns.shift();
        if (!turn.aborted) {
          const raw = turn.texts.join('\n').trim();
          turn.settle(parseReply(raw, ev.is_error));
        }
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
      // the {...} parsed but wasn't the {say, action} envelope — it's very
      // likely a bare action object the model emitted as its own top-level
      // thing instead of nesting it (smaller models do this under load, e.g.
      // once a bigger app-state payload is in context). Recoverable: treat
      // whatever came before it as the spoken text.
      const action = validAction(obj);
      if (action) {
        const say = raw.slice(0, start).trim().replace(/^["'\s]+|["'\s]+$/g, '');
        if (say) return { say, action };
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
