import { useEffect, useRef, useState } from 'react';
import { useStore, wsSend } from '../store';
import type { MintyPhase } from '../types';

// Minty — the Jarvis-style voice assistant. A neural orb that records on click,
// transcribes locally via whisper.cpp (far better than the browser's Web Speech
// API at code-switched Chinese/English, since that locks a whole utterance to
// one BCP-47 language), sends the text to the server brain, speaks the reply
// (speechSynthesis), and lets the brain drive the app (tasks land in the
// composer via store.mintyTask). Falls back to a text input where the mic
// isn't available.
//
// TTS is the browser's Web Speech API (SpeechSynthesisUtterance), not native
// AVSpeechSynthesizer — there's no Swift layer in this project, it's a React
// page. That API has real limits worth knowing before reaching for a fix:
// no SSML (<break>, <phoneme> tags are read aloud as literal text, not
// honored), no access to AVSpeechSynthesizer's IPA/phonetic override, and no
// "synthesize to a buffer without playing" primitive — speak() always both
// synthesizes and (queues to) play. So "pre-generate the next sentence in the
// background" isn't literally possible here; the closest real lever is
// queuing text to speak() earlier (see the clause-level flush below), since
// speak() calls queue natively and the OS can start preparing utterance N+1
// while N is still playing.

// per-language rate: Mandarin carries more information per syllable than
// English, and empirically reads more naturally a touch slower while English
// can run a touch faster — tune by ear, these aren't derived from anything
// more rigorous than listening to it
const CJK_RATE = 1.0;
const LATIN_RATE = 1.08;
// deliberate pause inserted only at a language *switch* (CJK run followed by
// a Latin run, or vice versa) — separate from and in tension with the gap
// this whole effort is trying to shrink: 0ms is the lowest-latency choice,
// but some listeners read a truly instantaneous voice swap as a glitch
// rather than an intentional switch. Tune per taste; 0 disables it entirely.
const BOUNDARY_PAUSE_MS = 60;
// once buffered reply text passes this length with no sentence-ending
// punctuation yet, flush at the next clause break instead of waiting for the
// sentence to finish — gets long sentences into the native speak() queue
// (and therefore "preparing to play") sooner
const CLAUSE_FLUSH_THRESHOLD = 30;

const PHASE_COLOR: Record<MintyPhase, [number, number, number]> = {
  idle: [52, 211, 153], // mint
  listening: [110, 231, 183], // bright mint
  thinking: [139, 124, 246], // violet
  speaking: [34, 211, 238], // cyan
};

const PHASE_LABEL: Record<MintyPhase, string> = {
  idle: 'tap or hold space',
  listening: 'listening…',
  thinking: 'thinking…',
  speaking: 'speaking…',
};

// ── mic capture → 16kHz mono WAV (whisper.cpp's native input format) ────────

interface Recording {
  stream: MediaStream;
  ctx: AudioContext;
  source: MediaStreamAudioSourceNode;
  processor: ScriptProcessorNode;
  gain: GainNode;
  chunks: Float32Array[];
  active: boolean; // gates onaudioprocess -> chunks, so start/stop is just a flag flip
}

// Acquiring a fresh mic stream (getUserMedia + AudioContext) costs anywhere
// from ~200ms to 1-2s depending on the audio device (Bluetooth headsets in
// particular have to renegotiate a profile every time). Doing that on every
// single Space press was the source of the "long wait before listening"
// delay — this graph is now built once and kept alive/reused for the whole
// session; start/stop just flips `active` and resets `chunks`.
// checks the saved deviceId against a fresh enumerateDevices() call right
// before acquiring the mic (not a cached list from some earlier effect —
// that could still be mid-flight the first time the app is used after a
// restart, which would race the "restore the saved device" behavior this
// exists for) so a device that's been unplugged since the id was saved
// falls back to the system default instead of throwing OverconstrainedError
async function resolveMicDeviceId(preferred: string): Promise<string | undefined> {
  if (!preferred || !navigator.mediaDevices?.enumerateDevices) return preferred || undefined;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const stillAvailable = devices.some((d) => d.kind === 'audioinput' && d.deviceId === preferred);
    return stillAvailable ? preferred : undefined;
  } catch {
    return preferred; // enumeration failing is no reason to give up the preference
  }
}

async function beginRecording(deviceId?: string): Promise<Recording> {
  const resolved = await resolveMicDeviceId(deviceId || '');
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: resolved ? { deviceId: { exact: resolved } } : true,
  });
  const Ctx = window.AudioContext || (window as any).webkitAudioContext;
  const ctx: AudioContext = new Ctx();
  const source = ctx.createMediaStreamSource(stream);
  const processor = ctx.createScriptProcessor(4096, 1, 1);
  const gain = ctx.createGain();
  gain.gain.value = 0; // silence the loopback — we only want the samples, not audible feedback
  const rec: Recording = { stream, ctx, source, processor, gain, chunks: [], active: false };
  processor.onaudioprocess = (e) => {
    if (rec.active) rec.chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
  };
  source.connect(processor);
  processor.connect(gain);
  gain.connect(ctx.destination);
  return rec;
}

