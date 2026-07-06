import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore, wsSend } from '../store';
import type { ImageAttachment, SessionSummary } from '../types';

interface PendingImage extends ImageAttachment {
  name: string;
}

const USAGE_KEY = 'pc-slash-usage';

function loadUsage(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(USAGE_KEY) || '{}');
  } catch {
    return {};
  }
}

export function Composer({ session }: { session: SessionSummary }) {
  const [text, setText] = useState('');
  const [images, setImages] = useState<PendingImage[]>([]);
  const [usage, setUsage] = useState<Record<string, number>>(loadUsage);
  const [selIdx, setSelIdx] = useState(-1);
  const [dismissed, setDismissed] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const selRef = useRef<HTMLButtonElement>(null);

  // Minty task hand-off: fill the box so the user sees it, then auto-send
  const mintyTask = useStore((s) => s.mintyTask);
  const clearMintyTask = useStore((s) => s.clearMintyTask);
  useEffect(() => {
    if (!mintyTask || mintyTask.sessionId !== session.id) return;
    setText(mintyTask.text);
    taRef.current?.focus();
    const t = setTimeout(() => {
      wsSend({ type: 'send', id: mintyTask.sessionId, text: mintyTask.text, images: [] });
      setText('');
      clearMintyTask();
    }, 1200);
    return () => clearTimeout(t);
  }, [mintyTask?.nonce, session.id]);

  const slashCommands = session.initInfo?.slashCommands ?? [];
  const suggestions = useMemo(() => {
    if (!text.startsWith('/') || text.includes(' ') || text.includes('\n')) return [];
    const q = text.slice(1).toLowerCase();
    return slashCommands
      .filter((c) => c.toLowerCase().includes(q))
      .sort((a, b) => (usage[b] || 0) - (usage[a] || 0) || a.localeCompare(b))
      .slice(0, 8);
  }, [text, slashCommands, usage]);

  const showSuggest = suggestions.length > 0 && !dismissed;

  useEffect(() => {
    selRef.current?.scrollIntoView({ block: 'nearest' });
  }, [selIdx]);

  const bumpUsage = (cmd: string) => {
    const next = { ...loadUsage(), [cmd]: (loadUsage()[cmd] || 0) + 1 };
    localStorage.setItem(USAGE_KEY, JSON.stringify(next));
    setUsage(next);
  };

  const accept = (cmd: string) => {
    setText('/' + cmd + ' ');
    setSelIdx(-1);
    taRef.current?.focus();
  };

  const addFiles = (files: Iterable<File>) => {
    for (const f of files) {
      if (!f.type.startsWith('image/')) continue;
      const reader = new FileReader();
      reader.onload = () => {
        const url = reader.result as string;
        const data = url.slice(url.indexOf(',') + 1);
        setImages((prev) => [
          ...prev,
          { media_type: f.type, data, name: f.name || 'screenshot' },
        ]);
      };
      reader.readAsDataURL(f);
    }
  };

  const onPaste = (e: React.ClipboardEvent) => {
    const files = [...e.clipboardData.items]
      .filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
      .map((it) => it.getAsFile())
      .filter((f): f is File => !!f);
    if (files.length) {
      e.preventDefault();
      addFiles(files);
    }
  };

  const send = () => {
    const t = text.trim();
    if (!t && images.length === 0) return;
    if (t.startsWith('/')) {
      const cmd = t.slice(1).split(/\s/)[0];
      if (cmd) bumpUsage(cmd);
    }
    wsSend({
      type: 'send',
      id: session.id,
      text: t,
      images: images.map(({ media_type, data }) => ({ media_type, data })),
    });
    setText('');
    setImages([]);
    setSelIdx(-1);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (showSuggest) {
      if (e.key === 'ArrowDown' || (e.key === 'Tab' && !e.shiftKey)) {
        e.preventDefault();
        setSelIdx((i) => (i + 1) % suggestions.length);
        return;
      }
      if (e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey)) {
        e.preventDefault();
        setSelIdx((i) => (i <= 0 ? suggestions.length - 1 : i - 1));
        return;
      }
      if (e.key === 'Escape') {
        setDismissed(true);
        setSelIdx(-1);
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey && selIdx >= 0) {
        e.preventDefault();
        accept(suggestions[selIdx]);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  const disabled = session.state === 'closed' || !session.alive;

  return (
    <div className="composer glass">
      {showSuggest && (
        <div className="slash-suggest">
          {suggestions.map((c, i) => (
            <button
              key={c}
              ref={i === selIdx ? selRef : undefined}
              className={i === selIdx ? 'sel' : ''}
              onMouseEnter={() => setSelIdx(i)}
              onClick={() => accept(c)}
            >
              <span className="slash-cmd">/{c}</span>
              {(usage[c] || 0) > 0 && <span className="slash-count">×{usage[c]}</span>}
            </button>
          ))}
          <div className="slash-hint">↑↓ select · ⏎ accept · esc dismiss</div>
        </div>
      )}
      {images.length > 0 && (
        <div className="attach-strip">
          {images.map((im, i) => (
            <div key={i} className="attach-thumb" title={im.name}>
              <img src={`data:${im.media_type};base64,${im.data}`} alt={im.name} />
              <button
                className="attach-remove"
                title="Remove image"
                onClick={() => setImages((prev) => prev.filter((_, j) => j !== i))}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="composer-row">
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files) addFiles(e.target.files);
            e.target.value = '';
          }}
        />
        <button
          className="btn attach-btn"
          title="Attach image (or paste a screenshot)"
          disabled={disabled}
          onClick={() => fileRef.current?.click()}
        >
          ＋
        </button>
        <textarea
          ref={taRef}
          value={text}
          disabled={disabled}
          placeholder={
            disabled
              ? 'session ended — create a new one'
              : 'Message Claude… (Enter to send, Shift+Enter for newline, / commands, paste images)'
          }
          onChange={(e) => {
            setText(e.target.value);
            setDismissed(false);
            setSelIdx(-1);
          }}
          onPaste={onPaste}
          onKeyDown={onKeyDown}
          rows={Math.min(8, Math.max(1, text.split('\n').length))}
        />
        <button
          className="btn btn-primary send-btn"
          onClick={send}
          disabled={disabled || (!text.trim() && images.length === 0)}
        >
          Send ⏎
        </button>
      </div>
    </div>
  );
}
