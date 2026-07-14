// Personal Claude local server — session manager + WebSocket + static UI.
// Binds to localhost only (PLAN.md §11).

import { createServer } from 'node:http';
import { readFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { WebSocketServer } from 'ws';
import { ClaudeSession } from './session.mjs';
import { collectUsage, getPlanLimits } from './usage.mjs';
import { listHistory, deleteHistory, loadTranscript, saveSessionName } from './history.mjs';
import { getGitInfo } from './git.mjs';
import { getSkillMeta } from './skills.mjs';
import { minty } from './minty.mjs';
import { transcribe, stopWhisper, warmUpWhisper } from './whisper.mjs';
import { synthesize, stopTts, warmUpTts } from './tts.mjs';
import { graphifyStatus, rebuildGraph, GRAPHIFY_OUT } from './graphify.mjs';
import { MintyMCPServer, setMintyMCPSessionManager } from './minty-mcp.mjs';
import { isLocalModel, ensureLocalModelReady, localModelEnv, warmUpLocalModel, stopLocalModel } from './localmodel.mjs';

const PORT = Number(process.env.PC_PORT || 4317);
const HOST = '127.0.0.1';
const __dirname = dirname(fileURLToPath(import.meta.url));
const UI_DIST = resolve(__dirname, '../ui/dist');
const DEV_ROOT = join(os.homedir(), 'Desktop/Development');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

/** @type {Map<string, ClaudeSession>} */
const sessions = new Map();
/** @type {Set<import('ws').WebSocket>} */
const clients = new Set();

// ── HTTP: static UI ────────────────────────────────────────────────────────

const httpServer = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    // ── Graphify API + static graph output ─────────────────────────────────
    if (url.pathname === '/graphify/status') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(await graphifyStatus()));
      return;
    }
    if (url.pathname === '/graphify/rebuild') {
      if (req.method !== 'POST') {
        res.writeHead(405).end();
        return;
      }
      try {
        const status = await rebuildGraph(url.searchParams.get('project'));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, status }));
      } catch (err) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }
    if (url.pathname.startsWith('/graphify-out/')) {
      const rel = url.pathname.slice('/graphify-out/'.length);
      const gfile = resolve(GRAPHIFY_OUT, rel);
      if (!gfile.startsWith(GRAPHIFY_OUT) || !existsSync(gfile)) {
        res.writeHead(404).end();
        return;
      }
      const body = await readFile(gfile);
      const type = MIME[extname(gfile)] || 'application/octet-stream';
      res.writeHead(200, { 'content-type': type }).end(body);
      return;
    }

    if (url.pathname === '/tts') {
      const text = url.searchParams.get('text') || '';
      if (!text.trim()) {
        res.writeHead(400).end();
        return;
      }
      try {
        const wav = await synthesize(text, url.searchParams.get('voice') || undefined);
        res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': wav.length });
        res.end(wav);
      } catch (err) {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end(err.message);
      }
      return;
    }

    let path = url.pathname === '/' ? '/index.html' : url.pathname;
    const file = resolve(UI_DIST, '.' + path);
    if (!file.startsWith(UI_DIST)) {
      res.writeHead(403).end();
      return;
    }
    const body = await readFile(existsSync(file) ? file : join(UI_DIST, 'index.html'));
    const type = MIME[extname(file)] || 'application/octet-stream';
    res.writeHead(200, { 'content-type': type }).end(body);
  } catch (err) {
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end(`UI not built yet? Run: npm run build\n\n${err.message}`);
  }
});

// ── WebSocket protocol ─────────────────────────────────────────────────────

const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

wss.on('connection', (ws) => {
  clients.add(ws);
  ws.on('close', () => clients.delete(ws));
  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    try {
      await handleClientMessage(ws, msg);
    } catch (err) {
      sendTo(ws, { type: 'error', reqId: msg.reqId, message: err.message });
    }
  });
  sendTo(ws, {
    type: 'hello',
    sessions: [...sessions.values()].map((s) => s.summary()),
    devRoot: DEV_ROOT,
    mintyModel: minty.model,
  });
});

