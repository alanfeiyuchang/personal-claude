import { useStore, wsSend } from '../store';
import { STATE_META } from '../types';

export function SessionRail() {
  const order = useStore((s) => s.order);
  const sessions = useStore((s) => s.sessions);
  const activeId = useStore((s) => s.activeId);
  const setActive = useStore((s) => s.setActive);
  const setShowNewSession = useStore((s) => s.setShowNewSession);
  const setShowUsage = useStore((s) => s.setShowUsage);

  return (
    <nav className="rail glass">
      <div className="rail-title">Sessions</div>
      <div className="rail-list">
        {order.map((id, i) => {
          const s = sessions[id];
          if (!s) return null;
          const meta = STATE_META[s.state];
          return (
            <button
              key={id}
              className={`rail-item ${id === activeId ? 'active' : ''}`}
              onClick={() => setActive(id)}
              title={`${s.dir}\n${meta.label}`}
            >
              <span className="state-dot" style={{ background: meta.color }} />
              <span className="rail-body">
                <span className="rail-name">{s.name}</span>
                <span className="rail-sub" style={{ color: meta.color }}>
                  {meta.label}
                </span>
              </span>
              <span className="rail-index">⌘{i + 1}</span>
              <span
                className="rail-close"
                role="button"
                title="Close session"
                onClick={(e) => {
                  e.stopPropagation();
                  wsSend({ type: 'remove', id });
                }}
              >
                ×
              </span>
            </button>
          );
        })}
      </div>
      <button className="rail-new" onClick={() => setShowNewSession(true)}>
        ＋ New session
      </button>
      <button className="rail-usage" onClick={() => setShowUsage(true)}>
        ◔ Usage
      </button>
      <button
        className="rail-usage"
        title="Toggle fullscreen (hides the browser chrome)"
        onClick={() => {
          if (document.fullscreenElement) document.exitFullscreen();
          else document.documentElement.requestFullscreen();
        }}
      >
        ⛶ Fullscreen
      </button>
    </nav>
  );
}
