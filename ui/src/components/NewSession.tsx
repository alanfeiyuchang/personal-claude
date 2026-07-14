import { useEffect, useState } from 'react';
import { useStore, wsSend } from '../store';
import { MODELS } from '../models';
import { timeAgo } from '../util';

// 'qwen3-8b' must match LOCAL_MODEL in server/localmodel.mjs. Only offered
// here (session creation), not in the Hud's live model-switcher: that sends
// a control_request to an already-running `claude` process, which can't
// repoint its ANTHROPIC_BASE_URL — routing through the local proxy only
// works when it's set as an env var at spawn time.
const MODEL_OPTIONS = [
  { value: '', label: 'Default model' },
  ...MODELS,
  { value: 'qwen3-8b', label: 'Qwen3 8B (local, offline)' },
];

const PERMISSION_MODES = [
  { value: 'default', label: 'Default (ask)' },
  { value: 'acceptEdits', label: 'Accept edits' },
  { value: 'plan', label: 'Plan mode' },
  { value: 'bypassPermissions', label: 'Bypass permissions' },
];

export function NewSession() {
  const devRoot = useStore((s) => s.devRoot);
  const dirs = useStore((s) => s.dirs);
  const history = useStore((s) => s.history);
  const setShowNewSession = useStore((s) => s.setShowNewSession);
  const [dir, setDir] = useState('');
  const [customDir, setCustomDir] = useState('');
  const [model, setModel] = useState('sonnet');
  const [permissionMode, setPermissionMode] = useState('bypassPermissions');
  const [resume, setResume] = useState<string | null>(null);

  const finalDir = customDir.trim() || (dir ? `${devRoot}/${dir}` : devRoot);

  // past sessions for the chosen directory (debounced while typing a custom path)
  useEffect(() => {
    setResume(null);
    const t = setTimeout(
      () => wsSend({ type: 'list_history', dir: finalDir }),
      customDir.trim() ? 400 : 0
    );
    return () => clearTimeout(t);
  }, [finalDir]);

  const pastSessions = history && history.dir === finalDir ? history.sessions : [];

  const create = () => {
    const resumed = pastSessions.find((h) => h.id === resume);
    wsSend({
      type: 'create',
      dir: finalDir,
      model: model || undefined,
      permissionMode,
      resume: resume || undefined,
      name: resumed ? resumed.label.slice(0, 40) : undefined,
    });
    setShowNewSession(false);
  };

  return (
    <div className="modal-backdrop" onClick={() => setShowNewSession(false)}>
      <div className="modal glass" onClick={(e) => e.stopPropagation()}>
        <h2>New session</h2>

        <label>Project</label>
        <select value={dir} onChange={(e) => setDir(e.target.value)}>
          <option value="">{devRoot} (root)</option>
          {dirs.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>

        <label>…or a custom directory</label>
        <input
          type="text"
          placeholder="~/path/to/project"
          value={customDir}
          onChange={(e) => setCustomDir(e.target.value)}
        />

        {pastSessions.length > 0 && (
          <>
            <label>Continue a previous session</label>
            <div className="history-list">
              {pastSessions.map((h) => (
                <div
                  key={h.id}
                  className={`history-item ${resume === h.id ? 'selected' : ''}`}
                  title={h.label}
                  onClick={() => setResume(resume === h.id ? null : h.id)}
                >
                  <span className="history-label">{h.label}</span>
                  <span className="history-time">{timeAgo(h.mtime)}</span>
                  <span
                    className="history-delete"
                    role="button"
                    title="Delete permanently"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (resume === h.id) setResume(null);
                      wsSend({ type: 'delete_history', dir: finalDir, id: h.id });
                    }}
                  >
                    🗑
                  </span>
                </div>
              ))}
            </div>
          </>
        )}

        <label>Model</label>
        <select value={model} onChange={(e) => setModel(e.target.value)}>
          {MODEL_OPTIONS.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>

        <label>Permission mode</label>
        <select value={permissionMode} onChange={(e) => setPermissionMode(e.target.value)}>
          {PERMISSION_MODES.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>

        <div className="modal-actions">
          <button className="btn" onClick={() => setShowNewSession(false)}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={create}>
            {resume ? '↻ Continue session' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  );
}
