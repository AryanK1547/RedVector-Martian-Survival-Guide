import type { SimAudio, Speaker } from "./sim/stage";

// Designed sound for the simulation, synthesised with Web Audio (no audio
// files). It is SIMULATION AUDIO: wind, breathing, footsteps, suit noises,
// radio and music are designed effects, not recordings from Mars.
//
// One idea from real Mars science shapes the mix: Mars's air is thin carbon
// dioxide, so it carries sound weakly and high pitches worst of all (NASA
// Perseverance microphone results, 2022). Outside sounds (wind, grit) therefore
// go through a muffling low-pass "exterior" bus; sounds that reach you through
// the suit itself (your breath, your boots, the fans) stay clear.
//
// Variety: nothing repeats on a fixed loop. Wind is three layers whose filters
// and stereo position drift on random walks, with gusts at random intervals;
// every breath, step and suit click gets its own small random variation.

// ---- one shared AudioContext (created on the first click, kept for the session) ----
let sharedCtx: AudioContext | null = null;
export function soundContext(): AudioContext | null {
  if (!sharedCtx) {
    try {
      sharedCtx = new AudioContext();
    } catch {
      return null;
    }
    document.addEventListener("visibilitychange", () => void (document.hidden ? sharedCtx?.suspend() : sharedCtx?.resume()));
  }
  void sharedCtx.resume();
  return sharedCtx;
}

// User choices, kept between the airlock and the walk.
const prefs = { muted: false, voice: true, music: true };

// ---- noise buffers: white, pink, brown (4 s each, made once) ----
const buffers = new WeakMap<AudioContext, Record<"white" | "pink" | "brown", AudioBuffer>>();
function noise(ctx: AudioContext, kind: "white" | "pink" | "brown"): AudioBuffer {
  let b = buffers.get(ctx);
  if (!b) {
    const make = (fill: (d: Float32Array) => void) => {
      const buf = ctx.createBuffer(1, ctx.sampleRate * 4, ctx.sampleRate);
      fill(buf.getChannelData(0));
      return buf;
    };
    b = {
      white: make((d) => {
        for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      }),
      pink: make((d) => {
        // Paul Kellet's pink-noise filter
        let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
        for (let i = 0; i < d.length; i++) {
          const w = Math.random() * 2 - 1;
          b0 = 0.99886 * b0 + w * 0.0555179;
          b1 = 0.99332 * b1 + w * 0.0750759;
          b2 = 0.969 * b2 + w * 0.153852;
          b3 = 0.8665 * b3 + w * 0.3104856;
          b4 = 0.55 * b4 + w * 0.5329522;
          b5 = -0.7616 * b5 - w * 0.016898;
          d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
          b6 = w * 0.115926;
        }
      }),
      brown: make((d) => {
        let last = 0;
        for (let i = 0; i < d.length; i++) {
          last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
          d[i] = last * 3.5;
        }
      }),
    };
    buffers.set(ctx, b);
  }
  return b[kind];
}

// A small toolkit bound to one context and one output, with cleanup.
function kit(ctx: AudioContext, out: AudioNode) {
  const timers: number[] = [];
  const sources: AudioScheduledSourceNode[] = [];
  let alive = true;
  const rand = (a: number, b: number) => a + Math.random() * (b - a);
  const loop = (kind: "white" | "pink" | "brown", rate = 1) => {
    const s = ctx.createBufferSource();
    s.buffer = noise(ctx, kind);
    s.loop = true;
    s.playbackRate.value = rate;
    s.start(0, Math.random() * 3.5);
    sources.push(s);
    return s;
  };
  const filter = (type: BiquadFilterType, freq: number, q = 0.7) => {
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    return f;
  };
  const gain = (v: number) => {
    const g = ctx.createGain();
    g.gain.value = v;
    return g;
  };
  const pan = (v: number) => {
    const p = ctx.createStereoPanner();
    p.pan.value = v;
    return p;
  };
  const tone = (freq: number, at: number, dur: number, vol: number, type: OscillatorType = "sine", dest: AudioNode = out, panV = 0) => {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(vol, at + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    o.connect(g);
    if (panV) g.connect(pan(panV)).connect(dest);
    else g.connect(dest);
    o.start(at);
    o.stop(at + dur + 0.05);
    return o;
  };
  const burst = (at: number, dur: number, vol: number, hp: number, lp: number, dest: AudioNode = out, panV = 0, kind: "white" | "pink" | "brown" = "white") => {
    const s = ctx.createBufferSource();
    s.buffer = noise(ctx, kind);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(vol, at + Math.min(0.01, dur * 0.2));
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    let node: AudioNode = s.connect(filter("highpass", hp)).connect(filter("lowpass", lp)).connect(g);
    if (panV) node = node.connect(pan(panV));
    node.connect(dest);
    s.start(at, Math.random() * 3.5, dur + 0.05);
  };
  // run fn every [min,max] seconds, at random
  const every = (min: number, max: number, fn: () => void) => {
    const step = () => {
      if (!alive) return;
      fn();
      timers.push(window.setTimeout(step, rand(min, max) * 1000));
    };
    timers.push(window.setTimeout(step, rand(min, max) * 1000));
  };
  const interval = (ms: number, fn: () => void) => timers.push(window.setInterval(() => alive && fn(), ms));
  const stop = () => {
    alive = false;
    timers.forEach((t) => (window.clearTimeout(t), window.clearInterval(t)));
    sources.forEach((s) => {
      try {
        s.stop();
      } catch {
        /* already stopped */
      }
    });
  };
  return { rand, loop, filter, gain, pan, tone, burst, every, interval, stop, get alive() {
    return alive;
  } };
}

// A short synthetic "inside the helmet" reflection, so breath sounds enclosed.
function helmetVerb(ctx: AudioContext): ConvolverNode {
  const len = Math.floor(ctx.sampleRate * 0.14);
  const ir = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = ir.getChannelData(ch);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3.2) * (i < 40 ? 0 : 1);
  }
  const c = ctx.createConvolver();
  c.buffer = ir;
  return c;
}

