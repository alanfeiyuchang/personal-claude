import { useEffect } from 'react';
import { useStore, wsSend } from '../store';
import { STATE_META, type PlanLimit } from '../types';
import { limitColor } from './UsagePanel';

const RAIL_WIDTH_KEY = 'pc-rail-width';
const clampWidth = (w: number) => Math.min(420, Math.max(170, w));

function setRailWidth(px: number | null) {
  const root = document.documentElement;
  if (px === null) root.style.removeProperty('--rail-w');
  else root.style.setProperty('--rail-w', `${px}px`);
}

function shortLimitLabel(l: PlanLimit) {
  if (l.kind === 'session') return '5h';
  if (l.kind === 'weekly_all') return 'week';
  if (l.kind === 'weekly_scoped') return l.scopeLabel ?? 'week*';
  return l.scopeLabel ?? l.kind;
}

function PlanLimitButton() {
  const limits = useStore((s) => s.limits);
  const setShowUsage = useStore((s) => s.setShowUsage);

  // keep the numbers fresh: on mount + every 60s (the endpoint is free —
  // no tokens — and the server caches it for 15s anyway)
  useEffect(() => {
    wsSend({ type: 'get_limits' });
    const t = setInterval(() => wsSend({ type: 'get_limits' }), 60_000);
    return () => clearInterval(t);
  }, []);

  return (
    <button
      className="rail-limits"
      title="Plan limits — click for full usage"
      onClick={() => setShowUsage(true)}
    >
      {!limits || limits.length === 0 ? (
        <span className="rail-limits-empty">◔ Usage</span>
      ) : (
        limits.map((l) => (
          <span key={l.kind + (l.scopeLabel ?? '')} className="rail-limit-row">
            <span className="rail-limit-label">{shortLimitLabel(l)}</span>
            <span className="rail-limit-bar">
              <span
                className="rail-limit-fill"
                style={{
                  width: `${Math.min(100, Math.max(0, l.percent))}%`,
                  ...(limitColor(l) ? { background: limitColor(l) } : {}),
                }}
              />
            </span>
            <span className="rail-limit-pct">{Math.round(l.percent)}%</span>
          </span>
        ))
      )}
    </button>
  );
}

function startRailResize(e: React.PointerEvent<HTMLDivElement>) {
  e.preventDefault();
  const handle = e.currentTarget;
  const rail = handle.parentElement as HTMLElement;
  const startX = e.clientX;
  const startW = rail.offsetWidth;
  handle.setPointerCapture(e.pointerId);
  handle.classList.add('dragging');

  let width = startW;
  const onMove = (ev: PointerEvent) => {
    width = clampWidth(startW + ev.clientX - startX);
    setRailWidth(width);
  };
  const onUp = () => {
    handle.classList.remove('dragging');
    handle.removeEventListener('pointermove', onMove);
    handle.removeEventListener('pointerup', onUp);
    localStorage.setItem(RAIL_WIDTH_KEY, String(width));
  };
  handle.addEventListener('pointermove', onMove);
  handle.addEventListener('pointerup', onUp);
}

export function SessionRail() {
  const order = useStore((s) => s.order);
  const sessions = useStore((s) => s.sessions);
  const activeId = useStore((s) => s.activeId);
  const setActive = useStore((s) => s.setActive);
  const setShowNewSession = useStore((s) => s.setShowNewSession);

  // restore the locked-in rail width
  useEffect(() => {
    const saved = Number(localStorage.getItem(RAIL_WIDTH_KEY));
    if (saved) setRailWidth(clampWidth(saved));
  }, []);

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
      <PlanLimitButton />
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
      <div
        className="rail-resizer"
        title="Drag to resize · double-click to reset"
        onPointerDown={startRailResize}
        onDoubleClick={() => {
          localStorage.removeItem(RAIL_WIDTH_KEY);
          setRailWidth(null);
        }}
      />
    </nav>
  );
}
