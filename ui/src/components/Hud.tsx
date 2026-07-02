import { useEffect, useState } from 'react';
import { wsSend } from '../store';
import { STATE_META, type SessionSummary } from '../types';
import { MODELS } from '../models';

function fmtTokens(n: number) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
  return String(n);
}

export function Hud({ session }: { session: SessionSummary }) {
  const meta = STATE_META[session.state];
  const running =
    session.state === 'thinking' ||
    session.state === 'tool_running' ||
    session.state === 'streaming_output';

  const [, forceTick] = useState(0);
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => forceTick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, [running]);

  const elapsed =
    running && session.turnStartedAt
      ? Math.max(0, Math.round((Date.now() - session.turnStartedAt) / 1000))
      : null;

  return (
    <header className="hud glass">
      <div className="hud-state" style={{ color: meta.color }}>
        <span className="state-dot big" style={{ background: meta.color }} />
        <span className="hud-state-label">{meta.label}</span>
        {session.currentTool && <span className="hud-tool">· {session.currentTool}</span>}
        {elapsed !== null && <span className="hud-elapsed">· {elapsed}s</span>}
      </div>

      <div className="hud-meta">
        <span title="Working directory" className="hud-dir">
          {session.dir.replace(/^\/Users\/[^/]+/, '~')}
        </span>
        <select
          className="hud-chip hud-model"
          title="Switch model (applies to the next turn)"
          value={session.model || ''}
          onChange={(e) => {
            if (e.target.value) wsSend({ type: 'set_model', id: session.id, model: e.target.value });
          }}
        >
          {!session.model && <option value="">default model</option>}
          {session.model && !MODELS.some((m) => m.value === session.model) && (
            <option value={session.model}>{session.model}</option>
          )}
          {MODELS.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
        <span className="hud-chip" title="Permission mode">
          {session.permissionMode}
        </span>
        <span className="hud-chip" title="Tokens in / out">
          ⬇ {fmtTokens(session.totals.inputTokens)} · ⬆ {fmtTokens(session.totals.outputTokens)}
        </span>
        <span className="hud-chip" title="Total cost">
          ${session.totals.costUsd.toFixed(3)}
        </span>
        {running && (
          <button
            className="btn btn-danger"
            onClick={() => wsSend({ type: 'interrupt', id: session.id })}
          >
            ◼ Interrupt
          </button>
        )}
      </div>

      {session.state === 'error' && session.lastError && (
        <div className="hud-error" title={session.lastError}>
          {session.lastError.slice(0, 200)}
        </div>
      )}
    </header>
  );
}
