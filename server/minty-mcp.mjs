// Minty MCP Server — exposes Personal Claude session data (chatbox content,
// session information, UI feedback) as MCP tools for the Minty brain process.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

// These are populated by setSessionManager() before the server starts
let sessionManager = null;

export class MintyMCPServer {
  constructor() {
    this.server = new Server(
      {
        name: 'minty-personal-claude',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'list_sessions',
          description: 'List all active Claude Code sessions with their current state',
          inputSchema: {
            type: 'object',
            properties: {},
            required: [],
          },
        },
        {
          name: 'get_session_info',
          description: 'Get detailed information about a specific session (state, model, directory, activity)',
          inputSchema: {
            type: 'object',
            properties: {
              session_id: {
                type: 'string',
                description: 'The session ID to query',
              },
            },
            required: ['session_id'],
          },
        },
        {
          name: 'get_session_transcript',
          description: 'Get the chatbox transcript from a session (recent messages from Claude and user)',
          inputSchema: {
            type: 'object',
            properties: {
              session_id: {
                type: 'string',
                description: 'The session ID to get transcript from',
              },
              limit: {
                type: 'number',
                description: 'Maximum number of transcript entries to return (default: 20)',
              },
            },
            required: ['session_id'],
          },
        },
        {
          name: 'get_session_last_output',
          description: 'Get the most recent assistant message and tool activity from a session',
          inputSchema: {
            type: 'object',
            properties: {
              session_id: {
                type: 'string',
                description: 'The session ID to query',
              },
            },
            required: ['session_id'],
          },
        },
        {
          name: 'get_ui_state',
          description: 'Get current Personal Claude UI state (active session, overall status)',
          inputSchema: {
            type: 'object',
            properties: {},
            required: [],
          },
        },
        {
          name: 'get_session_context',
          description: 'Get context window usage for a session (token usage and limits)',
          inputSchema: {
            type: 'object',
            properties: {
              session_id: {
                type: 'string',
                description: 'The session ID to query',
              },
            },
            required: ['session_id'],
          },
        },
      ],
    }));

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, (request) =>
      this.handleToolCall(request.params.name, request.params.arguments)
    );
  }

  async handleToolCall(toolName, args) {
    if (!sessionManager) {
      return {
        content: [{ type: 'text', text: 'Error: Session manager not initialized' }],
        isError: true,
      };
    }

    try {
      let result;
      switch (toolName) {
        case 'list_sessions':
          result = await this.listSessions();
          break;
        case 'get_session_info':
          result = await this.getSessionInfo(args.session_id);
          break;
        case 'get_session_transcript':
          result = await this.getSessionTranscript(args.session_id, args.limit || 20);
          break;
        case 'get_session_last_output':
          result = await this.getSessionLastOutput(args.session_id);
          break;
        case 'get_ui_state':
          result = await this.getUiState();
          break;
        case 'get_session_context':
          result = await this.getSessionContext(args.session_id);
          break;
        default:
          return {
            content: [{ type: 'text', text: `Unknown tool: ${toolName}` }],
            isError: true,
          };
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${err.message}` }],
        isError: true,
      };
    }
  }

  async listSessions() {
    const sessions = sessionManager.getSessions();
    return sessions.map((s) => ({
      id: s.id,
      name: s.name,
      dir: s.dir,
      state: s.state,
      model: s.model,
      startedAt: new Date(s.startedAt).toISOString(),
      lastActivity: new Date(s.lastActivity).toISOString(),
    }));
  }

  async getSessionInfo(sessionId) {
    const session = sessionManager.getSession(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);

    return {
      id: session.id,
      name: session.name,
      dir: session.dir,
      model: session.model,
      state: session.state,
      permissionMode: session.permissionMode,
      startedAt: new Date(session.startedAt).toISOString(),
      lastActivity: new Date(session.lastActivity).toISOString(),
      totals: session.totals,
      currentTool: session.currentTool,
      lastError: session.lastError,
      contextInfo: session.contextInfo,
    };
  }

  async getSessionTranscript(sessionId, limit) {
    const session = sessionManager.getSession(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);

    const transcript = session.transcript.slice(-limit);
    return {
      sessionId,
      entries: transcript.map((entry) => ({
        kind: entry.kind,
        text: entry.text,
        tool: entry.tool,
        images: entry.images,
        timestamp: entry.timestamp,
      })),
      count: transcript.length,
    };
  }

  async getSessionLastOutput(sessionId) {
    const session = sessionManager.getSession(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);

    const transcript = session.transcript;
    if (!transcript.length) return { sessionId, lastOutput: null };

    // Find the last assistant message and any tool use/results after it
    let lastAssistantIdx = -1;
    for (let i = transcript.length - 1; i >= 0; i--) {
      if (transcript[i].kind === 'assistant_text') {
        lastAssistantIdx = i;
        break;
      }
    }

    if (lastAssistantIdx === -1) return { sessionId, lastOutput: null };

    const output = {
      assistantMessage: transcript[lastAssistantIdx],
      toolActivity: [],
    };

    // Collect any tool_use and tool_result after the last assistant message
    for (let i = lastAssistantIdx + 1; i < transcript.length; i++) {
      if (transcript[i].kind === 'tool_use' || transcript[i].kind === 'tool_result') {
        output.toolActivity.push(transcript[i]);
      }
    }

    return output;
  }

  async getUiState() {
    const sessions = sessionManager.getSessions();
    const activeSession = sessionManager.getActiveSession?.() || null;
    const sessionsWithState = sessions.map((s) => ({
      id: s.id,
      name: s.name,
      state: s.state,
      lastActivity: s.lastActivity,
    }));

    return {
      activeSessionId: activeSession?.id || null,
      sessions: sessionsWithState,
      sessionCount: sessions.length,
      timestamp: new Date().toISOString(),
    };
  }

  async getSessionContext(sessionId) {
    const session = sessionManager.getSession(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);

    return {
      sessionId,
      contextInfo: session.contextInfo || { message: 'Context information not available' },
      totals: session.totals,
    };
  }

  async start() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('Minty MCP server started');
  }

  stop() {
    // Cleanup if needed
  }
}

export function setMintyMCPSessionManager(manager) {
  sessionManager = manager;
}
