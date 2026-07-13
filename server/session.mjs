// ClaudeSession — wraps one `claude` CLI process in stream-json in/out mode.
// This is the single adapter module between Personal Claude and the CLI
// (see PLAN.md §11: isolate all wrapping behind one adapter).

import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

const MAX_TRANSCRIPT = 5000;

/** Session lifecycle / activity states (PLAN.md §4). */
export const STATES = [
  'starting',
  'idle',
  'thinking',
  'tool_running',
  'streaming_output',
  'waiting_input',
  'done',
  'error',
  'closed',
];

export class ClaudeSession extends EventEmitter {
  constructor({ id, name, dir, model, permissionMode, resume, claudeBin }) {
    super();
    this.id = id || randomUUID();
    this.name = name || dir.split('/').filter(Boolean).pop() || 'session';
    this.dir = dir;
    this.model = model || null;
    this.permissionMode = permissionMode || 'bypassPermissions';
    this.resume = resume || null;
    this.claudeBin = claudeBin || 'claude';

    this.state = 'starting';
    this.claudeSessionId = null;
    this.initInfo = null; // tools, slash_commands, skills, plugins, model
    this.currentTool = null;
    this.turnStartedAt = null;
    this.startedAt = Date.now();
    this.lastActivity = Date.now();
    this.totals = { costUsd: 0, inputTokens: 0, outputTokens: 0, turns: 0 };
    this.transcript = [];
    this.lastError = null;
    this._stdoutBuf = '';
    this._stderrTail = [];
    this._doneTimer = null;
    this._exitRequested = false;
    this._interruptRequestedAt = null;
    this._interruptFallback = null;
    this._controlRequests = new Map(); // request_id → { subtype, model? }
    this._thinkingTokens = 0;
    this._contextProbe = false;
    this.contextInfo = null; // { usedTokens, windowTokens, percent, updatedAt } from the last /context probe
    this.proc = null;
  }

  start() {
    const args = [
      '-p',
      '--output-format', 'stream-json',
      '--input-format', 'stream-json',
      '--verbose',
      '--permission-mode', this.permissionMode,
    ];
    if (this.model) args.push('--model', this.model);
    if (this.resume) args.push('--resume', this.resume);

    this.proc = spawn(this.claudeBin, args, {
      cwd: this.dir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk) => this._onStdout(chunk));
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (chunk) => {
      this._stderrTail.push(chunk);
      if (this._stderrTail.length > 50) this._stderrTail.shift();
    });
    this.proc.on('error', (err) => {
      this.lastError = `spawn failed: ${err.message}`;
      this._setState('error');
    });
    this.proc.on('exit', (code, signal) => {
      if (this._exitRequested) {
        this._setState('closed');
      } else {
        this.lastError =
          `claude exited (code=${code} signal=${signal})` +
          (this._stderrTail.length ? `: ${this._stderrTail.join('').slice(-2000)}` : '');
        this._setState('error');
      }
      this.emit('exit', { code, signal });
    });

