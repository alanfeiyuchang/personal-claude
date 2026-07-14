#!/usr/bin/env python3
# Minimal local TTS server for Minty — loads Qwen3-TTS once via MLX and serves
# /speak over plain HTTP so the model-load cost is paid once at startup, not
# per utterance. Deliberately not mlx_audio's own server.py: that one pulls in
# STT/VAD/realtime dependencies (webrtcvad, etc.) this project doesn't need.
#
# Chosen over macOS's built-in speechSynthesis because Qwen3-TTS handles
# Chinese/English code-switching in one voice — the system voices need a
# different voice per language, which is what made Minty sound like two
# people taking turns mid-sentence.

import io
import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from mlx_audio.audio_io import write as audio_write
from mlx_audio.tts.utils import load_model

MODEL_NAME = "mlx-community/Qwen3-TTS-12Hz-0.6B-Base-bf16"
DEFAULT_VOICE = "Chelsie"

print(f"[tts] loading {MODEL_NAME}...", file=sys.stderr)
model = load_model(MODEL_NAME)
print("[tts] model ready", file=sys.stderr)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass  # Node captures this process's pipes; stay quiet

    def do_GET(self):
        if self.path == "/health":
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"ok")
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        if self.path != "/speak":
            self.send_response(404)
            self.end_headers()
            return
        length = int(self.headers.get("Content-Length", 0))
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError:
            self.send_response(400)
            self.end_headers()
            return
        text = str(body.get("text", "")).strip()
        voice = str(body.get("voice") or DEFAULT_VOICE)
        if not text:
            self.send_response(400)
            self.end_headers()
            return
        try:
            results = list(model.generate(text=text, voice=voice, language="auto"))
            audio = results[0].audio
            sample_rate = results[0].sample_rate
        except Exception as e:
            self.send_response(500)
            self.end_headers()
            self.wfile.write(str(e).encode())
            return
        buf = io.BytesIO()
        audio_write(buf, audio, sample_rate, format="wav")
        data = buf.getvalue()
        self.send_response(200)
        self.send_header("Content-Type", "audio/wav")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8780
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"[tts] listening on 127.0.0.1:{port}", file=sys.stderr)
    server.serve_forever()
