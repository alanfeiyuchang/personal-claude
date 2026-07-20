import { create } from 'zustand';
import type {
  SessionSummary,
  TranscriptEvent,
  ServerMessage,
  PlanLimit,
  UsageBucket,
  HistorySession,
  GitInfo,
  SkillMeta,
  MintyPhase,
} from './types';

export type Tab = 'claude' | 'graphify';

interface Store {
  connected: boolean;
  activeTab: Tab;
  devRoot: string;
  sessions: Record<string, SessionSummary>;
  order: string[];
  transcripts: Record<string, TranscriptEvent[]>;
  activeId: string | null;
  dirs: string[];
  dirChosen: { reqId: string; path: string | null; error?: string } | null;
  showNewSession: boolean;
  showUsage: boolean;
  limits: PlanLimit[] | null;
  usageBlock: UsageBucket | null; // last-5-hours window, shown at the bottom of the usage panel
  history: { dir: string; sessions: HistorySession[] } | null;
  git: { dir: string; info: GitInfo } | null;
  skillMeta: Record<string, SkillMeta>;
  minty: { phase: MintyPhase; transcript: string; say: string; stream: string; done: boolean };
  mintyTask: { sessionId: string; text: string; nonce: number } | null;
  transcribeResult: { reqId: string; text: string; error?: string } | null;

  setMinty: (
    patch: Partial<{ phase: MintyPhase; transcript: string; say: string; stream: string; done: boolean }>
  ) => void;
  clearMintyTask: () => void;
  clearTranscribeResult: () => void;

  setActiveTab: (t: Tab) => void;
  setActive: (id: string) => void;
  setShowNewSession: (v: boolean) => void;
  setShowUsage: (v: boolean) => void;
  handleServerMessage: (msg: ServerMessage) => void;
  markDisconnected: () => void;
}