function encodeWav(pcm: Int16Array, sampleRate: number): ArrayBuffer {
  const dataSize = pcm.length * 2;
  const buf = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buf);
  const writeStr = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);
  new Int16Array(buf, 44).set(pcm);
  return buf;
}

// drains the accumulated samples and returns a 16kHz mono WAV blob — the
// audio graph itself stays alive (see beginRecording) so the next listen can
// start instantly instead of re-acquiring the mic
function finishRecording(rec: Recording): Blob | null {
  const chunks = rec.chunks;
  rec.chunks = [];

  const total = chunks.reduce((n, c) => n + c.length, 0);
  if (!total) return null;
  const merged = new Float32Array(total);
  let off = 0;
  for (const c of chunks) {
    merged.set(c, off);
    off += c.length;
  }

  const sourceRate = rec.ctx.sampleRate;
  const targetRate = 16000;
  const ratio = sourceRate / targetRate;
  const outLen = Math.floor(merged.length / ratio);
  const pcm = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const s = Math.max(-1, Math.min(1, merged[Math.floor(i * ratio)]));
    pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return new Blob([encodeWav(pcm, targetRate)], { type: 'audio/wav' });
}

// fully releases a recording's mic/AudioContext resources — used both on
// unmount and when the user switches microphones (which forces the graph
// to be rebuilt against the new device on the next listen)
function teardownRecording(rec: Recording) {
  rec.active = false;
  try {
    rec.processor.disconnect();
    rec.source.disconnect();
    rec.gain.disconnect();
  } catch { /* already torn down */ }
  rec.stream.getTracks().forEach((t) => t.stop());
  rec.ctx.close();
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  let binary = '';
  const bytes = new Uint8Array(buf);
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

export function MintyBrain() {
  const minty = useStore((s) => s.minty);
  const setMinty = useStore((s) => s.setMinty);
  const mintyModel = useStore((s) => s.mintyModel);
  const phaseRef = useRef(minty.phase);
  phaseRef.current = minty.phase;

  const recordingRef = useRef<Recording | null>(null);
  const recordingSetupRef = useRef<Promise<Recording> | null>(null); // dedupes concurrent beginRecording() calls
  const pendingReqRef = useRef<string | null>(null);
  const [micAvailable] = useState(() => !!navigator.mediaDevices?.getUserMedia);
  const [typed, setTyped] = useState('');
  const transcribeResult = useStore((s) => s.transcribeResult);
  const clearTranscribeResult = useStore((s) => s.clearTranscribeResult);

  // release the mic for real when the component goes away — the graph itself
  // is otherwise kept alive across recordings (see beginRecording)
  useEffect(() => {
    return () => {
      const rec = recordingRef.current;
      if (!rec) return;
      teardownRecording(rec);
      recordingRef.current = null;
    };
  }, []);

  // mic device picker — without this, getUserMedia({ audio: true }) just
  // takes whatever macOS calls the "default" input, which on a fresh page
  // load can resolve to a Continuity iPhone mic instead of the Mac's own.
  // A ref mirrors the state because startListening is captured once by the
  // Space-key effect below (deps: [micAvailable]) and would otherwise read
  // a stale deviceId forever.
  const [micDeviceId, setMicDeviceIdState] = useState(() => localStorage.getItem('pc-minty-mic') || '');
  const micDeviceIdRef = useRef(micDeviceId);
  micDeviceIdRef.current = micDeviceId;
  const [micDevices, setMicDevices] = useState<MediaDeviceInfo[]>([]);

  const refreshMicDevices = () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    navigator.mediaDevices.enumerateDevices().then((devices) => {
      setMicDevices(devices.filter((d) => d.kind === 'audioinput'));
    });
  };
  // device labels are blank until mic permission has been granted at least
  // once — 'devicechange' also catches devices plugged/unplugged later
  useEffect(() => {
    if (!micAvailable) return;
    refreshMicDevices();
    navigator.mediaDevices.addEventListener('devicechange', refreshMicDevices);
    return () => navigator.mediaDevices.removeEventListener('devicechange', refreshMicDevices);
  }, [micAvailable]);

  const selectMicDevice = (id: string) => {
    localStorage.setItem('pc-minty-mic', id);
    setMicDeviceIdState(id);
    // the graph is normally built once and reused for the session (see
    // beginRecording) — tear it down so the next listen re-acquires against
    // the newly chosen device instead of keeping the old one alive
    const rec = recordingRef.current;
    if (rec) {
      teardownRecording(rec);
      recordingRef.current = null;
    }
  };

  // 'mixed' = auto-detect (handles 中英 code-switching); 'en' = English only
  const [lang, setLang] = useState(() => localStorage.getItem('pc-minty-lang') || 'mixed');
  const langRef = useRef(lang);
  langRef.current = lang;
  const toggleLang = () => {
    const next = lang === 'mixed' ? 'en' : 'mixed';
    setLang(next);
    localStorage.setItem('pc-minty-lang', next);
  };

  // 'qwen3-8b' must match LOCAL_MODEL in server/localmodel.mjs, 'haiku' must
  // match CLOUD_MODEL in server/minty.mjs. Switching kills and respawns
  // Minty's brain process server-side (see Minty.setModel), so it drops
  // whatever it was mid-thought on — fine for a deliberate toggle.
  const toggleMintyModel = () => {
    wsSend({ type: 'set_minty_model', model: mintyModel === 'qwen3-8b' ? 'haiku' : 'qwen3-8b' });
  };

  // tooling hooks: let demos/tests drive the orb state without a mic/TTS
  useEffect(() => {
    (window as any).__setMintyPhase = (p: MintyPhase) => setMinty({ phase: p });
    (window as any).__mintyPulse = () => {
      voiceRef.current.talking = true;
      voiceRef.current.energy = 1;
    };
    (window as any).__mintyQuiet = () => {
      voiceRef.current.talking = false;
    };
    return () => {
      delete (window as any).__setMintyPhase;
      delete (window as any).__mintyPulse;
      delete (window as any).__mintyQuiet;
    };
  }, [setMinty]);

  // ── streaming speech: speak sentence-by-sentence as `say` streams in ─────
  const enqueuedRef = useRef(0); // chars of minty.stream already handed to TTS
  const activeUtterRef = useRef(0);
  const finalSpokenRef = useRef(false);
  // performance.now() when the previous utterance's onend fired — diffed
  // against the next utterance's onstart to log real inter-utterance gap
  // times (see speakRun). null between turns so a stale previous turn's
  // timestamp never gets diffed against a new, unrelated one.
  const lastUtterEndRef = useRef<number | null>(null);
  // setTimeout ids for scheduled boundary-pause speak() calls (see
  // BOUNDARY_PAUSE_MS) — must be cancelable, or an interrupt/new submit
  // could let a stale utterance fire after the fact
  const pendingPauseTimeoutsRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  // live voice envelope: word boundaries spike energy, silence decays it \u2014
  // the orb reads this to animate in rhythm with the actual audio
  const voiceRef = useRef({ energy: 0, talking: false });

  const maybeIdle = () => {
    if (finalSpokenRef.current && activeUtterRef.current <= 0 && phaseRef.current === 'speaking') {
      setMinty({ phase: 'idle' });
    }
  };

  const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
  // a run of CJK text (with its adjoining CJK punctuation) or a run of
  // everything else -- splitting on these boundaries is what lets one
  // code-switched sentence get read by two different voices in turn
  const RUN_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff0c\u3002\uff01\uff1f\uff1b\uff1a\u3001\u201c\u201d\u2018\u2019]+|[^\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g;

  const pickVoice = (isCJK: boolean, voices: SpeechSynthesisVoice[]) =>
    isCJK
      ? (voices.find((v) => v.name === 'Lilian (Premium)') ??
        voices.find((v) => v.name === 'Tingting') ??
        voices.find((v) => v.lang.replace('_', '-').startsWith('zh') && v.localService) ??
        voices.find((v) => v.lang.replace('_', '-').startsWith('zh')) ??
        null)
      : (voices.find((v) => v.name === 'Zoe (Premium)') ??
        voices.find((v) => v.name === 'Ava (Premium)') ??
        voices.find((v) => v.name === 'Samantha') ??
        voices.find((v) => v.lang.startsWith('en') && v.localService) ??
        voices.find((v) => v.lang.startsWith('en')) ??
        null);

  // macOS lazily spins up each voice's underlying synthesis engine on first
  // use — Premium/neural voices ("Lilian (Premium)", "Zoe (Premium)")
  // especially — and idles it back out after a period of silence. That
  // cold-start is exactly the pause you hear when a reply switches from an
  // English run to a Chinese run (or back) mid-sentence, since each run is a
  // separate voice/utterance. Priming a voice with a near-silent,
  // near-instant utterance forces its engine to spin up ahead of time, so
  // the real switch later is fast. Deliberately bypasses speakRun — this
  // isn't "real" speech, so it must never touch activeUtterRef/voiceRef
  // (which would make the orb animate, or block maybeIdle from firing).
  const warmVoice = (voice: SpeechSynthesisVoice | null) => {
    if (!voice) return;
    const u = new SpeechSynthesisUtterance(' ');
    u.voice = voice;
    u.volume = 0.01; // inaudible, but still forces the engine to actually run
    speechSynthesis.speak(u);
  };

  // warms both the CJK and Latin voices currently resolved by pickVoice.
  // Called once voices become available (below) and again at the top of
  // every turn (see submit()) — that second call overlaps the warm-up with
  // the LLM's "thinking" latency, so by the time the reply is ready to
  // speak, both engines are already hot even if they'd gone idle since the
  // last turn.
  const warmBothVoices = (voices: SpeechSynthesisVoice[]) => {
    warmVoice(pickVoice(true, voices));
    warmVoice(pickVoice(false, voices));
  };

  // speechSynthesis.getVoices() can return an incomplete list (large voice
  // files like "Lilian (Premium)" register after the smaller default ones)
  // until 'voiceschanged' fires — calling getVoices() fresh on every
  // utterance raced that, silently dropping to no CJK voice while English
  // (whose default voices load first) kept working. Cache it and keep it
  // fresh via the event instead.
  const voicesRef = useRef<SpeechSynthesisVoice[]>([]);
  useEffect(() => {
    const load = () => {
      voicesRef.current = speechSynthesis.getVoices();
      warmBothVoices(voicesRef.current);
    };
    load();
    speechSynthesis.addEventListener('voiceschanged', load);
    return () => speechSynthesis.removeEventListener('voiceschanged', load);
  }, []);

  const speakRun = (run: string, isCJK: boolean, voices: SpeechSynthesisVoice[], pauseBefore = false) => {
    const r = run.trim();
    if (!r) return;
    const voice = pickVoice(isCJK, voices);
    const u = new SpeechSynthesisUtterance(r);
    // prefer the picked voice's own BCP-47 locale over a hardcoded
    // zh-CN/en-US — keeps pronunciation rules matched to whichever voice
    // actually got picked (e.g. a zh-TW voice reads differently under zh-TW
    // than if forced to zh-CN)
    u.lang = voice?.lang || (isCJK ? 'zh-CN' : 'en-US');
    u.voice = voice;
    u.rate = isCJK ? CJK_RATE : LATIN_RATE;
    activeUtterRef.current++;
    u.onstart = () => {
      if (lastUtterEndRef.current != null) {
        const gapMs = performance.now() - lastUtterEndRef.current;
        console.debug(`[minty-tts] gap ${gapMs.toFixed(0)}ms -> "${r.slice(0, 16)}" (${isCJK ? 'zh' : 'en'}/${voice?.name ?? 'default'})`);
      }
      voiceRef.current.talking = true;
      voiceRef.current.energy = Math.max(voiceRef.current.energy, 0.7);
    };
    u.onboundary = () => {
      voiceRef.current.energy = 1; // a word is being spoken right now
    };
    u.onend = u.onerror = () => {
      lastUtterEndRef.current = performance.now();
      activeUtterRef.current--;
      if (activeUtterRef.current <= 0) voiceRef.current.talking = false;
      maybeIdle();
    };
    // utterances queue natively, in order, regardless of *when* speak() is
    // called relative to each other — so delaying just this call (not the
    // activeUtterRef accounting above) is enough to insert a real pause
    // without breaking the orb's "still speaking" bookkeeping
    if (pauseBefore && BOUNDARY_PAUSE_MS > 0) {
      const id = setTimeout(() => {
        pendingPauseTimeoutsRef.current.delete(id);
        speechSynthesis.speak(u);
      }, BOUNDARY_PAUSE_MS);
      pendingPauseTimeoutsRef.current.add(id);
    } else {
      speechSynthesis.speak(u);
    }
  };

  const speakChunk = (text: string) => {
    const t = text.trim();
    if (!t) return;
    // belt-and-suspenders: if 'voiceschanged' never fired (happens on some
    // browsers), try one direct read before falling back to voice-less
    if (!voicesRef.current.length) voicesRef.current = speechSynthesis.getVoices();
    // split code-switched text (e.g. "这个 API 的 rate limit 是多少") into
    // per-script runs so each run is spoken in its own language's voice,
    // instead of reading the whole sentence in whichever voice matched first
    const runs = t.match(RUN_RE) || [t];
    let prevIsCJK: boolean | null = null;
    for (const run of runs) {
      const isCJK = CJK_RE.test(run);
      // only pause at an actual language switch, not between every run —
      // most "runs" are just CJK punctuation attached to the CJK side
      const pauseBefore = prevIsCJK !== null && isCJK !== prevIsCJK;
      speakRun(run, isCJK, voicesRef.current, pauseBefore);
      prevIsCJK = isCJK;
    }
  };

  // cancels any boundary-pause speak() calls still waiting on their
  // setTimeout — without this, a stale utterance from the turn being
  // interrupted could fire after speechSynthesis.cancel() already ran
  const cancelPendingPauses = () => {
    for (const id of pendingPauseTimeoutsRef.current) clearTimeout(id);
    pendingPauseTimeoutsRef.current.clear();
  };

  const submit = (text: string) => {
    const t = text.trim();
    if (!t) return;
    speechSynthesis.cancel();
    cancelPendingPauses();
    lastUtterEndRef.current = null; // don't diff this turn's first gap against the last turn's
    // re-warm both voice engines now, overlapping the cost with the LLM's
    // "thinking" latency — see warmBothVoices for why this matters
    warmBothVoices(voicesRef.current);
    enqueuedRef.current = 0;
    activeUtterRef.current = 0;
    finalSpokenRef.current = false;
    setMinty({ phase: 'thinking', transcript: t, say: '', stream: '', done: false });
    // the session the user is currently looking at — Minty treats this as the
    // default referent for "this session" / "what's it doing" (see index.mjs)
    wsSend({ type: 'minty', text: t, activeId: useStore.getState().activeId });
  };

  // stream deltas → speak each completed sentence immediately
  // (CJK sentence enders need no trailing space; latin ones do)
  useEffect(() => {
    const pending = minty.stream.slice(enqueuedRef.current);
    let m = pending.match(/^[\s\S]*(?:[.!?…](?=\s|$)|[。！？；])/);
    // no sentence-ending punctuation yet, but the buffer is already long —
    // there's no real "pre-synthesize in the background" primitive in the
    // Web Speech API (see the top-of-file note), so the closest thing to it
    // is handing text to speak() sooner: flush at the last clause break
    // instead of waiting for the sentence to end, so the native queue (and
    // therefore the OS, preparing the next utterance) gets a head start
    // instead of sitting idle through an entire long sentence
    if (!m && pending.length > CLAUSE_FLUSH_THRESHOLD) {
      m = pending.match(/^[\s\S]*[,，、]/);
    }
    if (m) {
      speakChunk(m[0]);
      enqueuedRef.current += m[0].length;
    }
  }, [minty.stream]);

  // final reply → flush the tail (or everything, if streaming didn't happen)
  useEffect(() => {
    if (!minty.done || finalSpokenRef.current) return;
    finalSpokenRef.current = true;
    if (minty.stream) {
      speakChunk(minty.stream.slice(enqueuedRef.current));
      enqueuedRef.current = minty.stream.length;
    } else if (minty.say) {
      speakChunk(minty.say);
    }
    maybeIdle();
  }, [minty.done]);

  // local whisper.cpp transcription result lands here (see server/whisper.mjs) —
  // matched against the request this component is actually waiting on, since
  // stray/late results shouldn't hijack whatever the orb is doing by then
  useEffect(() => {
    if (!transcribeResult || !pendingReqRef.current || transcribeResult.reqId !== pendingReqRef.current) return;
    pendingReqRef.current = null;
    clearTranscribeResult();
    if (transcribeResult.error) {
      setMinty({ phase: 'idle', transcript: `transcription error: ${transcribeResult.error}` });
      return;
    }
    const text = transcribeResult.text.trim();
    if (text) submit(text);
    else setMinty({ phase: 'idle', transcript: '' });
  }, [transcribeResult]);

  const startListening = async () => {
    try {
      // reuse the already-warm graph if we have one; only the very first
      // call in the session pays for getUserMedia + AudioContext setup
      let rec = recordingRef.current;
      if (!rec) {
        if (!recordingSetupRef.current) recordingSetupRef.current = beginRecording(micDeviceIdRef.current || undefined);
        rec = await recordingSetupRef.current;
        recordingSetupRef.current = null;
        recordingRef.current = rec;
        refreshMicDevices(); // labels are only populated once permission has been granted
      }
      if (rec.ctx.state === 'suspended') await rec.ctx.resume();
      rec.chunks = [];
      rec.active = true;
    } catch {
      setMinty({ phase: 'idle', transcript: 'mic permission denied' });
      return;
    }
    setMinty({ phase: 'listening', transcript: '', say: '' });
  };

  const stopListening = async () => {
    const rec = recordingRef.current;
    if (rec) rec.active = false;
    const blob = rec && finishRecording(rec);
    if (!blob) {
      setMinty({ phase: 'idle' });
      return;
    }
    setMinty({ transcript: 'transcribing…' });
    const audio = arrayBufferToBase64(await blob.arrayBuffer());
    const reqId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    pendingReqRef.current = reqId;
    wsSend({ type: 'transcribe', reqId, audio, language: langRef.current === 'mixed' ? 'auto' : 'en' });
  };

  // bails out of whatever Minty is currently doing — stops speech immediately
  // and tells the server to abandon the in-flight brain turn (see minty.mjs
  // Minty.interrupt) so its eventual reply/deltas don't land after the fact
  const interruptMinty = () => {
    speechSynthesis.cancel();
    cancelPendingPauses();
    lastUtterEndRef.current = null;
    wsSend({ type: 'minty_interrupt' });
    enqueuedRef.current = 0;
    activeUtterRef.current = 0;
    finalSpokenRef.current = false;
    setMinty({ phase: 'idle', say: '', stream: '' });
  };

  const onOrbClick = () => {
    if (minty.phase === 'listening') {
      stopListening(); // transcribeResult effect submits what we get back
    } else if (minty.phase === 'speaking' || minty.phase === 'thinking') {
      interruptMinty();
      if (micAvailable) startListening();
    } else if (minty.phase === 'idle') {
      if (micAvailable) startListening();
    }
  };

  // push-to-talk: hold Space to record, release to submit — skipped while a
  // real text field has focus so typing a space still works everywhere else
  const spaceHeldRef = useRef(false);
  // interrupting thinking/speaking: a quick tap should just stop it, a hold
  // should barge in and start listening. Distinguished by whether Space is
  // still held after a short beat — this timer only exists on the
  // interrupt path, so the normal idle press-to-listen stays instant.
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const HOLD_THRESHOLD_MS = 200;
  useEffect(() => {
    const isFormField = (el: EventTarget | null) => {
      if (!(el instanceof HTMLElement)) return false;
      const tag = el.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
    };
    const release = () => {
      spaceHeldRef.current = false;
      if (holdTimerRef.current) {
        clearTimeout(holdTimerRef.current);
        holdTimerRef.current = null;
      }
      if (phaseRef.current === 'listening') stopListening();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || e.repeat || spaceHeldRef.current || isFormField(e.target)) return;
      if (phaseRef.current === 'listening') return; // already recording (e.g. started by click)
      e.preventDefault(); // don't let the page scroll
      spaceHeldRef.current = true;
      if (phaseRef.current === 'thinking' || phaseRef.current === 'speaking') {
        interruptMinty(); // always stops immediately, tap or hold
        // ...but only start a new recording if Space is still down a beat
        // later — a quick tap should just interrupt, not also arm the mic
        holdTimerRef.current = setTimeout(() => {
          holdTimerRef.current = null;
          if (spaceHeldRef.current && micAvailable) startListening();
        }, HOLD_THRESHOLD_MS);
        return;
      }
      if (micAvailable) startListening();
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || !spaceHeldRef.current) return;
      release();
    };
    // holding space through an alt-tab/blur shouldn't leave the mic running forever
    const onBlur = () => {
      if (spaceHeldRef.current) release();
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      if (holdTimerRef.current) clearTimeout(holdTimerRef.current);
    };
  }, [micAvailable]);

  return (
    <div className="minty-dock">
      <div className="minty-header">
        <div className="panel-title minty-title-row">
          Minty <span className="minty-phase">{PHASE_LABEL[minty.phase]}</span>
        </div>
        <div className="minty-title-actions">
          {micAvailable && micDevices.length > 1 && (
            <select
              className="minty-mic-select"
              title="Microphone"
              value={micDeviceId}
              onChange={(e) => selectMicDevice(e.target.value)}
            >
              <option value="">System default</option>
              {micDevices.map((d, i) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label || `Microphone ${i + 1}`}
                </option>
              ))}
            </select>
          )}
          <button
            className="minty-lang"
            title={mintyModel === 'qwen3-8b' ? 'Brain: Qwen3 8B, local & offline (click to switch to Haiku)' : 'Brain: Claude Haiku, cloud (click to switch to local Qwen3)'}
            onClick={toggleMintyModel}
          >
            {mintyModel === 'qwen3-8b' ? 'Qwen' : 'Haiku'}
          </button>
          <button
            className="minty-lang"
            title={lang === 'mixed' ? 'Listening for 中文 + English (click for English only)' : 'Listening for English only (click for 中英混合)'}
            onClick={toggleLang}
          >
            {lang === 'mixed' ? '中/EN' : 'EN'}
          </button>
        </div>
      </div>
      <BrainCanvas phase={minty.phase} voice={voiceRef} onClick={onOrbClick} />
      {(minty.transcript || minty.say || minty.stream) && (
        <div className="minty-caption" title={minty.say || minty.stream || minty.transcript}>
          {minty.say || minty.stream
            ? minty.say || minty.stream
            : `“${minty.transcript}”`}
        </div>
      )}
      {!micAvailable && (
        <input
          className="minty-input"
          type="text"
          placeholder="speech unavailable — type to Minty"
          value={typed}
          disabled={minty.phase === 'thinking'}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && typed.trim()) {
              submit(typed);
              setTyped('');
            }
          }}
        />
      )}
    </div>
  );
}

