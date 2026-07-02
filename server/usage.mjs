// Aggregates Claude Code usage from ~/.claude/projects/**/*.jsonl transcripts.
// Windows: rolling 5h (≈ plan rate-limit block), since local midnight, last 7 days.

import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

const PROJECTS_DIR = join(os.homedir(), '.claude', 'projects');
const OAUTH_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';

// Claude Code stores its OAuth credentials in the macOS Keychain
// (~/.claude/.credentials.json on other platforms).
async function getOauthToken() {
  try {
    const { stdout } = await execFileP('security', [
      'find-generic-password', '-s', 'Claude Code-credentials', '-w',
    ]);
    const token = JSON.parse(stdout).claudeAiOauth?.accessToken;
    if (token) return token;
  } catch { /* fall through to file */ }
  try {
    const body = await readFile(join(os.homedir(), '.claude', '.credentials.json'), 'utf8');
    return JSON.parse(body).claudeAiOauth?.accessToken || null;
  } catch {
    return null;
  }
}

// Plan rate-limit utilization (same numbers as Claude Code's /usage).
async function fetchPlanLimits() {
  const token = await getOauthToken();
  if (!token) return null;
  const res = await fetch(OAUTH_USAGE_URL, {
    headers: {
      authorization: `Bearer ${token}`,
      'anthropic-beta': 'oauth-2025-04-20',
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) return null;
  const data = await res.json();
  if (!Array.isArray(data.limits)) return null;
  return data.limits.map((l) => ({
    kind: l.kind,
    percent: typeof l.percent === 'number' ? l.percent : 0,
    resetsAt: l.resets_at || null,
    severity: l.severity || 'normal',
    scopeLabel: l.scope?.model?.display_name || null,
  }));
}

function emptyBucket() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheCreation: 0,
    costUsd: 0,
    messages: 0,
    byModel: {},
  };
}

function addTo(bucket, model, usage, cost) {
  const add = (t) => {
    t.input += usage.input_tokens || 0;
    t.output += usage.output_tokens || 0;
    t.cacheRead += usage.cache_read_input_tokens || 0;
    t.cacheCreation += usage.cache_creation_input_tokens || 0;
    t.costUsd += cost;
    t.messages += 1;
  };
  add(bucket);
  if (!bucket.byModel[model]) {
    const { byModel: _omit, ...blank } = emptyBucket();
    bucket.byModel[model] = blank;
  }
  add(bucket.byModel[model]);
}

export async function collectUsage() {
  const limitsPromise = fetchPlanLimits().catch(() => null);
  const now = Date.now();
  const weekStart = now - 7 * 24 * 3600e3;
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const windows = {
    block: now - 5 * 3600e3,
    today: midnight.getTime(),
    week: weekStart,
  };
  const agg = { block: emptyBucket(), today: emptyBucket(), week: emptyBucket() };
  const seen = new Set();

  const projDirs = await readdir(PROJECTS_DIR, { withFileTypes: true }).catch(() => []);
  for (const d of projDirs) {
    if (!d.isDirectory()) continue;
    const dir = join(PROJECTS_DIR, d.name);
    const names = await readdir(dir).catch(() => []);
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      const file = join(dir, name);
      const st = await stat(file).catch(() => null);
      if (!st || st.mtimeMs < weekStart) continue; // untouched for a week → nothing in range
      const body = await readFile(file, 'utf8').catch(() => '');
      for (const line of body.split('\n')) {
        if (!line) continue;
        let e;
        try {
          e = JSON.parse(line);
        } catch {
          continue;
        }
        const usage = e?.message?.usage;
        if (e?.type !== 'assistant' || !usage) continue;
        const ts = Date.parse(e.timestamp || '');
        if (!ts || ts < weekStart) continue;
        // dedupe retried/streamed duplicates of the same API message
        const key = `${e.message?.id || ''}:${e.requestId || ''}`;
        if (key !== ':') {
          if (seen.has(key)) continue;
          seen.add(key);
        }
        const model = e.message?.model || 'unknown';
        if (model === '<synthetic>') continue; // internal placeholder, not real usage
        const cost = typeof e.costUSD === 'number' ? e.costUSD : 0;
        for (const [win, cutoff] of Object.entries(windows)) {
          if (ts >= cutoff) addTo(agg[win], model, usage, cost);
        }
      }
    }
  }
  return { generatedAt: now, windows: agg, limits: await limitsPromise };
}