// ---- Mars wind: three drifting layers plus random gusts ----
function createWind(ctx: AudioContext, out: AudioNode) {
  const k = kit(ctx, out);
  const bus = k.gain(0);
  bus.connect(out);
  // rumble: deep pressure of the wind against the suit
  const rumbleG = k.gain(0.5);
  k.loop("brown").connect(k.filter("lowpass", 140)).connect(rumbleG).connect(bus);
  // body: the broad "whoosh", wandering in pitch and across the stereo field
  const bodyF = k.filter("bandpass", 420, 0.8);
  const bodyP = k.pan(0);
  const bodyG = k.gain(0.55);
  k.loop("pink").connect(bodyF).connect(bodyG).connect(bodyP).connect(bus);
  // whistle: thin, high, intermittent; wind over helmet edges and rocks
  const whistleF = k.filter("bandpass", 1200, 12);
  const whistleP = k.pan(0.3);
  const whistleG = k.gain(0);
  k.loop("white").connect(whistleF).connect(whistleG).connect(whistleP).connect(bus);
  let level = 0; // 0 quiet, 1 storm
  let base = 0.05;
  const walk = { f: 420, p: 0, wf: 1200, wp: 0.3 };
  k.interval(260, () => {
    const t = ctx.currentTime;
    walk.f = Math.min(780, Math.max(220, walk.f + k.rand(-35, 35)));
    walk.p = Math.min(0.8, Math.max(-0.8, walk.p + k.rand(-0.08, 0.08)));
    walk.wf = Math.min(1900, Math.max(800, walk.wf + k.rand(-60, 60)));
    walk.wp = Math.min(0.9, Math.max(-0.9, walk.wp + k.rand(-0.1, 0.1)));
    bodyF.frequency.setTargetAtTime(walk.f + level * 260, t, 0.6);
    bodyP.pan.setTargetAtTime(walk.p, t, 0.8);
    whistleF.frequency.setTargetAtTime(walk.wf, t, 0.8);
    whistleP.pan.setTargetAtTime(walk.wp, t, 0.8);
  });
  // gusts: swell, hold, fade; more often and stronger in a storm
  const gust = () => {
    const t = ctx.currentTime;
    const s = k.rand(0.5, 1.4) * (1 + level * 1.4);
    const up = k.rand(0.8, 2.6);
    const hold = k.rand(0.3, 1.8);
    const down = k.rand(1.8, 4.5);
    bus.gain.cancelScheduledValues(t);
    bus.gain.setValueAtTime(bus.gain.value, t);
    bus.gain.linearRampToValueAtTime(base * (1 + s), t + up);
    bus.gain.linearRampToValueAtTime(base * (1 + s * 0.8), t + up + hold);
    bus.gain.linearRampToValueAtTime(base, t + up + hold + down);
    if (Math.random() < 0.45 + level * 0.4) {
      whistleG.gain.setTargetAtTime(k.rand(0.05, 0.16) * (0.6 + level), t + up * 0.6, 0.5);
      whistleG.gain.setTargetAtTime(0, t + up + hold, 0.9);
    }
  };
  const gustLoop = () => {
    if (!k.alive) return;
    gust();
    window.setTimeout(gustLoop, k.rand(4, 13) * (1 - level * 0.6) * 1000);
  };
  window.setTimeout(gustLoop, 1500);
  return {
    set(on: number, storm: number) {
      level = storm;
      base = on * (0.05 + storm * 0.16);
      bus.gain.setTargetAtTime(base, ctx.currentTime, 1.2);
      rumbleG.gain.setTargetAtTime(0.5 + storm * 0.6, ctx.currentTime, 1);
    },
    stop: k.stop,
  };
}

