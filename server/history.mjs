// Past Claude Code sessions (transcripts under ~/.claude/projects) —
// listed for the "continue a previous session" flow, deletable for good.

import { readdir, stat, rm, open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import os from 'node:os';

const PROJECTS_DIR = join(os.homedir(), '.claude', 'projects');
const LIST_LIMIT = 20;
const HEAD_BYTES = 64 * 1024;
const MAX_TRANSCRIPT = 5000; // mirrors the live-session cap in session.mjs

// the CLI names a project's transcript dir by replacing every
// non-alphanumeric char of the cwd with '-'
const encodeDir = (dir) => dir.replace(/[^a-zA-Z0-9]/g, '-');

// Best label available in the file head: the CLI-generated summary line if
// present, else the first real user message.
async function extractLabel(file) {
  const fh = await open(file, 'r');
  try {
    const buf = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await fh.read(buf, 0, HEAD_BYTES, 0);
    const head = buf.toString('utf8', 0, bytesRead);
    let firstUserText = null;
    for (const line of head.split('\n')) {
      let e;
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      if (e.type === 'summary' && e.summary) return e.summary;
      if (e.type === 'user' && !e.isMeta && !e.isSidechain && !firstUserText) {
        const c = e.message?.content;
        const text =
          typeof c === 'string'
            ? c
            : Array.isArray(c)
              ? c.filter((b) => b.type === 'text').map((b) => b.text).join(' ')
              : '';
        const clean = text
          .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
          .replace(/\s+/g, ' ')
          .trim();
        if (clean && !clean.startsWith('Caveat:') && !clean.startsWith('<')) {
          firstUserText = clean.slice(0, 120);
        }
      }
    }
    return firstUserText;
  } finally {
    await fh.close();
  }
}

export async function listHistory(dir) {
  const projDir = join(PROJECTS_DIR, encodeDir(dir));
  const names = await readdir(projDir).catch(() => []);
  const files = [];
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    const st = await stat(join(projDir, name)).catch(() => null);
    if (st) files.push({ id: name.slice(0, -'.jsonl'.length), mtime: st.mtimeMs });
  }
  files.sort((a, b) => b.mtime - a.mtime);
  return Promise.all(
    files.slice(0, LIST_LIMIT).map(async (f) => ({
      id: f.id,
      mtime: f.mtime,
      label:
        (await extractLabel(join(projDir, `${f.id}.jsonl`)).catch(() => null)) ||
        f.id.slice(0, 8),
    }))
  );
}

function flattenToolResult(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((b) => (b.type === 'text' ? b.text : `[${b.type}]`)).join('\n');
}

function extractImages(blocks) {
  const images = [];
  for (const b of blocks) {
    if (b.type === 'image' && b.source?.type === 'base64' && b.source.data) {
      images.push({ media_type: b.source.media_type, data: b.source.data });
    }
  }
  return images;
}

// Rebuild a display transcript from a stored session's .jsonl — same shape
// as the live stream-json events session.mjs turns into TranscriptEvents,
// minus the CLI's own bookkeeping lines (queue-operation, ai-title, …) and
// injected context (isMeta skill/command text, isSidechain subagent turns).
export async function loadTranscript(dir, id) {
  if (!/^[a-f0-9-]+$/i.test(id)) throw new Error('invalid session id');
  const file = join(PROJECTS_DIR, encodeDir(dir), `${id}.jsonl`);
  const body = await readFile(file, 'utf8').catch(() => '');
  const out = [];

  for (const line of body.split('\n')) {
    if (!line) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.isMeta || e.isSidechain) continue;
    const ts = Date.parse(e.timestamp || '') || Date.now();

    if (e.type === 'assistant') {
      const content = e.message?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (block.type === 'thinking' && block.thinking) {
          out.push({ kind: 'thinking', text: block.thinking, ts });
        } else if (block.type === 'text' && block.text) {
          out.push({ kind: 'assistant_text', text: block.text, ts });
        } else if (block.type === 'tool_use') {
          out.push({
            kind: 'tool_use',
            tool: block.name,
            toolUseId: block.id,
            input: block.input,
            ts,
          });
        }
      }
    } else if (e.type === 'user') {
      const content = e.message?.content;
      if (Array.isArray(content)) {
        const toolResults = content.filter((b) => b.type === 'tool_result');
        for (const b of toolResults) {
          out.push({
            kind: 'tool_result',
            toolUseId: b.tool_use_id,
            isError: !!b.is_error,
            text: flattenToolResult(b.content),
            ts,
          });
        }
        if (toolResults.length === 0) {
          const text = content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
          const images = extractImages(content);
          if (text || images.length) out.push({ kind: 'user_text', text, images, ts });
        }
      } else if (typeof content === 'string' && content.trim()) {
        out.push({ kind: 'user_text', text: content, ts });
      }
    }
  }

  return out.slice(-MAX_TRANSCRIPT).map((entry, seq) => ({ ...entry, seq }));
}

export async function deleteHistory(dir, id) {
  // ids are UUID filenames; reject anything that could escape the project dir
  if (!/^[a-f0-9-]+$/i.test(id)) throw new Error('invalid session id');
  await rm(join(PROJECTS_DIR, encodeDir(dir), `${id}.jsonl`));
}
