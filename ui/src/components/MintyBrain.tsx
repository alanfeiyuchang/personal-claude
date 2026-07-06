import { useEffect, useRef, useState } from 'react';
import { useStore, wsSend } from '../store';
import type { MintyPhase } from '../types';

// Minty — the Jarvis-style voice assistant. A neural orb that listens on click
// (Web Speech API), sends the utterance to the server brain, speaks the reply
// (speechSynthesis), and lets the brain drive the app (tasks land in the
// composer via store.mintyTask). Falls back to a text input where speech
// recognition isn't available.

const PHASE_COLOR: Record<MintyPhase, [number, number, number]> = {
  idle: [52, 211, 153], // mint
  listening: [110, 231, 183], // bright mint
  thinking: [139, 124, 246], // violet
  speaking: [34, 211, 238], // cyan
};

const PHASE_LABEL: Record<MintyPhase, string> = {
  idle: 'tap to talk',
  listening: 'listening…',
  thinking: 'thinking…',
  speaking: 'speaking…',
};

type SR = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: any) => void) | null;
  onerror: ((e: any) => void) | null;
  onend: (() => void) | null;
};

function getRecognizer(): SR | null {
  const Ctor = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
  return Ctor ? new Ctor() : null;
}

export function MintyBrain() {
  const minty = useStore((s) => s.minty);
  const setMinty = useStore((s) => s.setMinty);
  const phaseRef = useRef(minty.phase);
  phaseRef.current = minty.phase;

  const recRef = useRef<SR | null>(null);
  const [srAvailable] = useState(() => !!((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition));
  const [typed, setTyped] = useState('');

  // 'mixed' = Mandarin recognizer (handles 中英 code-switching); 'en' = English only
  const [lang, setLang] = useState(() => localStorage.getItem('pc-minty-lang') || 'mixed');
  const langRef = useRef(lang);
  langRef.current = lang;
  const toggleLang = () => {
    const next = lang === 'mixed' ? 'en' : 'mixed';
    setLang(next);
    localStorage.setItem('pc-minty-lang', next);
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
  // live voice envelope: word boundaries spike energy, silence decays it —
  // the orb reads this to animate in rhythm with the actual audio
  const voiceRef = useRef({ energy: 0, talking: false });

  const maybeIdle = () => {
    if (finalSpokenRef.current && activeUtterRef.current <= 0 && phaseRef.current === 'speaking') {
      setMinty({ phase: 'idle' });
    }
  };

  const speakChunk = (text: string) => {
    const t = text.trim();
    if (!t) return;
    const u = new SpeechSynthesisUtterance(t);
    const voices = speechSynthesis.getVoices();
    // pick the voice per chunk: Chinese voices read mixed 中英 sentences well
    const hasCJK = /[㐀-䶿一-鿿豈-﫿]/.test(t);
    if (hasCJK) {
      u.lang = 'zh-CN';
      u.voice =
        voices.find((v) => v.name === 'Tingting') ??
        voices.find((v) => v.lang.replace('_', '-').startsWith('zh') && v.localService) ??
        voices.find((v) => v.lang.replace('_', '-').startsWith('zh')) ??
        null;
    } else {
      u.lang = 'en-US';
      u.voice =
        voices.find((v) => v.name === 'Samantha') ??
        voices.find((v) => v.lang.startsWith('en') && v.localService) ??
        voices.find((v) => v.lang.startsWith('en')) ??
        null;
    }
    u.rate = 1.05;
    activeUtterRef.current++;
    u.onstart = () => {
      voiceRef.current.talking = true;
      voiceRef.current.energy = Math.max(voiceRef.current.energy, 0.7);
    };
    u.onboundary = () => {
      voiceRef.current.energy = 1; // a word is being spoken right now
    };
    u.onend = u.onerror = () => {
      activeUtterRef.current--;
      if (activeUtterRef.current <= 0) voiceRef.current.talking = false;
      maybeIdle();
    };
    speechSynthesis.speak(u); // utterances queue natively, in order
  };

  const submit = (text: string) => {
    const t = text.trim();
    if (!t) return;
    speechSynthesis.cancel();
    enqueuedRef.current = 0;
    activeUtterRef.current = 0;
    finalSpokenRef.current = false;
    setMinty({ phase: 'thinking', transcript: t, say: '', stream: '', done: false });
    wsSend({ type: 'minty', text: t });
  };

  // stream deltas → speak each completed sentence immediately
  // (CJK sentence enders need no trailing space; latin ones do)
  useEffect(() => {
    const pending = minty.stream.slice(enqueuedRef.current);
    const m = pending.match(/^[\s\S]*(?:[.!?…](?=\s|$)|[。！？；])/);
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

  const startListening = () => {
    const rec = getRecognizer();
    if (!rec) return;
    recRef.current = rec;
    // Mandarin recognizer transcribes 中英 code-switched speech; English-only
    // mode is more accurate when no Chinese is expected
    rec.lang = langRef.current === 'mixed' ? 'zh-CN' : 'en-US';
    rec.continuous = false;
    rec.interimResults = true;
    let finalText = '';
    rec.onresult = (e: any) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finalText += r[0].transcript;
        else interim += r[0].transcript;
      }
      setMinty({ transcript: (finalText + ' ' + interim).trim() });
    };
    rec.onerror = (e: any) => {
      setMinty({ phase: 'idle', say: '', transcript: e.error === 'not-allowed' ? 'mic permission denied' : `mic error: ${e.error}` });
    };
    rec.onend = () => {
      recRef.current = null;
      if (phaseRef.current !== 'listening') return;
      if (finalText.trim()) submit(finalText);
      else setMinty({ phase: 'idle' });
    };
    setMinty({ phase: 'listening', transcript: '', say: '' });
    rec.start();
  };

  const onOrbClick = () => {
    if (minty.phase === 'listening') {
      recRef.current?.stop(); // onend submits what we have
    } else if (minty.phase === 'speaking') {
      speechSynthesis.cancel();
      setMinty({ phase: 'idle' });
      if (srAvailable) startListening();
    } else if (minty.phase === 'idle') {
      if (srAvailable) startListening();
    }
    // thinking: ignore clicks
  };

  return (
    <div className="minty-dock">
      <div className="panel-title minty-title">
        <span>
          Minty <span className="minty-phase">{PHASE_LABEL[minty.phase]}</span>
        </span>
        <button
          className="minty-lang"
          title={lang === 'mixed' ? 'Listening for 中文 + English (click for English only)' : 'Listening for English only (click for 中英混合)'}
          onClick={toggleLang}
        >
          {lang === 'mixed' ? '中/EN' : 'EN'}
        </button>
      </div>
      <BrainCanvas phase={minty.phase} voice={voiceRef} onClick={onOrbClick} />
      {(minty.transcript || minty.say || minty.stream) && (
        <div className="minty-caption" title={minty.say || minty.stream || minty.transcript}>
          {minty.say || minty.stream
            ? minty.say || minty.stream
            : `“${minty.transcript}”`}
        </div>
      )}
      {!srAvailable && (
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

// ── the orb ────────────────────────────────────────────────────────────────
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
      aria-label="Minty voice assistant — click to talk"
      onClick={onClick}
    />
  );
}