    // Process is up but the first turn hasn't started; init event arrives
    // only after the first user message, so surface it as idle.
    if (this.resume && this.transcript.length === 0) {
      // caller (index.mjs) seeds this.transcript from the stored .jsonl
      // before start(); if that came back empty, say so instead of a
      // silently blank panel
      this._pushTranscript({
        kind: 'system',
        text: `continuing session ${this.resume} — no earlier messages could be loaded`,
      });
    }
    this._setState('idle');
    return this;
  }

  send(text, images = []) {
    if (!this.proc || this.proc.exitCode !== null) {
      throw new Error('session process is not running');
    }
    const content = [];
    const cleanImages = [];
    for (const im of images) {
      if (!im || typeof im.data !== 'string' || typeof im.media_type !== 'string') continue;
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: im.media_type, data: im.data },
      });
      cleanImages.push({ media_type: im.media_type, data: im.data });
    }
    if (text) content.push({ type: 'text', text });
    if (!content.length) return;
    const msg = {
      type: 'user',
      message: { role: 'user', content },
    };
    this.proc.stdin.write(JSON.stringify(msg) + '\n');
    this.turnStartedAt = Date.now();
    this._pushTranscript({ kind: 'user_text', text, images: cleanImages });
    this._setState('thinking');
  }

  rename(name) {
    const trimmed = typeof name === 'string' ? name.trim() : '';
    if (!trimmed) throw new Error('invalid name');
    this.name = trimmed;
    this.emit('update');
  }

  setModel(model) {
    if (!this.proc || this.proc.exitCode !== null) {
      throw new Error('session process is not running');
    }
    if (typeof model !== 'string' || !model.trim()) throw new Error('invalid model');
    const requestId = randomUUID();
    const req = {
      type: 'control_request',
      request_id: requestId,
      request: { subtype: 'set_model', model },
    };
    this._controlRequests.set(requestId, { subtype: 'set_model', model });
    this.proc.stdin.write(JSON.stringify(req) + '\n');
  }

  // Asks the CLI's own `/context` slash command for the real per-model context
  // window and current usage — it's handled locally by the CLI (no API call,
  // no cost) rather than sent to the model, so it's cheap to poll.
  requestContext() {
    if (!this.proc || this.proc.exitCode !== null) return;
    if (this._contextProbe) return; // one in flight at a time
    if (this.state !== 'idle' && this.state !== 'waiting_input' && this.state !== 'done') return;
    const msg = { type: 'user', message: { role: 'user', content: '/context' } };
    this.proc.stdin.write(JSON.stringify(msg) + '\n');
    this._contextProbe = true;
    this._setState('thinking');
  }

  interrupt() {
    if (!this.proc || this.proc.exitCode !== null) return;
    // SDK-style control request; SIGINT only if the CLI never acknowledges it.
    const requestId = randomUUID();
    const req = {
      type: 'control_request',
      request_id: requestId,
      request: { subtype: 'interrupt' },
    };
    let wrote = false;
    try {
      this.proc.stdin.write(JSON.stringify(req) + '\n');
      this._controlRequests.set(requestId, { subtype: 'interrupt' });
      wrote = true;
    } catch {
      /* fall through to SIGINT */
    }
    this._interruptRequestedAt = Date.now();
    const proc = this.proc;
    clearTimeout(this._interruptFallback);
    this._interruptFallback = setTimeout(() => {
      if (this.state === 'thinking' || this.state === 'tool_running' || this.state === 'streaming_output') {
        try { proc.kill('SIGINT'); } catch { /* already gone */ }
      }
    }, wrote ? 5000 : 0);
  }

  stop() {
    this._exitRequested = true;
    if (this.proc && this.proc.exitCode === null) {
      try { this.proc.stdin.end(); } catch { /* ignore */ }
      const proc = this.proc;
      setTimeout(() => {
        if (proc.exitCode === null) { try { proc.kill('SIGTERM'); } catch { /* ignore */ } }
      }, 3000);
    } else {
      this._setState('closed');
    }
  }

  summary() {
    return {
      id: this.id,
      name: this.name,
      dir: this.dir,
      model: this.initInfo?.model || this.model,
      permissionMode: this.permissionMode,
      state: this.state,
      alive: !!(this.proc && this.proc.exitCode === null),
      claudeSessionId: this.claudeSessionId,
      currentTool: this.currentTool,
      turnStartedAt: this.turnStartedAt,
      startedAt: this.startedAt,
      lastActivity: this.lastActivity,
      totals: this.totals,
      lastError: this.lastError,
      initInfo: this.initInfo,
      contextInfo: this.contextInfo,
    };
  }

  // ── internals ──────────────────────────────────────────────────────────

  _onStdout(chunk) {
    this._stdoutBuf += chunk;
    let nl;
    while ((nl = this._stdoutBuf.indexOf('\n')) !== -1) {
      const line = this._stdoutBuf.slice(0, nl).trim();
      this._stdoutBuf = this._stdoutBuf.slice(nl + 1);
      if (!line) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue; // non-JSON noise on stdout
      }
      this._onEvent(event);
    }
  }

  _onEvent(ev) {
    this.lastActivity = Date.now();
    switch (ev.type) {
      case 'system':
        if (ev.subtype === 'init') {
          this.claudeSessionId = ev.session_id;
          this.initInfo = {
            model: ev.model,
            permissionMode: ev.permissionMode,
            tools: ev.tools || [],
            slashCommands: ev.slash_commands || [],
            skills: ev.skills || [],
            plugins: (ev.plugins || []).map((p) => p.name),
            claudeCodeVersion: ev.claude_code_version,
          };
          this.emit('update');
        } else if (ev.subtype === 'thinking_tokens') {
          // headless stream-json never sends the reasoning text itself —
          // this running estimate is all we get until the block finalizes
          this._thinkingTokens = ev.estimated_tokens || this._thinkingTokens;
        }
        break;

      case 'assistant': {
        if (this._contextProbe) {
          const text = (ev.message?.content || []).find((b) => b.type === 'text')?.text || '';
          this._applyContextProbe(text);
          break;
        }
        const content = ev.message?.content || [];
        for (const block of content) {
          if (block.type === 'thinking') {
            this._pushTranscript({
              kind: 'thinking',
              text: block.thinking,
              tokens: this._thinkingTokens || undefined,
            });
            this._thinkingTokens = 0;
            this._setState('thinking');
          } else if (block.type === 'text') {
            this._pushTranscript({ kind: 'assistant_text', text: block.text });
            this._setState('streaming_output');
          } else if (block.type === 'tool_use') {
            this.currentTool = block.name;
            this._pushTranscript({
              kind: 'tool_use',
              toolUseId: block.id,
              tool: block.name,
              input: block.input,
            });
            this._setState('tool_running');
          }
        }
        const usage = ev.message?.usage;
        if (usage) {
          this.totals.inputTokens =
            (usage.input_tokens || 0) +
            (usage.cache_creation_input_tokens || 0) +
            (usage.cache_read_input_tokens || 0);
          this.totals.outputTokens += usage.output_tokens || 0;
          this.emit('update');
        }
        break;
      }

      case 'user': {
        // tool results coming back → model will think next
        const content = ev.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'tool_result') {
              this._pushTranscript({
                kind: 'tool_result',
                toolUseId: block.tool_use_id,
                isError: !!block.is_error,
                text: flattenToolResult(block.content),
              });
            }
          }
        }
        this.currentTool = null;
        if (this.state === 'tool_running') this._setState('thinking');
        break;
      }

      case 'result': {
        if (this._contextProbe) {
          this._contextProbe = false;
          this._setState('idle');
          break;
        }
        this.totals.turns += ev.num_turns || 1;
        if (typeof ev.total_cost_usd === 'number') this.totals.costUsd += ev.total_cost_usd;
        this.currentTool = null;
        this.turnStartedAt = null;
        const interrupted =
          this._interruptRequestedAt && Date.now() - this._interruptRequestedAt < 30_000;
        this._interruptRequestedAt = null;
        this._pushTranscript({
          kind: 'result',
          isError: !!ev.is_error && !interrupted,
          subtype: interrupted ? 'interrupted' : ev.subtype,
          durationMs: ev.duration_ms,
          costUsd: ev.total_cost_usd,
        });
        if (ev.is_error && !interrupted) {
          this.lastError = typeof ev.result === 'string' ? ev.result : ev.subtype;
          this._setState('error');
          // the process is still alive — the session stays usable
          clearTimeout(this._doneTimer);
          this._doneTimer = setTimeout(() => {
            if (this.state === 'error' && this.proc?.exitCode === null) this._setState('idle');
          }, 3000);
        } else {
          this._setState('done');
          clearTimeout(this._doneTimer);
          this._doneTimer = setTimeout(() => {
            if (this.state === 'done') this._setState('idle');
          }, 1500);
        }
        break;
      }

      case 'control_response': {
        const requestId = ev.response?.request_id;
        const pending = requestId ? this._controlRequests.get(requestId) : null;
        if (requestId) this._controlRequests.delete(requestId);
        if (!pending || pending.subtype === 'interrupt') {
          // interrupt acknowledged (or unknown response) — cancel the SIGINT fallback
          clearTimeout(this._interruptFallback);
        } else if (pending.subtype === 'set_model') {
          if (ev.response?.subtype === 'error') {
            this._pushTranscript({
              kind: 'system',
              text: `model switch failed: ${ev.response?.error || 'unknown error'}`,
            });
          } else {
            this.model = pending.model;
            if (this.initInfo) this.initInfo.model = pending.model;
            this._pushTranscript({ kind: 'system', text: `model → ${pending.model}` });
          }
          this.emit('update');
        }
        break;
      }

      default:
        break; // rate_limit_event, thinking_tokens ticks, …
    }
  }

  // Parses the CLI's "## Context Usage\n\n**Model:** …\n**Tokens:** 20.9k / 967k (2%)"
  // reply from `/context` into real numbers instead of the 200k guess we had
  // no way to verify — this window changes per model/plan (1M-context beta etc).
  _applyContextProbe(text) {
    const m = text.match(/\*\*Tokens:\*\*\s*([\d.]+)(k|M)?\s*\/\s*([\d.]+)(k|M)?\s*\(([\d.]+)%\)/i);
    if (m) {
      const scale = (suffix) => {
        const s = (suffix || '').toLowerCase();
        return s === 'm' ? 1_000_000 : s === 'k' ? 1_000 : 1;
      };
      this.contextInfo = {
        usedTokens: Math.round(parseFloat(m[1]) * scale(m[2])),
        windowTokens: Math.round(parseFloat(m[3]) * scale(m[4])),
        percent: parseFloat(m[5]),
        updatedAt: Date.now(),
      };
      this.emit('update');
    }
  }

  _pushTranscript(item) {
    const entry = { ...item, ts: Date.now(), seq: this.transcript.length };
    this.transcript.push(entry);
    if (this.transcript.length > MAX_TRANSCRIPT) {
      this.transcript.splice(0, this.transcript.length - MAX_TRANSCRIPT);
    }
    this.emit('transcript', entry);
  }

  _setState(state) {
    if (this.state === state) return;
    this.state = state;
    this.emit('state', state);
    this.emit('update');
  }
}

function flattenToolResult(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => (b.type === 'text' ? b.text : `[${b.type}]`))
    .join('\n');
}
