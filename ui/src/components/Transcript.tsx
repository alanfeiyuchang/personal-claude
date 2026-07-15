import { memo, useEffect, useRef, useState } from 'react';
import { marked } from 'marked';
import type { TranscriptEvent } from '../types';

marked.setOptions({ gfm: true, breaks: true });

const VIDEO_EXT_RE = /\.(mp4|webm|mov|m4v|ogv)(\?.*)?$/i;
// bare id or full watch/share URL → normalized embed src
const YOUTUBE_RE = /(?:youtube\.com\/(?:watch\?v=|shorts\/)|youtu\.be\/)([\w-]{11})/i;
const VIMEO_RE = /vimeo\.com\/(\d+)/i;

// Claude answers "give me a reference image/video" with plain markdown
// (`![]()`) pointing at a URL it found — this renderer is what turns that
// into an actual playable <video> or embedded player instead of a broken
// <img> tag (marked's default image renderer doesn't know video from image).
const renderer = new marked.Renderer();
renderer.image = (href: string, title: string | null, text: string) => {
  const yt = href.match(YOUTUBE_RE);
  if (yt) {
    return `<iframe class="md-video-embed" src="https://www.youtube-nocookie.com/embed/${yt[1]}" title="${escapeHtml(text || 'video')}" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe>`;
  }
  const vimeo = href.match(VIMEO_RE);
  if (vimeo) {
    return `<iframe class="md-video-embed" src="https://player.vimeo.com/video/${vimeo[1]}" title="${escapeHtml(text || 'video')}" allow="autoplay; fullscreen; picture-in-picture" allowfullscreen></iframe>`;
  }
  if (VIDEO_EXT_RE.test(href)) {
    return `<video class="md-video" controls preload="metadata" src="${href}">${escapeHtml(text || '')}</video>`;
  }
  const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
  return `<a href="${href}" target="_blank" rel="noopener noreferrer"><img class="md-img" src="${href}" alt="${escapeHtml(text || '')}"${titleAttr} loading="lazy"></a>`;
};

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function Markdown({ text }: { text: string }) {
  return (
    <div
      className="md"
      dangerouslySetInnerHTML={{ __html: marked.parse(text, { renderer }) as string }}
    />
  );
}

const ToolCall = memo(function ToolCall({
  ev,
  result,
}: {
  ev: TranscriptEvent;
  result?: TranscriptEvent;
}) {
  const [open, setOpen] = useState(false);
  const input = ev.input ? JSON.stringify(ev.input, null, 2) : '';
  const preview =
    typeof (ev.input as any)?.command === 'string'
      ? (ev.input as any).command
      : typeof (ev.input as any)?.file_path === 'string'
        ? (ev.input as any).file_path
        : '';
  return (
    <div className={`tool-call ${result?.isError ? 'tool-error' : ''}`}>
      <button className="tool-head" onClick={() => setOpen((v) => !v)}>
        <span className="tool-chevron">{open ? '▾' : '▸'}</span>
        <span className="tool-name">{ev.tool}</span>
        {preview && <span className="tool-preview">{preview}</span>}
        {result ? (
          <span className={`tool-status ${result.isError ? 'err' : 'ok'}`}>
            {result.isError ? 'error' : 'done'}
          </span>
        ) : (
          <span className="tool-status running">running…</span>
        )}
      </button>
      {open && (
        <div className="tool-body">
          {input && <pre className="tool-input">{truncate(input, 4000)}</pre>}
          {result?.images && result.images.length > 0 && (
            <div className="msg-images">
              {result.images.map((im, i) => (
                <img
                  key={i}
                  className="msg-img"
                  src={`data:${im.media_type};base64,${im.data}`}
                  alt="tool result"
                />
              ))}
            </div>
          )}
          {result?.text && (
            <pre className="tool-output">{truncate(result.text, 6000)}</pre>
          )}
        </div>
      )}
    </div>
  );
});

function truncate(s: string, n: number) {
  return s.length > n ? s.slice(0, n) + `\n… (${s.length - n} more chars)` : s;
}

export function Transcript({ events }: { events: TranscriptEvent[] }) {
  const endRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);

  useEffect(() => {
    if (stickRef.current) endRef.current?.scrollIntoView({ block: 'end' });
  }, [events.length]);

  const onScroll = () => {
    const el = scrollerRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  // pair tool_use with its tool_result
  const resultsById = new Map<string, TranscriptEvent>();
  for (const ev of events) {
    if (ev.kind === 'tool_result' && ev.toolUseId) resultsById.set(ev.toolUseId, ev);
  }

  // Render at most the last 400 events to keep the DOM light on huge runs.
  const visible = events.length > 400 ? events.slice(-400) : events;

  return (
    <div className="transcript" ref={scrollerRef} onScroll={onScroll}>
      {events.length > 400 && (
        <div className="transcript-elided">… {events.length - 400} earlier events elided …</div>
      )}
      {visible.map((ev) => {
        switch (ev.kind) {
          case 'user_text':
            return (
              <div key={ev.seq} className="msg msg-user">
                {ev.images && ev.images.length > 0 && (
                  <div className="msg-images">
                    {ev.images.map((im, i) => (
                      <img
                        key={i}
                        className="msg-img"
                        src={`data:${im.media_type};base64,${im.data}`}
                        alt="attachment"
                      />
                    ))}
                  </div>
                )}
                {ev.text && <Markdown text={ev.text} />}
              </div>
            );
          case 'assistant_text':
            return (
              <div key={ev.seq} className="msg msg-assistant">
                <Markdown text={ev.text || ''} />
              </div>
            );
          case 'thinking':
            // Claude Code's headless CLI only reports a token estimate while
            // reasoning happens — the actual text is withheld even though a
            // "thinking" block always arrives (empty) once it's done.
            return ev.text ? (
              <details key={ev.seq} className="msg msg-thinking">
                <summary>thinking</summary>
                <div className="thinking-text">{ev.text}</div>
              </details>
            ) : (
              <div
                key={ev.seq}
                className="msg msg-thinking msg-thinking-hidden"
                title="Claude Code's CLI doesn't expose reasoning text in this mode, only a token estimate"
              >
                thought{ev.tokens ? ` for ~${ev.tokens} tokens` : ''} (not shown by the CLI)
              </div>
            );
          case 'tool_use':
            return (
              <ToolCall
                key={ev.seq}
                ev={ev}
                result={ev.toolUseId ? resultsById.get(ev.toolUseId) : undefined}
              />
            );
          case 'tool_result':
            return null; // rendered inside its ToolCall
          case 'system':
            return (
              <div key={ev.seq} className="turn-result">
                {ev.text}
              </div>
            );
          case 'result':
            return (
              <div key={ev.seq} className={`turn-result ${ev.isError ? 'err' : ''}`}>
                {ev.isError ? `turn failed (${ev.subtype})` : 'turn complete'}
                {typeof ev.durationMs === 'number' && ` · ${(ev.durationMs / 1000).toFixed(1)}s`}
                {typeof ev.costUsd === 'number' && ` · $${ev.costUsd.toFixed(4)}`}
              </div>
            );
          default:
            return null;
        }
      })}
      <div ref={endRef} />
    </div>
  );
}
