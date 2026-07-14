// Stdio entry point for the Minty MCP server.
// This is called by the claude CLI to provide Personal Claude session access to Minty.

import { MintyMCPServer, setMintyMCPSessionManager } from './minty-mcp.mjs';

// Session manager that proxies to the main Personal Claude server via WebSocket
const sessionStore = new Map();
let wsClient = null;

const sessionManager = {
  getSessions: () => Array.from(sessionStore.values()),
  getSession: (id) => sessionStore.get(id),
  getActiveSession: () => null,
};

setMintyMCPSessionManager(sessionManager);

// Connect to Personal Claude server via WebSocket to receive session updates.
// This runs in the background and retries indefinitely: the main Personal Claude
// server may not be running yet (or at all) when the CLI launches this MCP server,
// and a missing connection must not prevent the MCP server from starting.
async function connectToServer() {
  const WebSocket = (await import('ws')).default;
  const serverUrl = process.env.PC_WS_URL || 'ws://127.0.0.1:4317/ws';

  const ws = new WebSocket(serverUrl);

  ws.on('open', () => {
    console.error('[Minty MCP] Connected to Personal Claude server');
    wsClient = ws;
  });

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === 'session_update' && msg.session) {
        sessionStore.set(msg.session.id, msg.session);
      } else if (msg.type === 'session_removed') {
        sessionStore.delete(msg.id);
      } else if (msg.type === 'session_event' && msg.event) {
        const session = sessionStore.get(msg.id);
        if (session) {
          if (!session.transcript) session.transcript = [];
          session.transcript.push(msg.event);
        }
      }
    } catch {
      // Ignore parse errors
    }
  });

  ws.on('error', (err) => {
    // Connection failures are expected when the main server isn't up yet.
    // 'close' fires afterwards and schedules the retry.
    console.error('[Minty MCP] WebSocket error:', err.message);
  });

  ws.on('close', () => {
    if (wsClient === ws) wsClient = null;
    console.error('[Minty MCP] Disconnected from Personal Claude server, retrying in 2s');
    // Reconnect after a delay
    setTimeout(connectToServer, 2000).unref();
  });
}

const server = new MintyMCPServer();

// Start the MCP server immediately so the CLI sees it as connected, then attempt
// to reach the Personal Claude server in the background.
server.start().catch((err) => {
  console.error('Failed to start Minty MCP server:', err);
  process.exit(1);
});

connectToServer().catch((err) => {
  console.error('[Minty MCP] Initial connection attempt failed:', err.message);
});

// Cleanup
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    if (wsClient) wsClient.close();
    server.stop();
    process.exit(0);
  });
}