// A layered particle system: rotating neural web + breathing plasma core +
// free-floating motes + synapse pulses traveling the web + sound-wave rings
// (inward while listening, outward while speaking) + sparks while thinking.

const NODE_COUNT = 40;
const MOTE_COUNT = 90;

// per-state physics: rotation, mote speed/attraction/orbit, event rates (per s)
const PHYS: Record<
  MintyPhase,
  {
    rot: number; mote: number; attract: number; orbit: number;
    pulseRate: number; ringRate: number; ringDir: 1 | -1; sparkRate: number;
    breathAmp: number; breathHz: number;
  }
> = {
  idle: { rot: 0.15, mote: 0.25, attract: 0.02, orbit: 0.12, pulseRate: 0.5, ringRate: 0, ringDir: 1, sparkRate: 0, breathAmp: 0.04, breathHz: 0.5 },
  listening: { rot: 0.35, mote: 0.7, attract: 0.85, orbit: 0.25, pulseRate: 1.5, ringRate: 1.2, ringDir: -1, sparkRate: 0, breathAmp: 0.1, breathHz: 1.6 },
  thinking: { rot: 1.9, mote: 1.4, attract: 0.1, orbit: 1.8, pulseRate: 7, ringRate: 0, ringDir: 1, sparkRate: 4, breathAmp: 0.05, breathHz: 3.2 },
  // speaking baseline is calm — the live voice envelope adds the motion
  speaking: { rot: 0.5, mote: 0.85, attract: -0.35, orbit: 0.35, pulseRate: 2, ringRate: 0.25, ringDir: 1, sparkRate: 0.3, breathAmp: 0.04, breathHz: 1.4 },
};

