# Personal Claude — Product & Technical Plan

> A local, browser-based "operating system" that wraps Claude Code — everything
> the terminal does, but with beautiful graphics, effortless session management,
> and a natural-language way to build your own skills and automations.
>
> **Status: PLAN ONLY. No implementation in this document.**
> Author model: Opus 4.8 · Date: 2026-07-01

---

## 0. TL;DR

Personal Claude is a **local web app** (runs at `http://localhost`, never leaves your
machine) that acts as a graphical shell over the `claude` CLI. It spawns real
Claude Code processes under the hood (headless `claude -p --output-format=stream-json
--input-format=stream-json`), streams their events to a modern UI, and renders the
agent's *live state* as an ambient **particle field whose color = the process state**.

You manage sessions like windows in an OS (add / remove / switch instantly), and
each session has a **Skills & Automations** panel where you can **describe** a skill
or automation in plain language and have Claude author it for you (writing the actual
`~/.claude/skills/*/SKILL.md`, hooks, or scheduled routines).

The feature set below is **derived from your real Claude Code usage** (see §2), not
guessed.

---

## 1. Vision & Design Principles

1. **A shell, not a fork.** We wrap the official `claude` CLI / Agent SDK. We never
   reimplement the agent. Anything Claude Code can do in the terminal, Personal
   Claude can do — plus graphics. This keeps us compatible with every future Claude
   Code release.
2. **Local-first & private.** Everything runs on `localhost`. Sessions, skills, and
   history live in your existing `~/.claude` directory. No accounts, no cloud.
3. **State is the interface.** The single most information-dense thing about a running
   agent is *what it's doing right now*. We make that ambient and glanceable via the
   particle field's color and motion — you can tell from across the room whether
   Claude is thinking, running a tool, waiting for you, or errored.
4. **Author by describing.** Skills and automations should be created by talking, not
   by hand-editing markdown and JSON. The UI turns "whenever I finish a Swift build,
   run the tests and tell me" into a real hook/skill.
5. **Calm, modern, cinematic.** Dark, glassy, depth via the particle layer. Motion is
   meaningful (tied to state), never decorative noise.

---

## 2. Usage Insights (mined from your `~/.claude`)

Pulled from `stats-cache.json`, `projects/`, `settings.json`, and session logs:

| Signal | Value | Design implication |
|---|---|---|
| Active days | 32 (2026-05-09 → 06-29) | You're a daily power user — invest in speed & session ergonomics. |
| Messages / tool calls | ~18,905 / 5,759 | Long, tool-heavy runs. The UI must stay legible during massive transcripts. |
| Sessions | 30 across 11 project dirs | Multi-project switching is core, not a nice-to-have. |
| Peak day | 3,598 messages in ONE session (2026-05-16) | **Long autonomous runs** dominate → progress/heartbeat visualization matters more than chat prettiness. |
| Project mix | Mostly iOS/Xcode (ACM apps, Game Tracker), the Lark bridge, some Next.js | First-class support for **build/run/simulator** loops and web dev. |
| Plugins | swift-lsp, clangd-lsp, karpathy-skills | Surface LSP + plugin/skill status per session. |
| Runtime | Headless `claude` via bridges, `--dangerously-skip-permissions` | We already know the exact wrapping API to use (stream-json). Permission mode must be a visible, per-session toggle. |
| Global skills/commands | none yet | Big opportunity: the "describe → create skill" flow fills an empty shelf you'd actually use. |

**Conclusions that shape the plan:**
- Optimize for **watching long autonomous runs** (state at a glance, progress, cost/tokens, interrupt).
- **Fast multi-session switching** is a headline feature, not a sidebar afterthought.
- Deeply integrate the **iOS build/run/simulator** and **web dev** loops you actually run.
- The **skills/automations** section should seed useful starters from your history (e.g., "record a simulator demo", "run /usage", "verify the C++ problem bank").

---

## 3. System Architecture

```
┌───────────────────────────────────────────────────────────────┐
│  Browser UI (the "OS")   http://localhost:4317                 │
│  ─ Particle/state layer (WebGL)                                │
│  ─ Session windows, dock, command palette                      │
│  ─ Skills & Automations panels                                 │
└───────────▲───────────────────────────────────────────────────┘
            │  WebSocket (JSON events, bidirectional)
┌───────────┴───────────────────────────────────────────────────┐
│  Local server (Node/Bun)                                        │
│  ─ Session Manager: spawns 1 claude process per session        │
│  ─ Wraps: claude -p --output-format stream-json                │
│           --input-format stream-json  (+ resume/--session-id)  │
│  ─ State machine: parses stream-json → session state           │
│  ─ Skill/Automation authoring service                          │
│  ─ Reads ~/.claude (projects, skills, settings, crons)         │
└───────────▲───────────────────────────────────────────────────┘
            │  child_process / SDK
┌───────────┴───────────────────────────────────────────────────┐
│  claude CLI  ·  ~/.claude/{projects,skills,settings,tasks}     │
└───────────────────────────────────────────────────────────────┘
```

