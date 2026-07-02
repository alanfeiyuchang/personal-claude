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

export default function App() {
  const connected = useStore((s) => s.connected);
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

  // ⌘1..9 session switching, ⌘N new session
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
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
  }, [order, setActive, setShowNewSession]);

  return (
    <div className="app">
      <Particles state={session?.state ?? 'idle'} />
      {limitExceeded && <div className="limit-glow" aria-hidden="true" />}

      <SessionRail />

      <main className="workspace">
        {!connected && <div className="banner">reconnecting to server…</div>}
        {session ? (
          <>
            <Hud session={session} />
            <Transcript events={events} />
            <Composer session={session} />
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

      {showNewSession && <NewSession />}
      {showUsage && <UsagePanel />}
    </div>
  );
}