interface Mote { x: number; y: number; vx: number; vy: number; r: number; tw: number }
interface Ring { r: number; life: number; dir: 1 | -1 }
interface SynPulse { edge: number; t: number; speed: number }
interface Spark { x: number; y: number; vx: number; vy: number; life: number }

function BrainCanvas({
  phase,
  voice,
  onClick,
}: {
  phase: MintyPhase;
  voice: React.MutableRefObject<{ energy: number; talking: boolean }>;
  onClick: () => void;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  useEffect(() => {
    const canvas = ref.current!;
    const ctx = canvas.getContext('2d')!;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const motionScale = reduced ? 0.15 : 1;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    let w = 0;
    let h = 0;
    const resize = () => {
      w = canvas.clientWidth;
      h = canvas.clientHeight;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener('resize', resize);

    // neural web: fibonacci sphere, each node linked to 2 nearest neighbors
    const nodes = Array.from({ length: NODE_COUNT }, (_, i) => {
      const y = 1 - (i / (NODE_COUNT - 1)) * 2;
      const r = Math.sqrt(1 - y * y);
      const theta = i * 2.399963;
      return { x: Math.cos(theta) * r, y, z: Math.sin(theta) * r };
    });
    const edges: [number, number][] = [];
    nodes.forEach((a, i) => {
      const near = nodes
        .map((b, j) => ({ j, d: (a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2 }))
        .filter((e) => e.j !== i)
        .sort((p, q) => p.d - q.d)
        .slice(0, 2);
      for (const { j } of near) {
        if (!edges.some(([p, q]) => (p === i && q === j) || (p === j && q === i))) edges.push([i, j]);
      }
    });

    const motes: Mote[] = Array.from({ length: MOTE_COUNT }, () => ({
      x: (Math.random() - 0.5) * 2,
      y: (Math.random() - 0.5) * 2,
      vx: 0,
      vy: 0,
      r: 0.5 + Math.random() * 1.4,
      tw: Math.random() * Math.PI * 2,
    }));
    const rings: Ring[] = [];
    const pulses: SynPulse[] = [];
    const sparks: Spark[] = [];

    const color: [number, number, number] = [...PHASE_COLOR.idle];
    const cur = { ...PHYS.idle };
    let angle = 0;
    let t = 0;
    let last = performance.now();
    let pulseAcc = 0;
    let ringAcc = 0;
    let sparkAcc = 0;
    let raf = 0;

    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      t += dt;

      const P = PHYS[phaseRef.current] ?? PHYS.idle;
      const C = PHASE_COLOR[phaseRef.current] ?? PHASE_COLOR.idle;
      for (let i = 0; i < 3; i++) color[i] += (C[i] - color[i]) * 0.07;
      cur.rot += (P.rot - cur.rot) * 0.06;
      cur.mote += (P.mote - cur.mote) * 0.06;
      cur.attract += (P.attract - cur.attract) * 0.06;
      cur.orbit += (P.orbit - cur.orbit) * 0.06;
      cur.pulseRate += (P.pulseRate - cur.pulseRate) * 0.06;
      cur.ringRate += (P.ringRate - cur.ringRate) * 0.06;
      cur.sparkRate += (P.sparkRate - cur.sparkRate) * 0.06;
      cur.breathAmp += (P.breathAmp - cur.breathAmp) * 0.06;
      cur.breathHz += (P.breathHz - cur.breathHz) * 0.06;
      cur.ringDir = P.ringDir;

      // voice envelope: spiked by word boundaries, decays through silence
      const speaking = phaseRef.current === 'speaking';
      const v = voice.current;
      v.energy *= Math.exp(-4.5 * dt);
      if (speaking && v.talking) v.energy = Math.max(v.energy, 0.18);
      const energy = speaking ? v.energy : 0;

      const cx = w / 2;
      const cy = h / 2;
      const R = Math.min(w, h) * 0.33;
      const breathe =
        1 + cur.breathAmp * Math.sin(t * cur.breathHz * Math.PI * 2) * motionScale + energy * 0.13;
      angle += cur.rot * dt * motionScale;

      // spawn events (while speaking, rates ride the voice envelope)
      pulseAcc += cur.pulseRate * (speaking ? 0.5 + energy * 1.8 : 1) * dt * motionScale;
      while (pulseAcc >= 1 && pulses.length < 14) {
        pulseAcc -= 1;
        pulses.push({ edge: (Math.random() * edges.length) | 0, t: 0, speed: 1.2 + Math.random() * 1.6 });
      }
      ringAcc += (speaking ? 0.2 + energy * 2.6 : cur.ringRate) * dt * motionScale;
      while (ringAcc >= 1 && rings.length < 8) {
        ringAcc -= 1;
        rings.push({ r: P.ringDir === 1 ? 0.25 : 1.7, life: 1, dir: P.ringDir });
      }
      sparkAcc += cur.sparkRate * dt * motionScale;

      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const proj = nodes.map((n) => {
        const x = n.x * cos - n.z * sin;
        const z = n.x * sin + n.z * cos;
        return { x: cx + x * R * breathe, y: cy + n.y * R * breathe * 0.85, z };
      });

      while (sparkAcc >= 1 && sparks.length < 24) {
        sparkAcc -= 1;
        const p = proj[(Math.random() * proj.length) | 0];
        const a = Math.random() * Math.PI * 2;
        const v = 30 + Math.random() * 60;
        sparks.push({ x: p.x, y: p.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 1 });
      }

      ctx.clearRect(0, 0, w, h);
      const c = `${color[0] | 0},${color[1] | 0},${color[2] | 0}`;

      // halo
      const halo = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * 1.9);
      halo.addColorStop(0, `rgba(${c},0.18)`);
      halo.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = halo;
      ctx.fillRect(0, 0, w, h);

      // sound-wave rings
      for (let i = rings.length - 1; i >= 0; i--) {
        const ring = rings[i];
        ring.r += ring.dir * dt * 0.75;
        ring.life -= dt * 0.55;
        if (ring.life <= 0 || ring.r <= 0.15 || ring.r >= 2.0) {
          rings.splice(i, 1);
          continue;
        }
        const fade = Math.sin(Math.min(1, ring.life) * Math.PI);
        ctx.strokeStyle = `rgba(${c},${(0.28 * fade).toFixed(3)})`;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.ellipse(cx, cy, R * ring.r, R * ring.r * 0.85, 0, 0, Math.PI * 2);
        ctx.stroke();
      }

      // web edges
      for (const [i, j] of edges) {
        const a = proj[i];
        const b = proj[j];
        const depth = (a.z + b.z) / 2 + 1;
        ctx.strokeStyle = `rgba(${c},${(0.08 + depth * 0.15).toFixed(3)})`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }

      // synapse pulses: bright dot + trail traveling along an edge
      ctx.globalCompositeOperation = 'lighter';
      for (let i = pulses.length - 1; i >= 0; i--) {
        const p = pulses[i];
        p.t += p.speed * dt * motionScale;
        if (p.t >= 1) {
          pulses.splice(i, 1);
          continue;
        }
        const [ai, bi] = edges[p.edge];
        const a = proj[ai];
        const b = proj[bi];
        const x = a.x + (b.x - a.x) * p.t;
        const y = a.y + (b.y - a.y) * p.t;
        const trail = ctx.createRadialGradient(x, y, 0, x, y, 7);
        trail.addColorStop(0, `rgba(${c},0.9)`);
        trail.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = trail;
        ctx.beginPath();
        ctx.arc(x, y, 7, 0, Math.PI * 2);
        ctx.fill();
      }

      // nodes
      proj.forEach((p, i) => {
        const depth = (p.z + 1) / 2;
        const tw = 0.6 + 0.4 * Math.sin(t * 2 + i);
        ctx.fillStyle = `rgba(${c},${(0.25 + depth * 0.55 * tw).toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 1 + depth * 2, 0, Math.PI * 2);
        ctx.fill();
      });

      // plasma core
      const coreR = R * 0.24 * breathe;
      const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR);
      core.addColorStop(0, 'rgba(255,255,255,0.85)');
      core.addColorStop(0.35, `rgba(${c},0.55)`);
      core.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = core;
      ctx.beginPath();
      ctx.arc(cx, cy, coreR, 0, Math.PI * 2);
      ctx.fill();

      // free-floating motes (unit space → screen)
      for (const m of motes) {
        const d = Math.hypot(m.x, m.y) || 0.001;
        // attraction / repulsion + tangential orbit + jitter
        m.vx += (-m.x / d) * cur.attract * dt * 1.6 + (-m.y / d) * cur.orbit * dt * 1.4 + (Math.random() - 0.5) * dt * 1.2;
        m.vy += (-m.y / d) * cur.attract * dt * 1.6 + (m.x / d) * cur.orbit * dt * 1.4 + (Math.random() - 0.5) * dt * 1.2;
        m.vx *= 0.97;
        m.vy *= 0.97;
        m.x += m.vx * dt * cur.mote * 4 * motionScale;
        m.y += m.vy * dt * cur.mote * 4 * motionScale;
        // keep them in the neighborhood: soft wrap to a shell
        const dd = Math.hypot(m.x, m.y);
        if (dd > 1.9) {
          m.x *= 0.12 / dd;
          m.y *= 0.12 / dd;
        } else if (dd < 0.1 && cur.attract > 0.3) {
          // re-emit swallowed motes at the rim while listening
          const a = Math.random() * Math.PI * 2;
          m.x = Math.cos(a) * 1.7;
          m.y = Math.sin(a) * 1.7;
          m.vx = m.vy = 0;
        }
        const tw = 0.5 + 0.5 * Math.sin(t * 2.4 + m.tw);
        ctx.fillStyle = `rgba(${c},${(0.5 * tw).toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(cx + m.x * R, cy + m.y * R * 0.9, m.r, 0, Math.PI * 2);
        ctx.fill();
      }

      // sparks
      for (let i = sparks.length - 1; i >= 0; i--) {
        const s = sparks[i];
        s.life -= dt * 2;
        if (s.life <= 0) {
          sparks.splice(i, 1);
          continue;
        }
        s.x += s.vx * dt;
        s.y += s.vy * dt;
        ctx.strokeStyle = `rgba(${c},${(0.7 * s.life).toFixed(3)})`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(s.x, s.y);
        ctx.lineTo(s.x - s.vx * 0.04, s.y - s.vy * 0.04);
        ctx.stroke();
      }
      ctx.globalCompositeOperation = 'source-over';

      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    const onVis = () => {
      cancelAnimationFrame(raf);
      if (!document.hidden) {
        last = performance.now();
        raf = requestAnimationFrame(tick);
      }
    };
    document.addEventListener('visibilitychange', onVis);

    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('resize', resize);
    };
  }, []);

  return (
    <canvas
      ref={ref}
      className="minty-canvas"
      role="button"
      aria-label="Minty voice assistant — click to talk, or hold Space"
      onClick={onClick}
    />
  );
}
