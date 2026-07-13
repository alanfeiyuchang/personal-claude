import { useStore, wsSend } from '../store';
import type { PlanLimit, UsageBucket, UsageTotals } from '../types';

function fmt(n: number) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
  return String(n);
}

function shortModel(m: string) {
  return m.replace(/^claude-/, '').replace(/-\d{8}$/, '');
}

function limitLabel(l: PlanLimit) {
  if (l.kind === 'session') return 'Current session';
  if (l.kind === 'weekly_all') return 'Current week (all models)';
  if (l.kind === 'weekly_scoped') return `Current week (${l.scopeLabel ?? 'scoped'})`;
  return l.scopeLabel ? `${l.kind} (${l.scopeLabel})` : l.kind;
}

function fmtReset(iso: string | null) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const sameDay = d.toDateString() === new Date().toDateString();
  return (
    'resets ' +
    d.toLocaleString(undefined, {
      ...(sameDay ? {} : { month: 'short', day: 'numeric' }),
      hour: 'numeric',
      minute: '2-digit',
    })
  );
}

export function limitColor(l: PlanLimit) {
  if (l.percent >= 100 || l.severity === 'exceeded' || l.severity === 'critical')
    return '#fb7185';
  if (l.percent >= 80 || l.severity === 'warning') return '#fbbf24';
  return undefined; // default accent gradient
}

function PlanLimits({ limits }: { limits: PlanLimit[] }) {
  return (
    <section className="usage-bucket">
      <header>
        <span className="usage-title">Plan limits</span>
        <span className="usage-hint">live from claude.ai — same as /usage</span>
      </header>
      {limits.map((l) => (
        <div key={l.kind + (l.scopeLabel ?? '')} className="usage-row">
          <span className="usage-model limit-label" title={limitLabel(l)}>
            {limitLabel(l)}
          </span>
          <div className="usage-bar">
            <div
              className="usage-bar-fill"
              style={{
                width: `${Math.min(100, Math.max(0, l.percent))}%`,
                ...(limitColor(l) ? { background: limitColor(l) } : {}),
              }}
            />
          </div>
          <span className="usage-nums limit-nums">
            {Math.round(l.percent)}% · {fmtReset(l.resetsAt)}
          </span>
        </div>
      ))}
    </section>
  );
}

function Bucket({ title, hint, bucket }: { title: string; hint: string; bucket: UsageBucket }) {
  const models = Object.entries(bucket.byModel).sort(
    (a, b) => b[1].input + b[1].output - (a[1].input + a[1].output)
  );
  const max = Math.max(1, ...models.map(([, t]) => t.input + t.output));
  return (
    <section className="usage-bucket">
      <header>
        <span className="usage-title">{title}</span>
        <span className="usage-hint">{hint}</span>
      </header>
      <div className="usage-totals">
        <span>⬇ {fmt(bucket.input + bucket.cacheCreation)} in</span>
        <span>⚡ {fmt(bucket.cacheRead)} cached</span>
        <span>⬆ {fmt(bucket.output)} out</span>
        <span>{bucket.messages} msgs</span>
        {bucket.costUsd > 0 && <span>${bucket.costUsd.toFixed(2)}</span>}
      </div>
      {models.length === 0 && <div className="usage-empty">no activity</div>}
      {models.map(([model, t]: [string, UsageTotals]) => (
        <div key={model} className="usage-row">
          <span className="usage-model">{shortModel(model)}</span>
          <div className="usage-bar">
            <div
              className="usage-bar-fill"
              style={{ width: `${((t.input + t.output) / max) * 100}%` }}
            />
          </div>
          <span className="usage-nums">
            {fmt(t.input + t.cacheCreation)} / {fmt(t.output)}
          </span>
        </div>
      ))}
    </section>
  );
}

export function UsagePanel() {
  const usage = useStore((s) => s.usage);
  const setShowUsage = useStore((s) => s.setShowUsage);

  return (
    <div className="modal-backdrop" onClick={() => setShowUsage(false)}>
      <div className="modal glass usage-modal" onClick={(e) => e.stopPropagation()}>
        <div className="usage-head">
          <h2>Claude usage</h2>
          <button className="btn" onClick={() => wsSend({ type: 'get_usage' })}>
            ↻ Refresh
          </button>
        </div>
        <p className="usage-note">
          Aggregated from local Claude Code transcripts (~/.claude/projects) across all
          projects and sessions — in / out tokens per model.
        </p>
        {!usage ? (
          <div className="usage-empty">loading…</div>
        ) : (
          <>
            {usage.limits && usage.limits.length > 0 && <PlanLimits limits={usage.limits} />}
            <Bucket
              title="Last 5 hours"
              hint="≈ current plan rate-limit block"
              bucket={usage.windows.block}
            />
            <Bucket title="Today" hint="since midnight" bucket={usage.windows.today} />
            <Bucket title="Last 7 days" hint="" bucket={usage.windows.week} />
          </>
        )}
        <div className="modal-actions">
          <button className="btn" onClick={() => setShowUsage(false)}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
