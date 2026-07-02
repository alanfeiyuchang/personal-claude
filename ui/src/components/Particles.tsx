import { useEffect, useRef } from 'react';
import type { SessionState } from '../types';

// State → particle behavior (PLAN.md §4). Canvas-2D field, GPU-cheap at idle,
// honors prefers-reduced-motion by rendering a static gradient.

interface Profile {
  color: [number, number, number];
  speed: number;
  count: number;
  swirl: number; // rotational pull
  flow: number; // directional drift
  pulse: boolean;
  turbulence: number;
}

const PROFILES: Record<SessionState, Profile> = {
  starting: { color: [139, 147, 167], speed: 0.2, count: 120, swirl: 0, flow: 0, pulse: false, turbulence: 0 },
  idle: { color: [100, 116, 139], speed: 0.15, count: 120, swirl: 0, flow: 0, pulse: false, turbulence: 0 },
  thinking: { color: [139, 124, 246], speed: 0.5, count: 260, swirl: 1, flow: 0, pulse: false, turbulence: 0 },
  tool_running: { color: [34, 211, 238], speed: 1.4, count: 320, swirl: 0, flow: 1, pulse: false, turbulence: 0 },
  streaming_output: { color: [52, 211, 153], speed: 0.8, count: 280, swirl: 0.3, flow: 0.4, pulse: false, turbulence: 0 },
  waiting_input: { color: [251, 191, 36], speed: 0.3, count: 200, swirl: 0, flow: 0, pulse: true, turbulence: 0 },
  done: { color: [248, 250, 252], speed: 0.6, count: 220, swirl: 0.2, flow: 0, pulse: false, turbulence: 0 },
  error: { color: [251, 113, 133], speed: 1.2, count: 260, swirl: 0, flow: 0, pulse: false, turbulence: 1 },
  closed: { color: [71, 85, 105], speed: 0.1, count: 80, swirl: 0, flow: 0, pulse: false, turbulence: 0 },
};

const MAX_PARTICLES = 400;

interface P {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  phase: number;
}

export function Particles({ state }: { state: SessionState }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stateRef = useRef<SessionState>(state);
  stateRef.current = state;

  useEffect(() => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext('2d')!;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    let w = 0;
    let h = 0;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const resize = () => {
      w = canvas.clientWidth;
      h = canvas.clientHeight;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener('resize', resize);

    const particles: P[] = Array.from({ length: MAX_PARTICLES }, () => ({
      x: Math.random() * window.innerWidth,
      y: Math.random() * window.innerHeight,
      vx: (Math.random() - 0.5) * 0.4,
      vy: (Math.random() - 0.5) * 0.4,
      r: 0.6 + Math.random() * 1.8,
      phase: Math.random() * Math.PI * 2,
    }));

    // smoothed display color/values so state changes fade, not snap
    let cur = { ...PROFILES[stateRef.current] };
    let color = [...cur.color] as [number, number, number];

    let raf = 0;
    let t = 0;
    const tick = () => {
      const target = PROFILES[stateRef.current] ?? PROFILES.idle;
      t += 0.016;

      // ease toward target profile
      for (let i = 0; i < 3; i++) color[i] += (target.color[i] - color[i]) * 0.05;
      cur.speed += (target.speed - cur.speed) * 0.05;
      cur.count += (target.count - cur.count) * 0.05;
      cur.swirl += (target.swirl - cur.swirl) * 0.05;
      cur.flow += (target.flow - cur.flow) * 0.05;
      cur.turbulence += (target.turbulence - cur.turbulence) * 0.08;

      ctx.clearRect(0, 0, w, h);
      const pulseAlpha = target.pulse ? 0.55 + 0.35 * Math.sin(t * 3) : 0.75;
      const cx = w / 2;
      const cy = h / 2;
      const n = Math.min(MAX_PARTICLES, Math.round(cur.count));

      for (let i = 0; i < n; i++) {
        const p = particles[i];
        // swirl around center
        if (cur.swirl > 0.01) {
          const dx = p.x - cx;
          const dy = p.y - cy;
          const d = Math.hypot(dx, dy) || 1;
          p.vx += (-dy / d) * 0.02 * cur.swirl;
          p.vy += (dx / d) * 0.02 * cur.swirl;
        }
        // directional flow (left→right sweep)
        if (cur.flow > 0.01) p.vx += 0.03 * cur.flow;
        // turbulence
        if (cur.turbulence > 0.01) {
          p.vx += (Math.random() - 0.5) * 0.6 * cur.turbulence;
          p.vy += (Math.random() - 0.5) * 0.6 * cur.turbulence;
        }
        // damping + base drift
        p.vx = p.vx * 0.96 + (Math.random() - 0.5) * 0.02;
        p.vy = p.vy * 0.96 + (Math.random() - 0.5) * 0.02;

        p.x += p.vx * cur.speed * 2;
        p.y += p.vy * cur.speed * 2;

        if (p.x < -10) p.x = w + 10;
        if (p.x > w + 10) p.x = -10;
        if (p.y < -10) p.y = h + 10;
        if (p.y > h + 10) p.y = -10;

        const twinkle = 0.5 + 0.5 * Math.sin(t * 1.7 + p.phase);
        const alpha = pulseAlpha * (0.25 + 0.5 * twinkle);
        ctx.beginPath();
        ctx.fillStyle = `rgba(${color[0] | 0},${color[1] | 0},${color[2] | 0},${alpha.toFixed(3)})`;
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fill();
      }

      // ambient glow
      const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(w, h) * 0.7);
      grad.addColorStop(0, `rgba(${color[0] | 0},${color[1] | 0},${color[2] | 0},0.06)`);
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, w, h);

      raf = requestAnimationFrame(tick);
    };

    const renderStatic = () => {
      const target = PROFILES[stateRef.current] ?? PROFILES.idle;
      const [r, g, b] = target.color;
      ctx.clearRect(0, 0, w, h);
      const grad = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.max(w, h) * 0.7);
      grad.addColorStop(0, `rgba(${r},${g},${b},0.12)`);
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, w, h);
    };

    let staticTimer = 0;
    if (reduced) {
      renderStatic();
      staticTimer = window.setInterval(renderStatic, 500);
    } else {
      const onVis = () => {
        cancelAnimationFrame(raf);
        if (!document.hidden) raf = requestAnimationFrame(tick);
      };
      document.addEventListener('visibilitychange', onVis);
      raf = requestAnimationFrame(tick);
    }

    return () => {
      cancelAnimationFrame(raf);
      clearInterval(staticTimer);
      window.removeEventListener('resize', resize);
    };
  }, []);

  return <canvas ref={canvasRef} className="particle-layer" aria-hidden="true" />;
}
