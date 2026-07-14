# Minty Voice Assistant - Permission & MCP Setup

## Overview

This setup grants Minty (Personal Claude's voice assistant) permission to access and view all chatbox content, session information, and UI feedback from Claude Code sessions via the Model Context Protocol (MCP).

## What Changed

### 1. New MCP Server Implementation

**Files Created:**
- `server/minty-mcp.mjs` - Core MCP server implementation with tools for querying session data
- `server/minty-mcp-stdio.mjs` - Stdio entry point that connects to Personal Claude server

**Files Updated:**
- `server/minty.mjs` - Updated to use MCP config and enhanced system prompt
- `server/index.mjs` - Added session manager initialization for MCP

**Configuration Files:**
- `.mcp.json` - MCP server configuration (defines how claude spawns the MCP server)
- `.claude/settings.json` - Claude Code permissions (enables MCP tools for Minty)

**Dependencies:**
- `package.json` - Added `@modelcontextprotocol/sdk` to dependencies

### 2. MCP Tools Available to Minty

Minty can now call these tools to query session state:

| Tool | Purpose | Example |
|------|---------|---------|
| `list_sessions()` | Get all active sessions | "What's running?" |
| `get_session_info(id)` | Get detailed session info | "Show me session details" |
| `get_session_transcript(id, limit)` | Get recent chatbox messages | "What have we been working on?" |
| `get_session_last_output(id)` | Get most recent assistant message | "What did Claude just say?" |
| `get_ui_state()` | Get overall Personal Claude state | "What's the status?" |
| `get_session_context(id)` | Get token usage info | "How much context is left?" |

## How Permissions Work

### Claude Code Settings (`.claude/settings.json`)

```json
{
  "enableAllProjectMcpServers": true,
  "enabledMcpjsonServers": ["minty-personal-claude"],
  "permissions": {
    "allow": [
      "mcp_tool(minty-personal-claude:*)"
    ]
  }
}
```

**Explanation:**
- `enableAllProjectMcpServers: true` - Allow MCP servers defined in project
- `enabledMcpjsonServers: ["minty-personal-claude"]` - Explicitly enable the Minty MCP server
- `permissions.allow` - Grant permission to call any tool from the minty-personal-claude MCP server

### MCP Server Configuration (`.mcp.json`)

```json
{
  "mcpServers": {
    "minty-personal-claude": {
      "command": "node",
      "args": ["server/minty-mcp-stdio.mjs"],
      "disabled": false
    }
  }
}
```

**Explanation:**
- Defines how to spawn the MCP server (via Node.js)
- Points to the stdio entry point
- Server is enabled by default

## Data Flow

```
User speaks to Minty
    ↓
Personal Claude (ui) → sends WebSocket message to server
    ↓
Personal Claude Server broadcasts session updates
    ↓
Minty asks question (e.g., "What's the latest update?")
    ↓
Minty's system prompt suggests using MCP tools
    ↓
Minty's Claude process calls MCP tool (e.g., list_sessions)
    ↓
MCP Server (stdio) ← WebSocket receives live session data
    ↓
MCP Server responds with JSON data to Claude
    ↓
Claude constructs conversational response
    ↓
Minty speaks the answer aloud
```

## System Prompt Integration

Minty's system prompt has been updated to include:

1. **Tool Awareness**
   ```
   You have access to MCP tools (via "minty-personal-claude" server) to query session state and chatbox content:
   - list_sessions()
   - get_session_info(session_id)
   - get_session_transcript(session_id, limit?)
   - [etc.]
   ```

2. **Usage Guidance**
   ```
   Use these tools to answer questions about what's happening in Personal Claude or specific sessions, 
   e.g. "what's the latest update?" or "show me what claude is working on".
   ```

3. **Execution Rules**
   ```
   - Use MCP tools to access current session state when the user asks about what's happening.
   - Use MCP tools to get real-time state if needed.
   ```

## Installation & Verification

### Step 1: Install Dependencies
```bash
cd /Users/changfeiyu/Desktop/Development/personal-claude
npm install
```

### Step 2: Verify Setup
Check that these files exist:
```bash
ls -la .mcp.json
ls -la .claude/settings.json
ls -la server/minty-mcp.mjs
ls -la server/minty-mcp-stdio.mjs
```

### Step 3: Start Personal Claude
```bash
npm start
```

### Step 4: Test with Minty
1. Create a Claude Code session in the UI
2. Send a prompt to that session
3. Speak to Minty: "What's the latest update?"
4. Minty should query the MCP server and report on session activity

## What Minty Can Now Do

### Before (Limited)
- Minty knew about sessions passed in JSON at startup
- Static session metadata only
- No access to actual chatbox content

### After (Full Access)
- ✅ List all active sessions dynamically
- ✅ Access full chatbox transcripts
- ✅ See most recent assistant output in real-time
- ✅ Check token usage and context window status
- ✅ Query detailed session information
- ✅ Answer questions like "what's happening?" without needing you to read messages

## Permissions Explanation

**Claude Code grants these permissions:**

1. **MCP Server Access** 
   - Minty's claude process can connect to the minty-personal-claude MCP server

2. **Tool Invocation**
   - Minty can call any tool provided by the MCP server
   - Permission rule: `mcp_tool(minty-personal-claude:*)`
   - The `*` means all tools from this server

3. **Data Retrieval**
   - Tools return session data, transcripts, and state info
   - This is read-only access (no ability to modify sessions)
   - Minty gets whatever data exists in Personal Claude

**What Minty CANNOT do:**
- Directly modify Claude Code sessions (that's done via "action" objects)
- Access files or run commands outside of Claude Code
- See data from other projects or machines
- Bypass any Claude Code permission restrictions

## File Organization

```
personal-claude/
├── .mcp.json                    ← MCP server configuration
├── .claude/
│   └── settings.json           ← Claude Code permissions (NEW)
├── package.json                ← Dependencies (UPDATED)
├── server/
│   ├── index.mjs              ← Main server (UPDATED)
│   ├── minty.mjs              ← Minty brain (UPDATED)
│   ├── minty-mcp.mjs          ← MCP tools (NEW)
│   └── minty-mcp-stdio.mjs    ← MCP stdio entry (NEW)
└── MCP_SETUP.md               ← Architecture docs (NEW)
```

## Troubleshooting

**Problem:** Minty says "my brain process crashed"
- Solution: Ensure MCP server can start. Check: `npm install @modelcontextprotocol/sdk`

**Problem:** MCP tools timeout or fail
- Solution: Verify Personal Claude server is running (`npm start`)
- Check WebSocket connection to localhost:4317

**Problem:** Minty can't access recent transcripts
- Solution: Session state syncs via WebSocket. Give it a moment after new messages arrive.

**Problem:** Permission denied for MCP tools
- Solution: Verify `.claude/settings.json` has `"enabledMcpjsonServers": ["minty-personal-claude"]`

## Next Steps

1. Run `npm install` to add MCP SDK dependency
2. Start Personal Claude with `npm start`
3. Test: Create a session and ask Minty "What's the latest update?"
4. Customize MCP tools if needed (add more data, different queries)
5. Consider adding real-time UI feedback tools (e.g., user focus state)

## References

- [MCP_SETUP.md](./MCP_SETUP.md) - Technical architecture
- [MINTY_EXAMPLES.md](./MINTY_EXAMPLES.md) - Usage examples
- [Model Context Protocol Spec](https://spec.modelcontextprotocol.io/)