export const useStore = create<Store>((set, get) => ({
  connected: false,
  activeTab: 'claude',
  devRoot: '',
  sessions: {},
  order: [],
  transcripts: {},
  activeId: null,
  dirs: [],
  dirChosen: null,
  showNewSession: false,
  showUsage: false,
  limits: null,
  usageBlock: null,
  history: null,
  git: null,
  skillMeta: {},
  minty: { phase: 'idle', transcript: '', say: '', stream: '', done: false },
  mintyTask: null,
  transcribeResult: null,

  setMinty: (patch) => set((prev) => ({ minty: { ...prev.minty, ...patch } })),
  clearMintyTask: () => set({ mintyTask: null }),
  clearTranscribeResult: () => set({ transcribeResult: null }),

  setActiveTab: (t) => set({ activeTab: t }),
  setActive: (id) => set({ activeId: id }),
  setShowNewSession: (v) => set({ showNewSession: v }),
  setShowUsage: (v) => {
    set({ showUsage: v });
    if (v) {
      wsSend({ type: 'get_usage' });
      for (const id of get().order) wsSend({ type: 'get_context', id });
    }
  },
  markDisconnected: () => set({ connected: false }),

  handleServerMessage: (msg) => {
    const st = get();
    switch (msg.type) {
      case 'hello': {
        const sessions: Record<string, SessionSummary> = {};
        const order: string[] = [];
        for (const s of msg.sessions) {
          sessions[s.id] = s;
          order.push(s.id);
        }
        set({
          connected: true,
          devRoot: msg.devRoot,
          sessions,
          order,
          activeId: st.activeId && sessions[st.activeId] ? st.activeId : order[0] ?? null,
        });
        // refresh backlogs after (re)connect
        for (const id of order) wsSend({ type: 'get_backlog', id });
        break;
      }
      case 'session_update': {
        const s = msg.session;
        if (s.state === 'closed') {
          // closed sessions leave the rail immediately
          set((prev) => {
            const sessions = { ...prev.sessions };
            delete sessions[s.id];
            const order = prev.order.filter((x) => x !== s.id);
            return {
              sessions,
              order,
              activeId: prev.activeId === s.id ? order[0] ?? null : prev.activeId,
            };
          });
          break;
        }
        // a finished turn is the moment plan-limit numbers move
        if (s.state === 'done' && st.sessions[s.id]?.state !== 'done') {
          wsSend({ type: 'get_limits' });
        }
        set((prev) => ({
          sessions: { ...prev.sessions, [s.id]: s },
          order: prev.order.includes(s.id) ? prev.order : [...prev.order, s.id],
          activeId: prev.activeId ?? s.id,
        }));
        break;
      }
      case 'session_event': {
        set((prev) => {
          const list = prev.transcripts[msg.id] ?? [];
          return { transcripts: { ...prev.transcripts, [msg.id]: [...list, msg.event] } };
        });
        break;
      }
      case 'backlog': {
        set((prev) => ({
          transcripts: { ...prev.transcripts, [msg.id]: msg.events },
        }));
        break;
      }
      case 'session_removed': {
        set((prev) => {
          const sessions = { ...prev.sessions };
          delete sessions[msg.id];
          const order = prev.order.filter((x) => x !== msg.id);
          return {
            sessions,
            order,
            activeId: prev.activeId === msg.id ? order[0] ?? null : prev.activeId,
          };
        });
        break;
      }
      case 'limits': {
        if (msg.limits) set({ limits: msg.limits });
        break;
      }
      case 'usage': {
        set({
          usageBlock: msg.usage.windows.block,
          ...(msg.usage.limits ? { limits: msg.usage.limits } : {}),
        });
        break;
      }
      case 'history': {
        set({ history: { dir: msg.dir, sessions: msg.sessions } });
        break;
      }
      case 'git_info': {
        set({ git: { dir: msg.dir, info: msg.info } });
        break;
      }
      case 'skill_meta': {
        // merge: bare-name entries from one dir stay useful across sessions
        set((prev) => ({ skillMeta: { ...prev.skillMeta, ...msg.skills } }));
        break;
      }
      case 'transcribed': {
        set({ transcribeResult: { reqId: msg.reqId ?? '', text: msg.text, error: msg.error } });
        break;
      }
      case 'minty_say': {
        set((prev) => ({
          minty: { ...prev.minty, phase: 'speaking', stream: prev.minty.stream + msg.delta },
        }));
        break;
      }
      case 'minty_reply': {
        set((prev) => ({ minty: { ...prev.minty, phase: 'speaking', say: msg.say, done: true } }));
        const a = msg.action;
        if (a?.type === 'focus' && a.sessionId) set({ activeId: a.sessionId });
        if (a?.type === 'task' && a.sessionId && a.text) {
          // focus the target session; Composer picks this up, fills the box,
          // and auto-sends — the "types it for you" moment
          set({
            activeId: a.sessionId,
            mintyTask: { sessionId: a.sessionId, text: a.text, nonce: Date.now() },
          });
        }
        break;
      }
      case 'created': {
        // focus the workspace on the session just created/resumed by this client
        set({ activeId: msg.id });
        // resumed sessions arrive with a seeded transcript that wasn't
        // streamed as session_event — fetch it explicitly
        wsSend({ type: 'get_backlog', id: msg.id });
        break;
      }
      case 'dirs': {
        set({ dirs: msg.dirs, devRoot: msg.root });
        break;
      }
      case 'dir_chosen': {
        set({ dirChosen: { reqId: msg.reqId ?? '', path: msg.path } });
        break;
      }
      case 'error': {
        console.error('server error:', msg.message);
        // unstick anything waiting on this reqId (e.g. the directory
        // picker) instead of leaving it hung forever with no feedback —
        // a server-side failure is still a settled outcome, just a failed one
        if (msg.reqId) set({ dirChosen: { reqId: msg.reqId, path: null, error: msg.message } });
        break;
      }
    }
  },
}));

// ── WebSocket client with reconnect ────────────────────────────────────────

let ws: WebSocket | null = null;
let queue: string[] = [];

export function wsSend(obj: unknown) {
  const data = JSON.stringify(obj);
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(data);
  else queue.push(data);
}

export function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => {
    for (const data of queue) ws!.send(data);
    queue = [];
    wsSend({ type: 'list_dirs' });
  };
  ws.onmessage = (e) => {
    try {
      useStore.getState().handleServerMessage(JSON.parse(e.data));
    } catch (err) {
      console.error('bad server message', err);
    }
  };
  ws.onclose = () => {
    useStore.getState().markDisconnected();
    setTimeout(connect, 1500);
  };
}
