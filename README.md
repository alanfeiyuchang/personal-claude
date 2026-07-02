# Personal Claude

A local, browser-based graphical shell over the `claude` CLI — session management,
a live transcript with collapsible tool calls, and an ambient particle field whose
color reflects what the agent is doing right now. See `PLAN.md` for the full design.

Everything runs on `localhost` and stays on this machine. Auth is whatever your
local `claude` already uses.

## Quick start

```bash
npm install
npm run build     # builds the UI into ui/dist
npm start         # serves http://localhost:4317
```

Open <http://localhost:4317>, hit **＋ New session**, pick a project directory,
model, and permission mode, and talk to Claude.

## Dev mode

```bash
npm start         # server on :4317 (terminal 1)
npm run dev       # Vite dev server on :5173, proxies /ws (terminal 2)
```

## How it works

- `server/session.mjs` — the single adapter around the CLI: spawns
  `claude -p --output-format stream-json --input-format stream-json --verbose`
  per session (one warm process each, keyed to a working directory), parses the
  event stream into a state machine
  (`idle → thinking → tool_running → streaming_output → done`), and tracks
  tokens/cost/turns.
- `server/index.mjs` — localhost-only HTTP + WebSocket server; broadcasts session
  state and transcript events to all connected browsers.
- `ui/` — Vite + React + Zustand. Particle layer (canvas, state-colored, honors
  `prefers-reduced-motion`), session rail (⌘1–9 to switch, ⌘N for new),
  HUD (state, elapsed, tokens, cost, interrupt), markdown transcript, slash-command
  autocomplete, and a read-only Skills & Automations panel fed by the session's
  init event.

## Status

Working core (plan phases 0–3, part of 4/5). Not yet built: resume of existing
transcripts, mission-control grid, skill authoring with diff approval, usage
dashboard.
