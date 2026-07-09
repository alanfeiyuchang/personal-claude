// Graphify integration — per-project knowledge graphs of the Development folder.
//
// graphify is designed to map ONE project at a time (cross-file symbol
// resolution is scoped to a single repo). Pointing it at the whole 40 GB
// Development tree makes resolution blow up, so we build a separate graph per
// project into graphify-out/<project>/{graph.html,graph.json}. Each build is
// fast (a typical project graphs in ~1s).

import { spawn } from 'node:child_process';
import { readFile, writeFile, stat, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');
export const GRAPHIFY_OUT = join(PROJECT_ROOT, 'graphify-out');
const DEV_ROOT = join(os.homedir(), 'Desktop/Development');

// Resolve the graphify binary — installed via `uv tool install graphifyy`,
// which drops it in ~/.local/bin (not always on the server's PATH).
function graphifyBin() {
  const candidates = [
    join(os.homedir(), '.local/bin/graphify'),
    '/usr/local/bin/graphify',
    '/opt/homebrew/bin/graphify',
  ];
  return candidates.find((p) => existsSync(p)) || 'graphify';
}

// graphify's graph.html only reveals a node's file on click. Inject a hover
// tooltip so pointing at a node shows which file it is. Idempotent (guarded by a
// marker) and re-applied after every rebuild, so it survives regeneration.
const HOVER_MARKER = 'gf-hover-tooltip';
const HOVER_SNIPPET = `
<!-- ${HOVER_MARKER} -->
<script>(function(){
  if (typeof network === 'undefined' || typeof nodesDS === 'undefined') return;
  var tip = document.createElement('div');
  tip.style.cssText = 'position:fixed;z-index:99999;pointer-events:none;display:none;'
    + 'background:#141826;color:#e2e8f0;border:1px solid #2a2a4e;border-radius:8px;'
    + 'padding:6px 9px;font:12px/1.45 -apple-system,system-ui,sans-serif;max-width:360px;'
    + 'box-shadow:0 6px 20px rgba(0,0,0,.55);white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
  document.body.appendChild(tip);
  var cur = null;
  function esc(s){return String(s).replace(/[&<>]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;'}[c];});}
  network.on('hoverNode', function(p){
    var n = nodesDS.get(p.node); if(!n) return;
    cur = p.node;
    var src = n._source_file || n.source_file || n._source_location || '';
    tip.innerHTML = '<b>'+esc(n.label)+'</b>' + (src ? '<br><span style="color:#94a3b8">'+esc(src)+'</span>' : '');
    tip.style.display = 'block';
  });
  network.on('blurNode', function(){ cur = null; tip.style.display='none'; });
  network.on('zoom', function(){ cur = null; tip.style.display='none'; });
  network.on('dragStart', function(){ tip.style.display='none'; });
  var host = document.getElementById('graph') || document.body;
  host.addEventListener('mousemove', function(e){
    if (cur === null) return;
    var x = e.clientX + 14, y = e.clientY + 14;
    if (x + tip.offsetWidth > window.innerWidth) x = e.clientX - tip.offsetWidth - 14;
    if (y + tip.offsetHeight > window.innerHeight) y = e.clientY - tip.offsetHeight - 14;
    tip.style.left = x + 'px'; tip.style.top = y + 'px';
  });
})();</script>
`;

export async function injectHoverTooltip(project) {
  const htmlPath = join(GRAPHIFY_OUT, project, 'graph.html');
  try {
    const html = await readFile(htmlPath, 'utf8');
    if (html.includes(HOVER_MARKER)) return;
    const idx = html.lastIndexOf('</body>');
    const patched =
      idx === -1 ? html + HOVER_SNIPPET : html.slice(0, idx) + HOVER_SNIPPET + html.slice(idx);
    await writeFile(htmlPath, patched);
  } catch {
    /* no graph.html yet */
  }
}

// A project name is a single path segment under DEV_ROOT — reject anything with
// separators or leading dots so it can't escape the sandbox.
function safeProject(name) {
  const n = String(name || '').trim();
  if (!n || n.includes('/') || n.includes('\\') || n.startsWith('.') || n.includes('..')) {
    throw new Error(`invalid project: ${name}`);
  }
  return n;
}

async function projectStatus(name) {
  const out = join(GRAPHIFY_OUT, name);
  const graphJson = join(out, 'graph.json');
  const base = { name, ok: false, builtAt: null, nodes: 0, edges: 0, building: building.has(name) };
  try {
    const st = await stat(graphJson);
    const raw = JSON.parse(await readFile(graphJson, 'utf8'));
    const nodes = raw.nodes?.length ?? 0;
    const edges = raw.edges?.length ?? raw.links?.length ?? 0;
    return {
      ...base,
      ok: existsSync(join(out, 'graph.html')) && nodes > 0,
      builtAt: st.mtime.toISOString(),
      nodes,
      edges,
    };
  } catch {
    return base;
  }
}

// List Development subprojects (same filter the session UI uses) with per-project
// graph status.
export async function graphifyStatus() {
  const entries = await readdir(DEV_ROOT, { withFileTypes: true }).catch(() => []);
  const names = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));
  const projects = await Promise.all(names.map((n) => projectStatus(n)));
  return { devRoot: DEV_ROOT, projects };
}

const building = new Set();

// Build one project's graph. Serialized per project; concurrent builds of
// different projects are allowed.
export async function rebuildGraph(name) {
  const project = safeProject(name);
  const dir = join(DEV_ROOT, project);
  if (!existsSync(dir)) throw new Error(`no such project: ${project}`);
  if (building.has(project)) throw new Error(`a build is already in progress for ${project}`);

  building.add(project);
  try {
    await new Promise((resolvePromise, reject) => {
      const child = spawn(graphifyBin(), ['update', dir, '--force'], {
        cwd: PROJECT_ROOT,
        env: {
          ...process.env,
          PATH: `${join(os.homedir(), '.local/bin')}:${process.env.PATH}`,
          // absolute path → graphify writes the graph here, not inside the project
          GRAPHIFY_OUT: join(GRAPHIFY_OUT, project),
          GRAPHIFY_NO_TIPS: '1',
        },
      });
      let stderr = '';
      child.stderr.on('data', (d) => (stderr += d.toString()));
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) resolvePromise();
        else reject(new Error(`graphify exited ${code}: ${stderr.slice(-400)}`));
      });
    });
    await injectHoverTooltip(project);
    return await projectStatus(project);
  } finally {
    building.delete(project);
  }
}