- **Wrapping approach (recommended):** spawn the CLI in stream-json mode — the exact
  interface the Lark bridge and Xcode's assistant already use on this machine
  (`claude -p --output-format=stream-json --input-format=stream-json`). Alternative:
  the **Claude Agent SDK** (TypeScript) for a typed, in-process integration. Decision
  criteria in §9.
- **One process per session**, keyed to a working directory. Resume maps to existing
  `~/.claude/projects/<slug>/*.jsonl` so Personal Claude sees your history from day one.
- **No secrets in the repo.** Auth uses whatever the local `claude` already uses.

---

## 4. The State Model → Particle Color (headline feature)

A finite state machine parsed from the stream-json event flow. Each state has a color,
motion profile, and audio-optional cue.

| State | Meaning | Color | Particle behavior |
|---|---|---|---|
| `idle` | No active turn | Cool slate / dim | Slow drift, low density |
| `thinking` | Model generating (pre-tool) | Indigo→violet | Gentle swirl, brightening |
| `tool_running` | Executing a tool (Bash/Edit/…) | Cyan/teal | Fast directional flow, sparks per tool call |
| `waiting_input` | Needs your reply / permission | Amber (pulsing) | Pulse/breathe to grab attention |
| `streaming_output` | Writing a large result | Green | Rippling waves |
| `error` / `interrupted` | Crash, denial, or /stop | Red/orange | Turbulence, then settle |
| `done` | Turn complete | Soft white flash → idle | Bloom then calm |

- Color also **encodes intensity**: token throughput / tool frequency modulates
  particle count and speed, so a heavy autonomous run visibly "runs hot."
- Multiple sessions → the background can blend the **active** session's state, with
  small per-session state dots in the dock.
- Accessibility: a non-color redundant channel (icon + label) always present;
  respect `prefers-reduced-motion` (falls back to a calm gradient).

---

## 5. Core Features

### 5.1 Session management (add / remove / switch)
- **Dock / session rail** with live state dot per session; drag to reorder.
- **New session**: pick a working directory (defaults to your `~/Desktop/Development/*`
  projects), model, and permission mode. Optionally "resume" an existing project's
  latest transcript.
- **Switch**: `⌘1..9`, a command palette (`⌘K`), or click. Switching is instant
  (processes stay warm in the background).
- **Remove**: graceful `/stop` + process teardown, with "archive transcript" option.
- **Multi-session grid / focus view** for watching several autonomous runs at once.

### 5.2 The main workspace (terminal-parity, better graphics)
- Rich transcript: collapsible tool calls, diffs rendered inline, file trees, image/
  screenshot previews, rendered markdown — everything the TUI shows, laid out visually.
- **Composer** with slash-command autocomplete (reads available skills/commands),
  file @-mentions, image paste/drop.
- **Live run HUD**: current state, elapsed, token + cost meter, tools-used count,
  interrupt button — tuned for your long autonomous runs.
- Permission-mode indicator + one-click toggle (plan / default / accept-edits /
  bypass), because you switch these often.

### 5.3 Skills & Automations panel (per session)
- Lists what's available in this context: **skills** (`~/.claude/skills`, plugin
  skills), **slash commands**, **plugins/LSP**, and **automations** (hooks in
  `settings.json`, scheduled routines in `~/.claude/tasks`).
- **Create by describing** (the star of this section):
  - You type: *"Whenever a Swift build succeeds, run the tests and post results."*
  - Personal Claude routes that to a Claude turn with a scoped authoring skill that
    decides **skill vs hook vs scheduled routine**, writes the files
    (`SKILL.md` / `settings.json` hook / cron task), shows a **diff for approval**,
    and installs on confirm.
  - Same flow for skills: *"A skill that records a simulator demo and sends it to
    Lark"* → generates a reusable `SKILL.md` with the steps.
- **Starter suggestions seeded from your history** (simulator demo capture, `/usage`
  report, C++ bank `verify`, "commit & push", etc.).
- Enable/disable/edit/delete each skill or automation from the panel; test-run a skill.

### 5.4 The "OS" layer
- Dock, draggable/resizable session windows, a global **command palette**, and a
  **status bar** (active model, permission mode, aggregate token/cost today).
