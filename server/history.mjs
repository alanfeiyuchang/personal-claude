// Past Claude Code sessions (transcripts under ~/.claude/projects) —
// listed for the "continue a previous session" flow, deletable for good.

import { readdir, stat, rm, open } from 'node:fs/promises';
import { join } from 'node:path';
import os from 'node:os';

const PROJECTS_DIR = join(os.homedir(), '.claude', 'projects');
const LIST_LIMIT = 20;
const HEAD_BYTES = 64 * 1024;

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

export async function deleteHistory(dir, id) {
  // ids are UUID filenames; reject anything that could escape the project dir
  if (!/^[a-f0-9-]+$/i.test(id)) throw new Error('invalid session id');
  await rm(join(PROJECTS_DIR, encodeDir(dir), `${id}.jsonl`));
}
