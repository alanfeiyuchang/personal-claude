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

        <label>…or browse for a directory</label>
        <FolderBrowser value={customDir} onChange={setCustomDir} />

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

// lets you navigate the real filesystem (starting at $HOME, since the
// Project dropdown above already covers everything under devRoot) instead
// of hand-typing an absolute path. Browsing alone never touches `value` —
// only "Use this folder" commits, so opening the modal can't silently
// switch the selection away from the Project dropdown's default.
function FolderBrowser({ value, onChange }: { value: string; onChange: (path: string) => void }) {
  const dirListing = useStore((s) => s.dirListing);
  const [browsePath, setBrowsePath] = useState(value);

  useEffect(() => {
    wsSend({ type: 'browse_dir', path: browsePath });
  }, [browsePath]);

  const listing = dirListing;
  const displayPath = compactHome(listing?.path || browsePath || '~');
  const isSelected = !!value && !!listing && value === listing.path;

  return (
    <div className="folder-browser">
      <div className="folder-browser-path">
        <button
          type="button"
          className="folder-browser-up"
          disabled={!listing?.parent}
          title="Up one level"
          onClick={() => listing?.parent && setBrowsePath(listing.parent)}
        >
          ↑
        </button>
        <span className="folder-browser-current" title={listing?.path}>
          {displayPath}
        </span>
        <button
          type="button"
          className={`folder-browser-use ${isSelected ? 'active' : ''}`}
          disabled={!listing?.path}
          onClick={() => listing && onChange(isSelected ? '' : listing.path)}
        >
          {isSelected ? '✓ Using this' : 'Use this folder'}
        </button>
      </div>
      <div className="folder-browser-list">
        {listing?.error && <div className="folder-browser-empty">{listing.error}</div>}
        {listing && !listing.error && listing.entries.length === 0 && (
          <div className="folder-browser-empty">No subfolders</div>
        )}
        {listing?.entries.map((name) => (
          <button
            type="button"
            key={name}
            className="folder-browser-item"
            onClick={() => setBrowsePath(`${listing.path}/${name}`)}
          >
            📁 {name}
          </button>
        ))}
      </div>
    </div>
  );
}

function compactHome(p: string): string {
  return p.replace(/^\/Users\/[^/]+/, '~');
}