// ---- breathing in the helmet; rate, depth and variety follow exertion ----
function createBreath(ctx: AudioContext, out: AudioNode) {
  const k = kit(ctx, out);
  const g = k.gain(0.0001);
  const f1 = k.filter("bandpass", 650, 1.1);
  const f2 = k.filter("bandpass", 1700, 1.6);
  const f2g = k.gain(0.45);
  const src = k.loop("pink", 1);
  src.connect(f1).connect(g);
  src.connect(f2).connect(f2g).connect(g);
  g.connect(out);
  let exertion = 0;
  let stress = 0;
  let n = 0;
  let timer = 0;
  const breathe = (inhale: boolean) => {
    if (!k.alive) return;
    const ex = Math.min(1, exertion + stress * 0.35);
    let period = (4.2 - 2.5 * ex) * k.rand(0.85, 1.15); // ~4 s calm, ~1.7 s hard at work
    const deep = inhale && ++n % Math.round(k.rand(6, 10)) === 0; // now and then, a deeper breath
    if (deep) period *= 1.5;
    const t = ctx.currentTime;
    const peak = (0.035 + 0.06 * ex) * (deep ? 1.5 : 1) * k.rand(0.8, 1.15);
    if (inhale) {
      g.gain.setTargetAtTime(peak, t, period * 0.1);
      f1.frequency.setTargetAtTime(k.rand(850, 1050), t, period * 0.15);
      f2.frequency.setTargetAtTime(k.rand(1900, 2400), t, period * 0.15);
      src.playbackRate.setTargetAtTime(k.rand(0.95, 1.08), t, 0.2);
    } else {
      g.gain.setTargetAtTime(peak * 0.75, t, 0.06);
      g.gain.setTargetAtTime(0.0008, t + period * 0.22, period * 0.12);
      f1.frequency.setTargetAtTime(k.rand(480, 600), t, period * 0.18);
      f2.frequency.setTargetAtTime(k.rand(1300, 1600), t, period * 0.18);
      src.playbackRate.setTargetAtTime(k.rand(0.85, 0.95), t, 0.2);
    }
    const pause = !inhale && ex < 0.4 ? k.rand(0.2, 0.9) : 0; // calm breathing has a pause after the exhale
    timer = window.setTimeout(() => breathe(!inhale), ((inhale ? 0.42 : 0.58) * period + pause) * 1000);
  };
  breathe(true);
  return {
    set(ex: number, st: number) {
      exertion = ex;
      stress = st;
    },
    stop() {
      window.clearTimeout(timer);
      k.stop();
    },
  };
}

// ---- heartbeat: only felt when things get tense ----
function createHeart(ctx: AudioContext, out: AudioNode) {
  const k = kit(ctx, out);
  let stress = 0;
  let timer = 0;
  const beat = () => {
    if (!k.alive) return;
    const bpm = 72 + stress * 55;
    if (stress > 0.05) {
      const t = ctx.currentTime;
      const v = 0.08 * stress;
      const thump = (at: number, f: number, vol: number) => {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.frequency.setValueAtTime(f, at);
        o.frequency.exponentialRampToValueAtTime(f * 0.6, at + 0.12);
        g.gain.setValueAtTime(0.0001, at);
        g.gain.exponentialRampToValueAtTime(vol, at + 0.015);
        g.gain.exponentialRampToValueAtTime(0.0001, at + 0.16);
        o.connect(g).connect(out);
        o.start(at);
        o.stop(at + 0.2);
      };
      thump(t, 58, v);
      thump(t + 0.22, 48, v * 0.7);
    }
    timer = window.setTimeout(beat, (60 / bpm) * 1000);
  };
  beat();
  return {
    set(s: number) {
      stress = s;
    },
    stop() {
      window.clearTimeout(timer);
      k.stop();
    },
  };
}

