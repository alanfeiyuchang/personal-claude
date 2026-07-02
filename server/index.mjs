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
import { listHistory, deleteHistory, loadTranscript } from './history.mjs';
import { getGitInfo } from './git.mjs';

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
  });
});

async function handleClientMessage(ws, msg) {
  switch (msg.type) {
    case 'create': {
      const dir = msg.dir && msg.dir.trim() ? expandHome(msg.dir.trim()) : DEV_ROOT;
      const st = await stat(dir).catch(() => null);
      if (!st?.isDirectory()) throw new Error(`not a directory: ${dir}`);
      const session = new ClaudeSession({
        name: msg.name,
        dir,
        model: msg.model,
        permissionMode: msg.permissionMode,
        resume: msg.resume,
      });
      if (msg.resume) {
        session.transcript = await loadTranscript(dir, msg.resume).catch(() => []);
      }
      wireSession(session);
      sessions.set(session.id, session);
      session.start();
      broadcast({ type: 'session_update', session: session.summary() });
      sendTo(ws, { type: 'created', reqId: msg.reqId, id: session.id });
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
      requireSession(msg.id).rename(String(msg.name ?? ''));
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

// ── lifecycle ──────────────────────────────────────────────────────────────

httpServer.listen(PORT, HOST, () => {
  console.log(`Personal Claude → http://localhost:${PORT}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    for (const s of sessions.values()) s.stop();
    httpServer.close();
    setTimeout(() => process.exit(0), 500).unref();
  });
}
