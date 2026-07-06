// Skill metadata — descriptions for the Skills & Automations panel.
// Sources, in override order (later wins): built-in fallbacks → plugin cache
// SKILL.md files → user ~/.claude/skills → project <dir>/.claude/skills.
// The CLI itself is a compiled binary, so built-in skills have no SKILL.md on
// disk; we keep short curated summaries for those instead.

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import os from 'node:os';

const HOME = os.homedir();
const CACHE_TTL = 60_000;

// Short summaries for skills bundled inside the CLI (no file on disk).
const BUILTIN = {
  'code-review': 'Review the current diff for correctness bugs and cleanup opportunities, at a chosen effort level.',
  simplify: 'Review changed code for reuse, simplification, and efficiency cleanups, then apply the fixes.',
  verify: 'Verify a code change actually works by exercising the affected flow end-to-end, not just tests.',
  review: 'Review a GitHub pull request.',
  'security-review': 'Complete a security review of the pending changes on the current branch.',
  dataviz: 'Design-system guidance for building charts, dashboards, and data visualizations.',
  loop: 'Run a prompt or slash command repeatedly on an interval, or self-paced.',
  schedule: 'Create and manage scheduled cloud agents (routines) that run on a cron schedule.',
  'claude-api': 'Reference for the Claude API / Anthropic SDK — models, pricing, params, tool use.',
  run: "Launch and drive this project's app to see a change working.",
  init: 'Initialize a new CLAUDE.md file with codebase documentation.',
  'update-config': 'Configure the Claude Code harness via settings.json (permissions, env vars, hooks).',
  'keybindings-help': 'Customize keyboard shortcuts in ~/.claude/keybindings.json.',
  'fewer-permission-prompts': 'Scan transcripts for common read-only calls and add an allowlist to reduce permission prompts.',
  debug: 'Systematic debugging help for a failing behavior.',
  batch: 'Run a task across many items in parallel.',
  'design-sync': 'Sync design artifacts for the project.',
  'run-skill-generator': 'Generate a project /run skill by exploring how this project is launched.',
};

const cache = new Map(); // projectDir -> { at, meta }

export async function getSkillMeta(projectDir) {
  const key = projectDir || '';
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.meta;

  const meta = {};
  for (const [name, description] of Object.entries(BUILTIN)) {
    meta[name] = { description, source: 'built-in', path: null };
  }

  await scanPluginCache(meta);
  await scanSkillsDir(join(HOME, '.claude/skills'), 'user', meta);
  if (projectDir) await scanSkillsDir(join(projectDir, '.claude/skills'), 'project', meta);

  cache.set(key, { at: Date.now(), meta });
  return meta;
}

async function scanPluginCache(meta) {
  const cacheRoot = join(HOME, '.claude/plugins/cache');
  const marketplaces = await listDirs(cacheRoot);
  for (const mp of marketplaces) {
    const plugins = await listDirs(join(cacheRoot, mp));
    for (const plugin of plugins) {
      const versions = await listDirs(join(cacheRoot, mp, plugin));
      for (const version of versions) {
        const skillsDir = join(cacheRoot, mp, plugin, version, 'skills');
        const skills = await listDirs(skillsDir);
        for (const skill of skills) {
          const path = join(skillsDir, skill, 'SKILL.md');
          const fm = await readFrontmatter(path);
          if (!fm) continue;
          const entry = { description: fm.description || '', source: `plugin (${plugin})`, path };
          meta[`${plugin}:${skill}`] = entry;
          meta[skill] ??= entry; // bare-name fallback lookup
        }
      }
    }
  }
}

async function scanSkillsDir(dir, source, meta) {
  for (const skill of await listDirs(dir)) {
    const path = join(dir, skill, 'SKILL.md');
    const fm = await readFrontmatter(path);
    if (fm) meta[skill] = { description: fm.description || '', source, path };
  }
}

async function listDirs(dir) {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries.filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name);
}

async function readFrontmatter(path) {
  const text = await readFile(path, 'utf8').catch(() => null);
  if (!text || !text.startsWith('---')) return null;
  const end = text.indexOf('\n---', 3);
  if (end === -1) return null;
  const block = text.slice(3, end);
  const out = {};
  const lines = block.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\w[\w-]*):\s*(.*)$/);
    if (!m) continue;
    let value = m[2].trim();
    if (value === '>' || value === '|' || value === '>-' || value === '|-') {
      // folded/literal block scalar: gather following indented lines
      const parts = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) parts.push(lines[++i].trim());
      value = parts.join(' ');
    }
    out[m[1]] = value.replace(/^["']|["']$/g, '');
  }
  return out;
}