// ---- a slow, evolving music pad; darker when things go wrong ----
function createPad(ctx: AudioContext, out: AudioNode) {
  const k = kit(ctx, out);
  const bus = k.gain(0);
  const lp = k.filter("lowpass", 600, 0.5);
  bus.connect(lp).connect(out);
  const lfo = ctx.createOscillator();
  lfo.frequency.value = 0.045;
  const lfoG = k.gain(260);
  lfo.connect(lfoG).connect(lp.frequency);
  lfo.start();
  // Voicings around D: open fifths and suspended chords (calm, spacious).
  const CALM = [
    [73.42, 110, 146.83, 220, 329.63],
    [65.41, 98, 146.83, 196, 293.66],
    [58.27, 87.31, 130.81, 174.61, 261.63],
    [69.3, 103.83, 138.59, 207.65, 311.13],
  ];
  const TENSE = [
    [73.42, 77.78, 110, 155.56, 233.08],
    [61.74, 65.41, 92.5, 138.59, 185],
  ];
  let tension = 0;
  let current: { g: GainNode; osc: OscillatorNode[] } | null = null;
  const play = () => {
    if (!k.alive) return;
    const set = tension > 0.5 ? TENSE : CALM;
    const chord = set[Math.floor(Math.random() * set.length)];
    const t = ctx.currentTime;
    const g = k.gain(0);
    g.connect(bus);
    const osc: OscillatorNode[] = [];
    chord.forEach((f, i) => {
      for (const det of [-6, 5]) {
        const o = ctx.createOscillator();
        o.type = i < 2 ? "triangle" : "sawtooth";
        o.frequency.value = f;
        o.detune.value = det + k.rand(-3, 3);
        const og = k.gain(i < 2 ? 0.22 : 0.07);
        o.connect(og).connect(g);
        o.start(t);
        osc.push(o);
      }
    });
    g.gain.linearRampToValueAtTime(1, t + 5);
    if (current) {
      const old = current;
      old.g.gain.cancelScheduledValues(t);
      old.g.gain.setValueAtTime(old.g.gain.value, t);
      old.g.gain.linearRampToValueAtTime(0, t + 5);
      window.setTimeout(() => old.osc.forEach((o) => o.stop()), 5500);
    }
    current = { g, osc };
    window.setTimeout(play, k.rand(14, 22) * 1000);
  };
  play();
  // a soft pulse joins in when the margin is gone
  const pulseG = k.gain(0);
  const pulse = ctx.createOscillator();
  pulse.type = "sine";
  pulse.frequency.value = 36.71;
  const pulseLfo = ctx.createOscillator();
  pulseLfo.frequency.value = 1.6;
  const pulseDepth = k.gain(0);
  pulseLfo.connect(pulseDepth).connect(pulseG.gain);
  pulse.connect(pulseG).connect(out);
  pulse.start();
  pulseLfo.start();
  return {
    set(on: boolean, t: number) {
      tension = t;
      bus.gain.setTargetAtTime(on ? 0.05 : 0, ctx.currentTime, 2);
      pulseDepth.gain.setTargetAtTime(on && t > 0.9 ? 0.05 : 0, ctx.currentTime, 1);
    },
    stop() {
      k.stop();
      [lfo, pulse, pulseLfo].forEach((o) => o.stop());
      current?.osc.forEach((o) => o.stop());
    },
  };
}

// ---- radio: Quindar-style beeps, band-limited static, speech ----
function createRadio(ctx: AudioContext, out: AudioNode) {
  const k = kit(ctx, out);
  const staticG = k.gain(0);
  k.loop("white").connect(k.filter("highpass", 500)).connect(k.filter("lowpass", 3200)).connect(staticG).connect(out);
  const speakOk = typeof speechSynthesis !== "undefined";
  // English voices installed on the device first: online ("natural") voices fail silently when the network is slow or blocked.
  const voices = () => {
    const en = speakOk ? speechSynthesis.getVoices().filter((v) => v.lang.toLowerCase().startsWith("en")) : [];
    const local = en.filter((v) => v.localService);
    return local.length ? local : en;
  };
  // Different speakers get different voices where the browser has them.
  const VOICE: Record<Speaker, { idx: number; pitch: number; rate: number }> = {
    capcom: { idx: 0, pitch: 0.85, rate: 1.04 },
    science: { idx: 1, pitch: 1.1, rate: 1.08 },
    earth: { idx: 2, pitch: 0.95, rate: 0.98 },
    suit: { idx: 3, pitch: 1.25, rate: 1.0 },
  };
  // The 2525 / 2475 Hz "Quindar" beeps marked the start and end of a
  // transmission on NASA's Apollo-era radio loops; used here as a stylistic nod.
  const quindar = (at: number, start: boolean) => k.tone(start ? 2525 : 2475, at, 0.25, 0.035);
  const squelch = (at: number) => k.burst(at, k.rand(0.05, 0.1), 0.06, 1500, 4200);
  return {
    say(text: string, urgent: boolean, who: Speaker) {
      const t = ctx.currentTime;
      squelch(t);
      quindar(t + 0.06, true);
      if (urgent) k.tone(1900, t + 0.34, 0.06, 0.035);
      if (!speakOk || !prefs.voice || prefs.muted) return;
      const v = VOICE[who];
      const build = (pickVoice: boolean) => {
        const u = new SpeechSynthesisUtterance(text);
        const list = voices();
        if (pickVoice && list.length) u.voice = list[v.idx % list.length];
        u.pitch = v.pitch;
        u.rate = v.rate;
        u.volume = 0.9;
        u.onstart = () => staticG.gain.setTargetAtTime(0.012, ctx.currentTime, 0.05);
        u.onend = () => {
          staticG.gain.setTargetAtTime(0, ctx.currentTime, 0.05);
          if (k.alive) {
            squelch(ctx.currentTime);
            quindar(ctx.currentTime + 0.04, false);
          }
        };
        return u;
      };
      const u = build(true);
      // If the chosen voice cannot speak (an online voice with no network, say), say it again with the browser's default voice.
      u.onerror = (e) => {
        if (pickedRetry || e.error === "canceled" || e.error === "interrupted" || !k.alive || prefs.muted) return;
        pickedRetry = true;
        speechSynthesis.speak(build(false));
      };
      let pickedRetry = false;
      if (urgent) speechSynthesis.cancel();
      window.setTimeout(() => {
        if (!k.alive || prefs.muted) return;
        speechSynthesis.resume(); // Chrome can leave the speech queue paused after a cancel
        speechSynthesis.speak(u);
      }, 360);
    },
    stop() {
      k.stop();
      if (speakOk) speechSynthesis.cancel();
    },
  };
}

