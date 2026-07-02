import { useState } from 'react';
import { useStore, wsSend } from '../store';
import { MODELS } from '../models';

const MODEL_OPTIONS = [{ value: '', label: 'Default model' }, ...MODELS];

const PERMISSION_MODES = [
  { value: 'default', label: 'Default (ask)' },
  { value: 'acceptEdits', label: 'Accept edits' },
  { value: 'plan', label: 'Plan mode' },
  { value: 'bypassPermissions', label: 'Bypass permissions' },
];

export function NewSession() {
  const devRoot = useStore((s) => s.devRoot);
  const dirs = useStore((s) => s.dirs);
  const setShowNewSession = useStore((s) => s.setShowNewSession);
  const [dir, setDir] = useState('');
  const [customDir, setCustomDir] = useState('');
  const [model, setModel] = useState('');
  const [permissionMode, setPermissionMode] = useState('bypassPermissions');

  const create = () => {
    const finalDir = customDir.trim() || (dir ? `${devRoot}/${dir}` : devRoot);
    wsSend({
      type: 'create',
      dir: finalDir,
      model: model || undefined,
      permissionMode,
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
            Create
          </button>
        </div>
      </div>
    </div>
  );
}