- Optional "mission control" that fans out all sessions.
- Global search across transcripts and skills.

### 5.5 Insights (leverages your data)
- Usage dashboard (days active, messages, tokens, cost, busiest projects) — an
  evolved, prettier `/usage`.
- Per-project history browser reading `~/.claude/projects`.

---

## 6. UI / Visual Design

- **Aesthetic:** dark, glassy, cinematic. Depth from the WebGL particle layer behind
  frosted panels. Restrained, high-contrast typography (e.g., Inter/Geist + a mono for
  code). Purple↔cyan accent system that ties into the state colors.
- **Layout:** left session rail/dock · center workspace · right Skills & Automations ·
  top status bar. Everything keyboard-drivable.
- **Motion:** meaningful only — state transitions, streaming ripples, tool sparks.
  Honors reduced-motion.
- **Follows the repo's dataviz/design conventions** for any charts (usage dashboard).

---

## 7. Data & Integration Map (what we read/write in `~/.claude`)

- `projects/<slug>/*.jsonl` — transcripts (read for resume + history browser).
- `skills/` — global skills (read + **write** when authoring).
- `settings.json` / `settings.local.json` — model, plugins, permissions, **hooks**
  (read + write for automations).
- `tasks/` — scheduled routines / crons (read + write).
- `plugins/` — installed plugins & marketplaces (read for the panel).
- `stats-cache.json`, `history.jsonl` — usage insights (read).

All writes go through an **approval/diff step** in the UI — never silent edits to your config.

---

## 8. Tech Stack (proposed)

- **Server:** Node or Bun; `ws` for WebSocket; `child_process` (or Agent SDK) to drive
  `claude`; chokidar to watch `~/.claude` for external changes.
- **UI:** Vite + React + TypeScript; Tailwind; Framer Motion for UI motion.
- **Particles:** WebGL via `three.js` or a lightweight custom GPU shader (10–50k GPU
  particles; must stay 60fps and idle-cheap).
- **State:** a small store (Zustand) mirroring server session states over WS.
- **Persistence:** the app's own prefs in a local file; the source of truth stays `~/.claude`.

---

## 9. Key Decisions to Confirm (open questions)

1. **Wrapping: CLI stream-json vs Agent SDK?** Recommend starting with **CLI
   stream-json** (proven on this machine, zero SDK coupling), keep SDK as a fast follow.
2. **Particles: three.js vs custom shader?** Recommend three.js first for velocity,
   optimize later.
3. **Scope of v1 automations:** skills + `settings.json` hooks first; scheduled
   routines (crons) in v2?
4. **Single-window OS vs real draggable windows?** Recommend a strong single-layout
   v1 with a mission-control view; true window management in v2.
5. **How much "OS" metaphor** do you want (dock/windows/wallpaper) vs a focused IDE-like
   shell? Affects scope significantly.
6. Model default per new session (your settings say `fable-5[1m]`; runs here use Opus 4.8).

---

## 10. Phased Roadmap

- **Phase 0 — Spike:** spawn one `claude` in stream-json, echo events to a bare web page.
  Prove the wrap + resume works end-to-end.
- **Phase 1 — Core shell:** one session, rich transcript, composer, permission toggle,
  run HUD.
- **Phase 2 — State→particles:** the state machine + WebGL particle field with the
  color mapping (§4).
- **Phase 3 — Multi-session:** dock, add/remove/switch, warm background processes,
  command palette.
- **Phase 4 — Skills & Automations:** read/list panel, then "describe → author →
  approve → install" for skills and hooks.
- **Phase 5 — Insights + polish:** usage dashboard, history browser, mission control,
  reduced-motion, theming.
- **Phase 6 — Automations v2:** scheduled routines, richer triggers, skill test-runner.

---

## 11. Risks & Mitigations

- **Claude Code CLI/SDK changes** → isolate all wrapping behind one adapter module.
- **Particle perf on long runs** → GPU instancing, cap density, pause when tab hidden.
- **Config corruption** (writing skills/hooks) → always diff+approve, back up
  `settings.json` before writing, validate JSON.
- **Huge transcripts** → virtualized rendering, lazy-load old turns.
- **Concurrent editors** (Xcode assistant / terminal touching `~/.claude`) → file
  watching + conflict-safe merges; treat `~/.claude` as shared state.
- **Security** → localhost-only bind, no remote exposure; permission mode always visible.

---

## 12. Out of Scope (v1)
Cloud sync, multi-user, mobile, replacing the agent itself, non-Claude backends.