// Sound that outlives its screen briefly (the airlock wind while the walk loads).
let lingering: { dispose(): void } | null = null;
const endLinger = () => {
  lingering?.dispose();
  lingering = null;
};

// ===================== the EVA suit, during the walk =====================
export interface SuitAudio extends SimAudio {
  footstep(strength?: number): void;
  setMuted(m: boolean): void;
  setVoice(on: boolean): void;
  setMusic(on: boolean): void;
  readonly muted: boolean;
  readonly voice: boolean;
  readonly music: boolean;
}

export function createSuitAudio(): SuitAudio | null {
  const ctx = soundContext();
  if (!ctx) return null;
  const master = ctx.createGain();
  master.gain.value = 0;
  master.connect(ctx.destination);
  master.gain.setTargetAtTime(prefs.muted ? 0 : 0.9, ctx.currentTime, 0.6);
  window.setTimeout(endLinger, 1200); // crossfade from the airlock

  // buses: exterior (muffled by thin air), helmet (breath with reflection), suit (direct)
  const exterior = ctx.createBiquadFilter();
  exterior.type = "lowpass";
  exterior.frequency.value = 2400;
  exterior.connect(master);
  const helmet = ctx.createGain();
  helmet.gain.value = 1;
  const verb = helmetVerb(ctx);
  const wet = ctx.createGain();
  wet.gain.value = 0.35;
  helmet.connect(master);
  helmet.connect(verb).connect(wet).connect(master);
  const musicBus = ctx.createGain();
  musicBus.connect(master);

  const k = kit(ctx, master);
  const wind = createWind(ctx, exterior);
  wind.set(1, 0);
  const breath = createBreath(ctx, helmet);
  const heart = createHeart(ctx, master);
  const pad = createPad(ctx, musicBus);
  pad.set(prefs.music, 0);
  const radio = createRadio(ctx, master);

  // suit fans and airflow: always there, slowly wavering
  const fan = k.gain(0.01);
  fan.connect(k.filter("lowpass", 500)).connect(master);
  for (const f of [118, 177.5]) {
    const o = ctx.createOscillator();
    o.type = "triangle";
    o.frequency.value = f;
    const wob = ctx.createOscillator();
    wob.frequency.value = k.rand(0.05, 0.12);
    const wobG = k.gain(1.5);
    wob.connect(wobG).connect(o.detune);
    o.connect(fan);
    o.start();
    wob.start();
  }
  const air = k.gain(0.012);
  k.loop("pink").connect(k.filter("bandpass", 900, 0.6)).connect(air).connect(master);

  // occasional suit-system noises: valve, servo, comms tick (cosmetic)
  k.every(12, 35, () => {
    const t = ctx.currentTime;
    const r = Math.random();
    if (r < 0.4) {
      k.tone(k.rand(1800, 2600), t, 0.03, 0.03, "square", master, k.rand(-0.4, 0.4));
      k.burst(t + 0.03, k.rand(0.25, 0.5), 0.02, 2000, 6000, helmet); // regulator puff
    } else if (r < 0.75) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = "sawtooth";
      o.frequency.setValueAtTime(k.rand(140, 200), t);
      o.frequency.linearRampToValueAtTime(k.rand(240, 320), t + 0.35);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.012, t + 0.05);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);
      o.connect(k.filter("bandpass", 900, 2)).connect(g).connect(k.pan(k.rand(-0.6, 0.6))).connect(master);
      o.start(t);
      o.stop(t + 0.45);
    } else {
      k.burst(t, 0.03, 0.03, 2500, 5000);
      k.burst(t + 0.09, 0.02, 0.02, 2500, 5000);
    }
  });

  // dust storm: fine grit ticking on the visor
  let grit = 0;
  k.interval(40, () => {
    if (grit <= 0 || Math.random() > grit * 0.55) return;
    const t = ctx.currentTime + Math.random() * 0.04;
    k.burst(t, k.rand(0.003, 0.012), k.rand(0.01, 0.05), 3000, 9000, master, k.rand(-0.9, 0.9));
  });

  // leak: a hiss that flutters
  const leakG = k.gain(0);
  const leakF = k.filter("highpass", 3200);
  k.loop("white").connect(leakF).connect(leakG).connect(master);
  k.interval(180, () => leakF.frequency.setTargetAtTime(k.rand(2800, 4200), ctx.currentTime, 0.1));

  // warning tones
  let state = { exertion: 0, dust: 0, leak: false, level: "ok" as "ok" | "caution" | "turn-back", active: false };
  let lastAlarm = 0;
  k.interval(250, () => {
    if (!state.active || state.level === "ok") return;
    const now = ctx.currentTime;
    const gap = state.level === "turn-back" ? 1.6 : 5;
    if (now - lastAlarm < gap) return;
    lastAlarm = now;
    if (state.level === "turn-back") [0, 0.16, 0.32].forEach((d, i) => k.tone(i % 2 ? 660 : 880, now + d, 0.12, 0.12, "square"));
    else [0, 0.2].forEach((d, i) => k.tone(i ? 1318.5 : 1046.5, now + d, 0.3, 0.06));
  });

  let step = 0;
  let alive = true;
  const api: SuitAudio = {
    get muted() {
      return prefs.muted;
    },
    get voice() {
      return prefs.voice;
    },
    get music() {
      return prefs.music;
    },
    setMuted(m) {
      prefs.muted = m;
      master.gain.setTargetAtTime(m ? 0 : 0.9, ctx.currentTime, 0.05);
      if (m && typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
    },
    setVoice(on) {
      prefs.voice = on;
      if (!on && typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
    },
    setMusic(on) {
      prefs.music = on;
      pad.set(on, state.level === "turn-back" ? 1 : state.level === "caution" ? 0.6 : 0);
    },
    setState(next) {
      state = next;
      const stress = next.level === "turn-back" ? 1 : next.level === "caution" ? 0.5 : next.leak ? 0.4 : 0;
      wind.set(1, next.dust);
      grit = next.dust;
      exterior.frequency.setTargetAtTime(2400 - next.dust * 900, ctx.currentTime, 1);
      breath.set(next.active ? next.exertion : 0.1, stress);
      heart.set(next.active ? stress : 0);
      pad.set(prefs.music, next.level === "turn-back" ? 1 : next.level === "caution" ? 0.6 : 0);
      leakG.gain.setTargetAtTime(next.leak ? 0.04 : 0, ctx.currentTime, 0.3);
    },
    footstep(strength = 1) {
      if (!alive) return;
      const t = ctx.currentTime;
      const side = step++ % 2 ? 0.22 : -0.22;
      const v = strength * k.rand(0.8, 1.15);
      // boot thump, felt through the suit
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.setValueAtTime(k.rand(85, 120), t);
      o.frequency.exponentialRampToValueAtTime(40, t + 0.1);
      g.gain.setValueAtTime(0.13 * v, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
      o.connect(g).connect(master);
      o.start(t);
      o.stop(t + 0.15);
      // crunch of regolith, heard faintly through thin air
      k.burst(t, k.rand(0.07, 0.12), 0.16 * v, 150, k.rand(600, 1200), exterior, side, "pink");
      k.burst(t + 0.01, 0.04, 0.05 * v, 2400, 7000, exterior, side);
      if (Math.random() < 0.25) k.burst(t + 0.04, k.rand(0.15, 0.28), 0.04 * v, 600, 2500, exterior, side); // a scrape
      if (Math.random() < 0.2) for (let i = 0; i < 3; i++) k.burst(t + k.rand(0.05, 0.25), 0.008, 0.02 * v, 3000, 8000, exterior, side * 2); // pebbles
      k.burst(t, 0.12, 0.012, 1800, 3500, helmet); // suit fabric
    },
    radio(text, urgent = false, who: Speaker = "capcom") {
      if (!alive) return;
      void ctx.resume();
      radio.say(text, urgent, who);
    },
    chime() {
      const t = ctx.currentTime;
      k.tone(660, t, 0.5, 0.08);
      k.tone(990, t + 0.12, 0.6, 0.07);
    },
    // A decision needs an answer: three rising tones, distinct from the alarms.
    alert() {
      const t = ctx.currentTime;
      [523.25, 659.25, 783.99].forEach((f, i) => k.tone(f, t + i * 0.11, 0.35, 0.09, "triangle"));
      k.tone(1046.5, t + 0.4, 0.5, 0.05);
    },
    // One tick of the countdown: a soft wooden click, higher and louder as time runs out.
    tick(left) {
      const t = ctx.currentTime;
      const urgent = left <= 5;
      k.tone(urgent ? 1500 : 980, t, 0.05, urgent ? 0.1 : 0.05, "square", master);
      k.burst(t, 0.02, urgent ? 0.06 : 0.03, 2000, 6000);
      if (left <= 3) k.tone(urgent ? 700 : 500, t + 0.02, 0.12, 0.06);
    },
    // A mission task is done: a short bright arpeggio.
    taskDone() {
      const t = ctx.currentTime;
      [880, 1108.7, 1318.5].forEach((f, i) => k.tone(f, t + i * 0.07, 0.3, 0.06, "sine"));
    },
    dispose() {
      if (!alive) return;
      alive = false;
      master.gain.setTargetAtTime(0, ctx.currentTime, 0.15);
      window.setTimeout(() => {
        [wind, breath, heart, pad, radio].forEach((x) => x.stop());
        k.stop();
        master.disconnect();
      }, 700);
    },
  };
  return api;
}

// ===================== the airlock, on the start screen =====================
export interface AirlockAudio {
  boot(): void;
  tick(): void; // a data file arrived
  ready(): void;
  depressurize(seconds: number): void;
  doorOpen(): void;
  linger(): void; // keep the outside wind going into the walk, then fade
  dispose(): void;
}

export function createAirlockAudio(): AirlockAudio | null {
  const ctx = soundContext();
  if (!ctx) return null;
  const master = ctx.createGain();
  master.gain.value = prefs.muted ? 0 : 0.9;
  master.connect(ctx.destination);
  const k = kit(ctx, master);

  // the room: everything that needs air to reach you, and fades as the air leaves
  const room = k.gain(0);
  room.connect(master);
  room.gain.setTargetAtTime(1, ctx.currentTime, 1.5);
  const roomLp = k.filter("lowpass", 8000);
  roomLp.connect(room);
  const hum = k.gain(0.03);
  hum.connect(roomLp);
  for (const [f, v] of [[55, 1], [110, 0.5], [165, 0.2]] as const) {
    const o = ctx.createOscillator();
    o.frequency.value = f;
    const g = k.gain(v);
    o.connect(g).connect(hum);
    o.start();
  }
  const vent = k.gain(0.03);
  k.loop("pink").connect(k.filter("bandpass", 380, 0.6)).connect(vent).connect(roomLp);
  // metal ticks and distant clanks of the habitat
  k.every(5, 13, () => {
    const t = ctx.currentTime;
    const f = k.rand(1800, 3400);
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.value = f;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.025, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + k.rand(0.3, 0.9));
    o.connect(g).connect(k.pan(k.rand(-0.8, 0.8))).connect(roomLp);
    o.start(t);
    o.stop(t + 1);
    if (Math.random() < 0.3) k.burst(t + 0.2, 0.25, 0.04, 80, 400, roomLp, k.rand(-0.6, 0.6), "brown");
  });

  // the helmet: your own breathing, which stays when the room goes quiet
  const helmet = k.gain(1);
  const verb = helmetVerb(ctx);
  const wet = k.gain(0.35);
  helmet.connect(master);
  helmet.connect(verb).connect(wet).connect(master);
  let breath: ReturnType<typeof createBreath> | null = null;

  // outside (after the door opens): muffled wind
  const exterior = k.filter("lowpass", 2400);
  exterior.connect(master);
  let wind: ReturnType<typeof createWind> | null = null;

  const pad = createPad(ctx, master);
  let alive = true;

  const api: AirlockAudio = {
    boot() {
      const t = ctx.currentTime;
      // suit power-up: rising sweep, then status beeps
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = "sine";
      o.frequency.setValueAtTime(180, t);
      o.frequency.exponentialRampToValueAtTime(1100, t + 0.9);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.05, t + 0.2);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 1);
      o.connect(g).connect(master);
      o.start(t);
      o.stop(t + 1.05);
      [0, 0.12, 0.24].forEach((d, i) => k.tone(880 + i * 220, t + 1.05 + d, 0.08, 0.04));
      k.burst(t + 0.2, 0.6, 0.05, 800, 5000, helmet); // helmet seal
      breath = createBreath(ctx, helmet);
      breath.set(0.05, 0);
      pad.set(prefs.music, 0);
    },
    tick() {
      const t = ctx.currentTime;
      k.tone(k.rand(1500, 1900), t, 0.05, 0.025, "square", master, k.rand(-0.3, 0.3));
      k.tone(k.rand(2100, 2500), t + 0.06, 0.04, 0.02, "square", master);
    },
    ready() {
      const t = ctx.currentTime;
      k.tone(660, t, 0.5, 0.07);
      k.tone(880, t + 0.14, 0.5, 0.06);
      k.tone(1320, t + 0.28, 0.7, 0.05);
    },
    depressurize(seconds) {
      const t = ctx.currentTime;
      // klaxon: three falling whoops
      for (let i = 0; i < 3; i++) {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = "sawtooth";
        o.frequency.setValueAtTime(620, t + i * 0.7);
        o.frequency.linearRampToValueAtTime(380, t + i * 0.7 + 0.55);
        g.gain.setValueAtTime(0.0001, t + i * 0.7);
        g.gain.exponentialRampToValueAtTime(0.05, t + i * 0.7 + 0.04);
        g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.7 + 0.6);
        o.connect(k.filter("lowpass", 2200)).connect(g).connect(roomLp);
        o.start(t + i * 0.7);
        o.stop(t + i * 0.7 + 0.65);
      }
      // the air rushing out: loud at first, then thinner, duller and quieter
      const hissG = k.gain(0.0001);
      const hissF = k.filter("lowpass", 9000);
      k.loop("white").connect(k.filter("highpass", 400)).connect(hissF).connect(hissG).connect(master);
      hissG.gain.exponentialRampToValueAtTime(0.16, t + 0.4);
      hissG.gain.exponentialRampToValueAtTime(0.0001, t + seconds);
      hissF.frequency.exponentialRampToValueAtTime(500, t + seconds);
      // As the pressure drops, the room falls silent: sound needs air.
      roomLp.frequency.exponentialRampToValueAtTime(300, t + seconds);
      room.gain.setTargetAtTime(0.0001, t + seconds * 0.3, seconds * 0.25);
      breath?.set(0.3, 0.3);
      pad.set(prefs.music, 0.6);
    },
    doorOpen() {
      const t = ctx.currentTime;
      // latches (felt through the floor), then the door motor
      [0, 0.18].forEach((d) => {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.frequency.setValueAtTime(90, t + d);
        o.frequency.exponentialRampToValueAtTime(35, t + d + 0.15);
        g.gain.setValueAtTime(0.16, t + d);
        g.gain.exponentialRampToValueAtTime(0.0001, t + d + 0.2);
        o.connect(g).connect(master);
        o.start(t + d);
        o.stop(t + d + 0.25);
      });
      const m = ctx.createOscillator();
      const mg = ctx.createGain();
      m.type = "sawtooth";
      m.frequency.setValueAtTime(70, t + 0.4);
      m.frequency.linearRampToValueAtTime(120, t + 1.2);
      m.frequency.linearRampToValueAtTime(95, t + 2.4);
      mg.gain.setValueAtTime(0.0001, t + 0.4);
      mg.gain.exponentialRampToValueAtTime(0.03, t + 0.6);
      mg.gain.exponentialRampToValueAtTime(0.0001, t + 2.5);
      m.connect(k.filter("lowpass", 400)).connect(mg).connect(master);
      m.start(t + 0.4);
      m.stop(t + 2.6);
      wind = createWind(ctx, exterior);
      wind.set(0.0001, 0);
      window.setTimeout(() => wind?.set(1, 0), 700);
      breath?.set(0.45, 0.15);
      pad.set(prefs.music, 0);
    },
    linger() {
      lingering = api;
      window.setTimeout(() => lingering === api && endLinger(), 25000);
    },
    dispose() {
      if (!alive) return;
      alive = false;
      master.gain.setTargetAtTime(0, ctx.currentTime, 0.5);
      window.setTimeout(() => {
        wind?.stop();
        breath?.stop();
        pad.stop();
        k.stop();
        master.disconnect();
      }, 2500);
    },
  };
  return api;
}

export const soundPrefs = prefs;
