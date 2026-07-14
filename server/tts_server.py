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
#
# /speak STREAMS the audio: it yields raw little-endian int16 mono PCM at
# SAMPLE_RATE as the model generates it, rather than synthesizing the whole
# sentence before returning. This is what makes it feel as responsive as the
# Mac voice — first audio lands in ~0.25s (vs ~4.5s waiting for a full
# sentence), and since generation runs faster than realtime, playback stays
# gapless once it starts.

import json
import sys
import numpy as np
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from mlx_audio.tts.utils import load_model

MODEL_NAME = "mlx-community/Qwen3-TTS-12Hz-0.6B-Base-bf16"
DEFAULT_VOICE = "Chelsie"
SAMPLE_RATE = 24000  # Qwen3-TTS-12Hz output rate; the client assumes this too
# how much audio each streamed chunk covers — smaller = lower time-to-first-
# sound but more per-chunk overhead. 0.3s gives ~0.25s to first audio.
STREAM_INTERVAL = 0.3

print(f"[tts] loading {MODEL_NAME}...", file=sys.stderr)
model = load_model(MODEL_NAME)
print("[tts] model ready", file=sys.stderr)


def to_pcm16(audio) -> bytes:
    """mx.array float waveform -> little-endian int16 PCM bytes."""
    arr = np.asarray(audio, dtype=np.float32)
    arr = np.clip(arr, -1.0, 1.0)
    return (arr * 32767.0).astype("<i2").tobytes()


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

        # HTTP/1.0 (the default protocol_version) has no keep-alive, so the
        # body is terminated by connection close — no Content-Length needed,
        # which is exactly what we want for an open-ended stream.
        self.send_response(200)
        self.send_header("Content-Type", "audio/pcm")
        self.send_header("X-Sample-Rate", str(SAMPLE_RATE))
        self.end_headers()
        try:
            for result in model.generate(
                text=text,
                voice=voice,
                language="auto",
                stream=True,
                streaming_interval=STREAM_INTERVAL,
            ):
                self.wfile.write(to_pcm16(result.audio))
                self.wfile.flush()  # push each chunk out as soon as it's ready
        except (BrokenPipeError, ConnectionResetError):
            pass  # client (Node proxy) hung up — stop generating
        except Exception as e:
            # headers are already sent, so we can't switch to a 500 — just log
            print(f"[tts] generate error: {e}", file=sys.stderr)


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8780
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"[tts] listening on 127.0.0.1:{port}", file=sys.stderr)
    server.serve_forever()
