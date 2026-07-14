#!/usr/bin/env bash
# Fully restart the Personal Claude server: stop whatever's listening on
# PC_PORT (or the node server/index.mjs process, as a fallback), then start
# a fresh detached instance and confirm it came up.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PORT="${PC_PORT:-4317}"
RUN_DIR="$ROOT/.run"
PID_FILE="$RUN_DIR/server.pid"
LOG_FILE="$RUN_DIR/server.log"
mkdir -p "$RUN_DIR"

port_pid() {
  lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true
}

stop_server() {
  local pids
  pids="$(port_pid)"
  if [ -z "$pids" ] && [ -f "$PID_FILE" ]; then
    pids="$(cat "$PID_FILE" 2>/dev/null || true)"
    kill -0 "$pids" 2>/dev/null || pids=""
  fi
  if [ -z "$pids" ]; then
    pids="$(pgrep -f "node .*server/index\.mjs" || true)"
  fi
  if [ -z "$pids" ]; then
    echo "No running server found on :$PORT."
    return
  fi

  echo "Stopping server (pid $pids)..."
  kill -TERM $pids 2>/dev/null || true
  for _ in $(seq 1 20); do
    if [ -z "$(port_pid)" ]; then break; fi
    sleep 0.5
  done
  if [ -n "$(port_pid)" ]; then
    echo "Still up after SIGTERM, sending SIGKILL..."
    kill -KILL $(port_pid) 2>/dev/null || true
    sleep 0.5
  fi
}

start_server() {
  echo "Starting server on :$PORT..."
  nohup node server/index.mjs >"$LOG_FILE" 2>&1 &
  local pid=$!
  disown "$pid"
  echo "$pid" >"$PID_FILE"

  for _ in $(seq 1 20); do
    if [ -n "$(port_pid)" ]; then
      echo "Personal Claude → http://localhost:$PORT (pid $pid)"
      return
    fi
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "Server process exited early — check $LOG_FILE" >&2
      tail -n 40 "$LOG_FILE" >&2 || true
      exit 1
    fi
    sleep 0.5
  done

  echo "Server did not come up within 10s — check $LOG_FILE" >&2
  exit 1
}

stop_server
start_server