async function handleClientMessage(ws, msg) {
  switch (msg.type) {
    case 'create': {
      const session = await createSession(msg);
      sendTo(ws, { type: 'created', reqId: msg.reqId, id: session.id });
      break;
    }
    case 'transcribe': {
      try {
        const buf = Buffer.from(String(msg.audio ?? ''), 'base64');
        const text = await transcribe(buf, msg.language);
        sendTo(ws, { type: 'transcribed', reqId: msg.reqId, text });
      } catch (err) {
        sendTo(ws, { type: 'transcribed', reqId: msg.reqId, text: '', error: err.message });
      }
      break;
    }
    case 'minty': {
      const utterance = String(msg.text ?? '').trim();
      if (!utterance) break;
      const entries = await readdir(DEV_ROOT, { withFileTypes: true }).catch(() => []);
      // the session the asking tab currently has focused — the default
      // referent when the user says "this session" / "what's it doing"
      const activeId = sessions.has(msg.activeId) ? msg.activeId : null;
      const activeSession = activeId ? sessions.get(activeId) : null;
      const mintyAppState = {
        sessions: [...sessions.values()].map((s) => ({
          id: s.id, name: s.name, dir: s.dir, state: s.state,
          active: s.id === activeId,
        })),
        activeSessionId: activeId,
        // a snapshot of what the focused session is doing right now, so
        // Minty can answer "what's it up to?" without a tool round-trip
        activeSession: activeSession ? summarizeForMinty(activeSession) : null,
        devRoot: DEV_ROOT,
        projects: entries.filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name),
      };
      if (process.env.PC_MINTY_DEBUG) console.error('[minty debug] appState:', JSON.stringify(mintyAppState, null, 2));
      const reply = await minty.ask(
        utterance,
        mintyAppState,
        // stream the spoken text so the client can start TTS immediately
        (delta) => sendTo(ws, { type: 'minty_say', delta })
      );
      if (reply.aborted) break; // client already interrupted this turn locally — nothing to send
      let action = reply.action;
      try {
        if (action?.type === 'task' && !action.sessionId && action.newSession) {
          const session = await createSession({ ...action.newSession, name: action.newSession.name });
          action = { type: 'task', sessionId: session.id, text: action.text };
        } else if (action?.type === 'task' && action.sessionId) {
          requireSession(action.sessionId); // validate before the UI trusts it
        } else if (action?.type === 'interrupt') {
          requireSession(action.sessionId).interrupt();
        } else if (action?.type === 'focus') {
          requireSession(action.sessionId);
        }
      } catch (err) {
        reply.say += ` (But I hit a snag executing that: ${err.message})`;
        action = null;
      }
      // only the asking client acts on it — avoids duplicate sends from other tabs
      sendTo(ws, { type: 'minty_reply', say: reply.say, action, error: reply.error });
      break;
    }
    case 'minty_interrupt': {
      minty.interrupt();
      break;
    }
    case 'set_minty_model': {
      minty.setModel(String(msg.model ?? ''));
      // every tab's toggle should reflect the switch, not just the one that sent it
      broadcast({ type: 'minty_model', model: minty.model });
      break;
    }
    case 'send': {
      requireSession(msg.id).send(
        String(msg.text ?? ''),
        Array.isArray(msg.images) ? msg.images : []
      );
      break;
    }
    case 'rename': {
      const session = requireSession(msg.id);
      session.rename(String(msg.name ?? ''));
      // the CLI hasn't assigned this session an id yet (no first turn sent);
      // wireSession's 'claude-session-id' listener persists it once it does
      if (session.claudeSessionId) {
        await saveSessionName(session.dir, session.claudeSessionId, session.name);
      }
      break;
    }
    case 'set_model': {
      requireSession(msg.id).setModel(String(msg.model ?? ''));
      break;
    }
    case 'interrupt': {
      requireSession(msg.id).interrupt();
      break;
    }
    case 'get_context': {
      requireSession(msg.id).requestContext();
      break;
    }
    case 'remove': {
      const s = sessions.get(msg.id);
      if (s) {
        s.stop();
        // the process may exit (→ 'closed') after removal; don't let that
        // late update re-add the session on clients
        s.removeAllListeners('update');
        s.removeAllListeners('transcript');
        sessions.delete(msg.id);
        broadcast({ type: 'session_removed', id: msg.id });
      }
      break;
    }
    case 'get_backlog': {
      const s = requireSession(msg.id);
      sendTo(ws, { type: 'backlog', id: s.id, events: s.transcript });
      break;
    }
    case 'get_usage': {
      const usage = await collectUsage();
      sendTo(ws, { type: 'usage', reqId: msg.reqId, usage });
      break;
    }
    case 'get_limits': {
      // plan limits only — no transcript scan, cheap enough to poll
      sendTo(ws, { type: 'limits', reqId: msg.reqId, limits: await getPlanLimits() });
      break;
    }
    case 'get_git': {
      const dir = expandHome(String(msg.dir || '').trim() || DEV_ROOT);
      sendTo(ws, { type: 'git_info', reqId: msg.reqId, dir: msg.dir, info: await getGitInfo(dir) });
      break;
    }
    case 'list_history': {
      const dir = expandHome(String(msg.dir || '').trim() || DEV_ROOT);
      sendTo(ws, { type: 'history', reqId: msg.reqId, dir: msg.dir, sessions: await listHistory(dir) });
      break;
    }
    case 'delete_history': {
      const dir = expandHome(String(msg.dir || '').trim() || DEV_ROOT);
      await deleteHistory(dir, String(msg.id));
      // respond with the refreshed list so the UI updates in place
      sendTo(ws, { type: 'history', reqId: msg.reqId, dir: msg.dir, sessions: await listHistory(dir) });
      break;
    }
    case 'get_skill_meta': {
      const dir = expandHome(String(msg.dir || '').trim() || DEV_ROOT);
      sendTo(ws, { type: 'skill_meta', reqId: msg.reqId, dir: msg.dir, skills: await getSkillMeta(dir) });
      break;
    }
    case 'list_dirs': {
      const entries = await readdir(DEV_ROOT, { withFileTypes: true }).catch(() => []);
      sendTo(ws, {
        type: 'dirs',
        reqId: msg.reqId,
        root: DEV_ROOT,
        dirs: entries.filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name),
      });
      break;
    }
    default:
      throw new Error(`unknown message type: ${msg.type}`);
  }
}

