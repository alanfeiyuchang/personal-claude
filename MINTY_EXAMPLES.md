# Minty MCP Tool Examples

These examples show what Minty can now ask via MCP tools to understand the current state of Personal Claude.

## Example Queries Minty Can Handle

### "What's the latest update?"
Minty can now call `list_sessions()` and `get_session_last_output(session_id)` to tell you what Claude is currently working on.

```
User: "What's the latest update?"
↓
Minty calls: list_sessions()
Response: [
  {id: "abc123", name: "personal-claude", state: "streaming_output", ...}
]
↓
Minty calls: get_session_last_output("abc123")
Response: {
  assistantMessage: {
    kind: "assistant_text",
    text: "I've updated the MCP server integration to allow real-time session access..."
  },
  toolActivity: [...]
}
↓
Minty speaks: "Claude is working on the Personal Claude project. He's currently writing about the MCP server integration."
```

### "Show me the transcript"
Minty can fetch recent chat history from a session.

```
User: "Show me the transcript from the main session"
↓
Minty calls: get_session_transcript("abc123", 10)
Response: {
  entries: [
    {kind: "user_text", text: "Add MCP integration for Minty"},
    {kind: "assistant_text", text: "I'll create an MCP server..."},
    {kind: "tool_use", tool: "Write", ...},
    {kind: "tool_result", text: "File written successfully"},
    ...
  ]
}
↓
Minty speaks: "Here's what's been happening: You asked Claude to add MCP integration. Claude created the MCP server files..."
```

### "How much context is left?"
Minty can check token usage.

```
User: "How much context is left?"
↓
Minty calls: get_session_context("abc123")
Response: {
  contextInfo: {
    usedTokens: 45000,
    windowTokens: 100000,
    percent: 45
  },
  totals: {
    inputTokens: 450000,
    outputTokens: 150000,
    costUsd: 2.85
  }
}
↓
Minty speaks: "You're using 45% of the context window. You've spent $2.85 so far."
```

### "Stop working"
Minty can interrupt a session.

```
User: "Stop, I need to interrupt this"
↓
Minty calls: list_sessions()
Finds active session
↓
Minty emits action: {type: "interrupt", sessionId: "abc123"}
↓
Claude Code session receives interrupt
Minty speaks: "OK, I've stopped the session."
```

### "What sessions are running?"
Minty can list all active sessions with their states.

```
User: "What's running right now?"
↓
Minty calls: list_sessions()
Response: [
  {
    id: "abc123",
    name: "personal-claude",
    state: "streaming_output",
    model: "claude-opus-4-8",
    dir: "/Users/changfeiyu/Desktop/Development/personal-claude"
  },
  {
    id: "def456",
    name: "my-app",
    state: "idle",
    model: "claude-opus-4-8",
    dir: "/Users/changfeiyu/Desktop/Development/my-app"
  }
]
↓
Minty speaks: "Two sessions are running. Personal Claude is actively streaming. My App session is idle."
```

## MCP Tool Reference

All tools return JSON that Minty can parse to understand the current state:

### `list_sessions()`
Returns all active Claude Code sessions with ID, name, directory, state, model, and timestamps.

**Use when:** User asks "what's running", "what sessions exist", "what are you working on"

### `get_session_info(session_id)`
Returns detailed info about a specific session including tokens used, errors, current tool.

**Use when:** User asks about a specific session's details

### `get_session_transcript(session_id, limit?)`
Returns recent chatbox messages (default last 20) from a session.

**Use when:** User asks "show me the transcript", "what have we been working on", "recap the conversation"

### `get_session_last_output(session_id)`
Returns the most recent assistant message and any tool activity that follows.

**Use when:** User asks "what's the latest", "what did it just do", "show me the result"

### `get_ui_state()`
Returns current Personal Claude UI state (which session is active, count of sessions).

**Use when:** User asks about overall Personal Claude state

### `get_session_context(session_id)`
Returns token usage and context window information.

**Use when:** User asks "how much context is left", "token usage", "am I approaching the limit"

## System Prompt Guidance

Minty's system prompt instructs it to:

1. **Use tools when relevant:** "Use MCP tools to answer questions about what's happening in Personal Claude or specific sessions"
2. **Query before acting:** Before answering "what's the latest", call the tools to get real data
3. **Keep responses conversational:** Minty extracts the useful info from JSON responses and speaks naturally
4. **Handle ambiguity:** If unclear which session, ask or use `list_sessions()` first

## Testing

To test this interactively:

1. Start Personal Claude: `npm start`
2. Create a session in the UI
3. Send a prompt to that session
4. Talk to Minty: "What's the latest update?"
5. Minty should query the MCP server and tell you what's happening

## Troubleshooting

**"Minty can't access sessions"**
- Ensure Personal Claude server is running on localhost:4317
- Check that MCP config in `.mcp.json` is correct
- Verify `.claude/settings.json` enables the MCP server

**"MCP server fails to start"**
- Ensure `@modelcontextprotocol/sdk` is installed: `npm install`
- Check WebSocket connection: `PC_WS_URL=ws://127.0.0.1:4317/ws`
- See console output for detailed errors

**"Minty gives stale data"**
- MCP server syncs via WebSocket. Give it a moment after session state changes.
- Sessions update every time a message arrives or state changes.
