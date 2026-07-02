export type SessionState =
  | 'starting'
  | 'idle'
  | 'thinking'
  | 'tool_running'
  | 'streaming_output'
  | 'waiting_input'
  | 'done'
  | 'error'
  | 'closed';

export interface InitInfo {
  model: string;
  permissionMode: string;
  tools: string[];
  slashCommands: string[];
  skills: string[];
  plugins: string[];
  claudeCodeVersion: string;
}

export interface SessionSummary {
  id: string;
  name: string;
  dir: string;
  model: string | null;
  permissionMode: string;
  state: SessionState;
  alive: boolean;
  claudeSessionId: string | null;
  currentTool: string | null;
  turnStartedAt: number | null;
  startedAt: number;
  lastActivity: number;
  totals: { costUsd: number; inputTokens: number; outputTokens: number; turns: number };
  lastError: string | null;
  initInfo: InitInfo | null;
}

export interface ImageAttachment {
  media_type: string;
  data: string; // base64, no data: prefix
}

export interface TranscriptEvent {
  kind:
    | 'user_text'
    | 'assistant_text'
    | 'thinking'
    | 'tool_use'
    | 'tool_result'
    | 'result'
    | 'system';
  ts: number;
  seq: number;
  text?: string;
  images?: ImageAttachment[];
  tool?: string;
  toolUseId?: string;
  input?: unknown;
  isError?: boolean;
  subtype?: string;
  durationMs?: number;
  costUsd?: number;
}

export interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  costUsd: number;
  messages: number;
}

export interface UsageBucket extends UsageTotals {
  byModel: Record<string, UsageTotals>;
}

export interface PlanLimit {
  kind: string; // 'session' | 'weekly_all' | 'weekly_scoped' | …
  percent: number;
  resetsAt: string | null;
  severity: string; // 'normal' | 'warning' | …
  scopeLabel: string | null; // e.g. 'Fable' for weekly_scoped
}

export interface UsageReport {
  generatedAt: number;
  windows: { block: UsageBucket; today: UsageBucket; week: UsageBucket };
  limits: PlanLimit[] | null;
}

export type ServerMessage =
  | { type: 'hello'; sessions: SessionSummary[]; devRoot: string }
  | { type: 'usage'; reqId?: string; usage: UsageReport }
  | { type: 'limits'; reqId?: string; limits: PlanLimit[] | null }
  | { type: 'session_update'; session: SessionSummary }
  | { type: 'session_event'; id: string; event: TranscriptEvent }
  | { type: 'session_removed'; id: string }
  | { type: 'backlog'; id: string; events: TranscriptEvent[] }
  | { type: 'dirs'; reqId?: string; root: string; dirs: string[] }
  | { type: 'created'; reqId?: string; id: string }
  | { type: 'error'; reqId?: string; message: string };

export const STATE_META: Record<SessionState, { label: string; color: string; icon: string }> = {
  starting: { label: 'Starting', color: '#8b93a7', icon: '◌' },
  idle: { label: 'Idle', color: '#64748b', icon: '○' },
  thinking: { label: 'Thinking', color: '#8b7cf6', icon: '◐' },
  tool_running: { label: 'Running tool', color: '#22d3ee', icon: '⚙' },
  streaming_output: { label: 'Writing', color: '#34d399', icon: '≋' },
  waiting_input: { label: 'Needs you', color: '#fbbf24', icon: '⏸' },
  done: { label: 'Done', color: '#f8fafc', icon: '✓' },
  error: { label: 'Error', color: '#fb7185', icon: '✕' },
  closed: { label: 'Closed', color: '#475569', icon: '—' },
};