// A compact, spoken-assistant-friendly snapshot of a session's current
// activity — handed to Minty so it can answer "what's it doing?" about the
// focused session directly, without spending a tool call (and a slow round
// trip) to fetch it.
function summarizeForMinty(session) {
  const recent = session.transcript
    .filter((e) => e.kind === 'assistant_text' || e.kind === 'user_text')
    .slice(-4)
    .map((e) => ({
      role: e.kind === 'user_text' ? 'user' : 'assistant',
      text: String(e.text || '').slice(0, 500),
    }));
  return {
    id: session.id,
    name: session.name,
    dir: session.dir,
    state: session.state,
    currentTool: session.currentTool || null,
    recentMessages: recent,
  };
}

async function createSession(msg) {
  const dir = msg.dir && String(msg.dir).trim() ? expandHome(String(msg.dir).trim()) : DEV_ROOT;
  const st = await stat(dir).catch(() => null);
  if (!st?.isDirectory()) throw new Error(`not a directory: ${dir}`);
  // routes the session's `claude` process at the local Qwen proxy instead of
  // the Anthropic API — see server/localmodel.mjs
  let env;
  if (isLocalModel(msg.model)) {
    await ensureLocalModelReady();
    env = localModelEnv();
  }
  const session = new ClaudeSession({
    name: msg.name,
    dir,
    model: msg.model,
    permissionMode: msg.permissionMode,
    resume: msg.resume,
    env,
  });
  if (msg.resume) {
    session.transcript = await loadTranscript(dir, msg.resume).catch(() => []);
  }
  wireSession(session);
  sessions.set(session.id, session);
  session.start();
  broadcast({ type: 'session_update', session: session.summary() });
  return session;
}

function requireSession(id) {
  const s = sessions.get(id);
  if (!s) throw new Error(`no such session: ${id}`);
  return s;
}

function wireSession(session) {
  session.on('update', () =>
    broadcast({ type: 'session_update', session: session.summary() })
  );
  session.on('transcript', (entry) =>
    broadcast({ type: 'session_event', id: session.id, event: entry })
  );
  // a rename that happened before the CLI assigned this session an id
  // (e.g. renamed before the first message was sent) couldn't be persisted
  // yet — do it now that we have the id the history list keys off of
  session.on('claude-session-id', (claudeSessionId) => {
    if (session.renamed) saveSessionName(session.dir, claudeSessionId, session.name).catch(() => {});
  });
}

function expandHome(p) {
  return p.startsWith('~') ? join(os.homedir(), p.slice(1)) : p;
}

function sendTo(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

function broadcast(obj) {
  const data = JSON.stringify(obj);
  for (const ws of clients) if (ws.readyState === ws.OPEN) ws.send(data);
}

// ── Minty MCP server ──────────────────────────────────────────────────────

const sessionManager = {
  getSessions: () => Array.from(sessions.values()),
  getSession: (id) => sessions.get(id),
  getActiveSession: () => null, // can be enhanced to track active session
};

setMintyMCPSessionManager(sessionManager);

// MCP server will be spawned separately via .mcp.json when claude processes connect

// ── lifecycle ──────────────────────────────────────────────────────────────

// Fire-and-forget, kicked off before the HTTP bind so it overlaps with the
// rest of startup: gets whisper-server past its ~8s cold start (Metal shader
// compile + model load) before anyone hits Space for the first time.
warmUpWhisper();
// same reasoning — Minty's brain defaults to the local Qwen model, and its
// cold start (Ollama + the translation proxy booting) is much longer than
// whisper's, so it's worth overlapping with server startup too.
if (minty.usesLocalModel()) warmUpLocalModel();
// same reasoning — the local TTS server's MLX model load is worth
// overlapping with the rest of startup too.
warmUpTts();

httpServer.listen(PORT, HOST, () => {
  console.log(`Personal Claude → http://localhost:${PORT}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    for (const s of sessions.values()) s.stop();
    minty.stop();
    stopWhisper();
    stopLocalModel();
    stopTts();
    httpServer.close();
    setTimeout(() => process.exit(0), 500).unref();
  });
}
