import { useEffect } from 'react';
import { useStore, wsSend } from './store';
import { Particles } from './components/Particles';
import { SessionRail } from './components/SessionRail';
import { Transcript } from './components/Transcript';
import { Composer } from './components/Composer';
import { Hud } from './components/Hud';
import { SkillsPanel } from './components/SkillsPanel';
import { NewSession } from './components/NewSession';
import { UsagePanel } from './components/UsagePanel';
import { GraphifyTab } from './components/GraphifyTab';

export default function App() {
  const connected = useStore((s) => s.connected);
  const activeTab = useStore((s) => s.activeTab);
  const setActiveTab = useStore((s) => s.setActiveTab);
  const activeId = useStore((s) => s.activeId);
  const session = useStore((s) => (s.activeId ? s.sessions[s.activeId] : null));
  const events = useStore((s) => (s.activeId ? s.transcripts[s.activeId] ?? [] : []));
  const order = useStore((s) => s.order);
  const setActive = useStore((s) => s.setActive);
  const showNewSession = useStore((s) => s.showNewSession);
  const setShowNewSession = useStore((s) => s.setShowNewSession);
  const showUsage = useStore((s) => s.showUsage);
  const limitExceeded = useStore(
    (s) => s.limits?.some((l) => l.percent >= 100 || l.severity === 'exceeded') ?? false
  );

  // deep-link the active tab via ?tab=graphify
  useEffect(() => {
    const t = new URLSearchParams(location.search).get('tab');
    if (t === 'graphify' || t === 'claude') setActiveTab(t);
  }, [setActiveTab]);

  // ⌘1..9 session switching, ⌘N new session (only in the Claude tab)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (activeTab !== 'claude') return;
      if (e.key >= '1' && e.key <= '9') {
        const id = order[Number(e.key) - 1];
        if (id) {
          e.preventDefault();
          setActive(id);
        }
      } else if (e.key.toLowerCase() === 'n' && !e.shiftKey) {
        e.preventDefault();
        setShowNewSession(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [order, setActive, setShowNewSession, activeTab]);

  return (
    <div className="shell">
      <Particles state={session?.state ?? 'idle'} />
      {limitExceeded && <div className="limit-glow" aria-hidden="true" />}

      <nav className="tabbar">
        <button
          className={`tab ${activeTab === 'claude' ? 'active' : ''}`}
          onClick={() => setActiveTab('claude')}
        >
          Claude
        </button>
        <button
          className={`tab ${activeTab === 'graphify' ? 'active' : ''}`}
          onClick={() => setActiveTab('graphify')}
        >
          Graphify
        </button>
      </nav>

      {activeTab === 'claude' ? (
        <div className="app">
          <SessionRail />

          <main className="workspace">
            {!connected && <div className="banner">reconnecting to server…</div>}
            {session ? (
              <>
                <Transcript events={events} />
                <Composer session={session} />
                <Hud session={session} />
              </>
            ) : (
              <div className="empty-state glass">
                <h1>Personal Claude</h1>
                <p>Your graphical shell over Claude Code. Everything stays on this machine.</p>
                <button className="btn btn-primary" onClick={() => setShowNewSession(true)}>
                  ＋ Start a session
                </button>
                <p className="hint">⌘N new session · ⌘1–9 switch</p>
              </div>
            )}
          </main>

          {session && (
            <SkillsPanel
              session={session}
              onDescribe={(text) => activeId && wsSend({ type: 'send', id: activeId, text })}
            />
          )}
        </div>
      ) : (
        <GraphifyTab />
      )}

      {showNewSession && <NewSession />}
      {showUsage && <UsagePanel />}
    </div>
  );
}
