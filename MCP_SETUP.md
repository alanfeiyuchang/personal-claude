# Minty MCP Integration

This document explains how Minty (the voice assistant) accesses Personal Claude session data through the Model Context Protocol (MCP).

## Architecture

```
Personal Claude Server (index.mjs)
    ↓ WebSocket messages (session updates, events)
    ↓
Minty MCP Stdio Process (minty-mcp-stdio.mjs)
    ↓ MCP tools (JSON-RPC)
    ↓
Minty Brain (minty.mjs / claude process)
    ↓
Claude Code Session (user-facing)
```

## Components

### 1. Personal Claude Server (`server/index.mjs`)
- Manages Claude Code sessions
- Broadcasts session updates via WebSocket to connected clients
- Initializes the session manager for MCP access

### 2. Minty MCP Server (`server/minty-mcp.mjs`)
- Implements MCP tools for querying session data
- Tools available:
  - `list_sessions()` - Get all active sessions with their state
  - `get_session_info(session_id)` - Get detailed session info
  - `get_session_transcript(session_id, limit?)` - Get chatbox messages
  - `get_session_last_output(session_id)` - Get most recent assistant output
  - `get_ui_state()` - Get current UI state
  - `get_session_context(session_id)` - Get token usage info

### 3. Minty MCP Stdio (`server/minty-mcp-stdio.mjs`)
- Stdio entry point for the MCP server
- Connects to Personal Claude server via WebSocket
- Syncs session state in real-time
- Provides MCP tools to Minty's claude process

### 4. Minty Brain (`server/minty.mjs`)
- Spawns a claude CLI process with MCP server configuration
- Updated system prompt explains available tools
- Can use tools to answer questions about sessions

### 5. Claude Code Configuration (`.claude/settings.json`)
- Enables the minty-personal-claude MCP server
- Grants permission to use MCP tools

## How It Works

1. **Startup**
   - Personal Claude server starts and initializes session management
   - `.mcp.json` defines how to spawn the MCP server

2. **Minty Spawns**
   - `minty.ask()` is called with user's voice input
   - Minty spawns a claude CLI process with `--mcp-config .mcp.json`
   - Claude loads the MCP server configuration

3. **MCP Connection**
   - MCP server (minty-mcp-stdio.mjs) is spawned by claude
   - MCP server connects to Personal Claude via WebSocket
   - Syncs live session state as updates arrive

4. **Tool Access**
   - Minty's system prompt instructs it to use tools when appropriate
   - Tools respond with session data, transcripts, and UI state
   - Minty can understand what's currently happening

5. **Actions**
   - Minty can respond conversationally with session info
   - Minty can spawn new tasks in existing sessions
   - Minty can focus/interrupt sessions

## Example: "What's the latest update?"

1. User says "What's the latest update?"
2. Minty receives: `{utterance: "What's the latest update?", sessions: [...]}`
3. Minty's system prompt tells it to use MCP tools for this query
4. Minty calls `list_sessions()` to see active sessions
5. Minty calls `get_session_last_output(session_id)` for the active session
6. Minty constructs a response: "Claude is currently working on fixing the authentication module in the Personal Claude project"
7. Response is read aloud via TTS

## Configuration

The MCP server is configured in `.mcp.json`:

```json
{
  "mcpServers": {
    "minty-personal-claude": {
      "command": "node",
      "args": ["server/minty-mcp-stdio.mjs"],
      "cwd": "/path/to/personal-claude"
    }
  }
}
```

Claude Code grants permissions in `.claude/settings.json`:

```json
{
  "enableAllProjectMcpServers": true,
  "enabledMcpjsonServers": ["minty-personal-claude"],
  "permissions": {
    "allow": ["mcp_tool(minty-personal-claude:*)"]
  }
}
```

## Limitations & Future Improvements

- **WebSocket Connection**: MCP server must connect to Personal Claude server via WebSocket. Ensure `PC_WS_URL` is correct or Personal Claude is running on localhost:4317.
- **Real-time Sync**: Session state is synced on WebSocket updates. Brief moments of inconsistency are possible.
- **Tool Output**: Minty sees tool responses as JSON text. Could be improved with better formatting.
- **Persistence**: MCP server state is in-memory. Reconnects will sync fresh state from server.

## Debugging

Enable verbose output:
```bash
PC_WS_URL=ws://127.0.0.1:4317/ws node server/minty-mcp-stdio.mjs
```

Monitor WebSocket messages to see what session data is available.
