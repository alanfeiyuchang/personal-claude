import { useCallback, useEffect, useState } from 'react';

type Project = {
  name: string;
  ok: boolean;
  builtAt: string | null;
  nodes: number;
  edges: number;
  building: boolean;
};

// The Graphify tab maps the Development folder one project at a time — graphify's
// cross-file resolution is scoped to a single repo, so each project gets its own
// fast, self-contained graph.html.
export function GraphifyTab() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [devRoot, setDevRoot] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null); // project currently building
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0); // bust the iframe cache after a rebuild

  const refresh = useCallback(async () => {
    try {
      const r = await fetch('/graphify/status');
      const data = await r.json();
      setProjects(data.projects ?? []);
      setDevRoot(data.devRoot ?? '');
      setSelected((cur) => cur ?? data.projects?.find((p: Project) => p.ok)?.name ?? data.projects?.[0]?.name ?? null);
    } catch {
      /* server not up yet */
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function build(name: string) {
    setBusy(name);
    setError(null);
    try {
      const r = await fetch(`/graphify/rebuild?project=${encodeURIComponent(name)}`, { method: 'POST' });
      const data = await r.json();
      if (!r.ok || data.error) throw new Error(data.error || `HTTP ${r.status}`);
      await refresh();
      setSelected(name);
      setNonce((n) => n + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  const current = projects.find((p) => p.name === selected) ?? null;
  const built = current?.builtAt ? new Date(current.builtAt).toLocaleString() : null;

  return (
    <div className="graphify">
      <div className="graphify-body">
        <aside className="graphify-list glass">
          <div className="graphify-list-head">
            <span className="graphify-title">Projects</span>
            <span className="graphify-root" title={devRoot}>{devRoot}</span>
          </div>
          <div className="graphify-list-scroll">
            {projects.length === 0 && <div className="graphify-stats dim">connecting…</div>}
            {projects.map((p) => (
              <button
                key={p.name}
                className={`graphify-item ${p.name === selected ? 'active' : ''}`}
                onClick={() => setSelected(p.name)}
              >
                <span className={`graphify-dot ${p.ok ? 'on' : ''}`} />
                <span className="graphify-item-name">{p.name}</span>
                {busy === p.name ? (
                  <span className="graphify-item-meta">building…</span>
                ) : p.ok ? (
                  <span className="graphify-item-meta">{p.nodes.toLocaleString()}</span>
                ) : (
                  <span className="graphify-item-meta dim">—</span>
                )}
              </button>
            ))}
          </div>
        </aside>

        <div className="graphify-main">
          {error && <div className="graphify-error">Build failed: {error}</div>}

          <div className="graphify-canvas glass">
            {current?.ok ? (
              <iframe
                key={`${current.name}-${nonce}`}
                className="graphify-frame"
                src={`/graphify-out/${encodeURIComponent(current.name)}/graph.html?v=${nonce}`}
                title={`${current.name} knowledge graph`}
              />
            ) : (
              <div className="graphify-empty">
                <h2>{current ? `Map ${current.name}` : 'Pick a project'}</h2>
                <p>
                  Graphify parses the code with tree-sitter (no LLM, fully local) and turns every
                  file, symbol, and connection into an interactive knowledge graph.
                </p>
                {current &&
                  (busy === current.name ? (
                    <p className="graphify-building">Building the graph…</p>
                  ) : (
                    <button className="btn btn-primary" onClick={() => build(current.name)}>
                      ⚡ Build graph
                    </button>
                  ))}
              </div>
            )}
          </div>

          {current && (
            <header className="graphify-bar glass">
              <div className="graphify-meta">
                <span className="graphify-title">{current.name}</span>
                {current.ok ? (
                  <span className="graphify-stats">
                    {current.nodes.toLocaleString()} nodes · {current.edges.toLocaleString()} edges
                    {built && <> · built {built}</>}
                  </span>
                ) : (
                  <span className="graphify-stats dim">no graph yet</span>
                )}
              </div>
              <button
                className="btn btn-primary"
                onClick={() => build(current.name)}
                disabled={busy === current.name}
              >
                {busy === current.name ? 'Building…' : current.ok ? '↻ Rebuild' : '⚡ Build graph'}
              </button>
            </header>
          )}
        </div>
      </div>
    </div>
  );
}
