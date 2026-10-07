// Audio → note chart. Pure functions; self-check at the bottom (`npm run check`).
// Steps 1–3 follow Flux Mapper's "How it works, exactly": log-band spectral flux,
// normalized peak picking, then tempo detection and snapping onsets to a beat grid.
// Lanes, sustains, chords and star power are Fretfall's own rules.
// ponytail: assumes one constant tempo (tempo changes drift off the grid), and onsets
// are not pitches. Upgrade path is beat tracking with tempo curves / an ML onset model.

export type Difficulty = 'easy' | 'medium' | 'hard' | 'expert'

export interface Note {
  t: number // seconds
  lane: number // 0..4 (green..orange)
  len: number // sustain seconds, 0 = tap
  sp: number // star power phrase id, 0 = none
  strength: number // onset strength 0..1, drives stage light pulses
  // runtime state, mutated by the game
  hit?: boolean
  missed?: boolean
  holding?: boolean
}

const WIN = 1024
const HOP = 512
const BANDS = 48
const LOW_BANDS = 12 // ~60–270 Hz, carries the kick for tempo

// division = grid slots per beat; sensitivity sets the onset threshold. Tuning knobs.
// ponytail: expert caps at Flux Mapper's default 0.55; above ~0.6 decay ripples one 16th after a hit pass as notes.
const SETTINGS: Record<Difficulty, { lanes: number; division: number; sensitivity: number; chords: number }> = {
  easy: { lanes: 3, division: 1, sensitivity: 0.35, chords: 0 },
  medium: { lanes: 4, division: 2, sensitivity: 0.45, chords: 0 },
  hard: { lanes: 5, division: 2, sensitivity: 0.5, chords: 0.08 },
  expert: { lanes: 5, division: 4, sensitivity: 0.55, chords: 0.15 },
}

// In-place iterative radix-2 FFT.
function fft(re: Float64Array, im: Float64Array) {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      ;[re[i], re[j]] = [re[j], re[i]]
      ;[im[i], im[j]] = [im[j], im[i]]
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const ang = (-2 * Math.PI) / size
    const wr = Math.cos(ang), wi = Math.sin(ang)
    for (let start = 0; start < n; start += size) {
      let cr = 1, ci = 0
      for (let k = 0; k < size / 2; k++) {
        const a = start + k, b = a + size / 2
        const tr = re[b] * cr - im[b] * ci
        const ti = re[b] * ci + im[b] * cr
        re[b] = re[a] - tr; im[b] = im[a] - ti
        re[a] += tr; im[a] += ti
        const ncr = cr * wr - ci * wi
        ci = cr * wi + ci * wr
        cr = ncr
      }
    }
  }
}

export function toMono(buf: { numberOfChannels: number; length: number; getChannelData(c: number): Float32Array }) {
  const out = new Float32Array(buf.length)
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c)
    for (let i = 0; i < out.length; i++) out[i] += d[i] / buf.numberOfChannels
  }
  return out
}

// Subtract the ±W-frame moving mean (clamped at 0), divide by the 97th percentile, cap at 2.
function normalize(x: Float64Array, W: number) {
  const n = x.length
  const prefix = new Float64Array(n + 1)
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + x[i]
  const out = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - W), b = Math.min(n, i + W + 1)
    out[i] = Math.max(0, x[i] - (prefix[b] - prefix[a]) / (b - a))
  }
  const p97 = Math.max(1e-9, out.slice().sort()[Math.min(n - 1, Math.floor(n * 0.97))] ?? 0)
  for (let i = 0; i < n; i++) out[i] = Math.min(2, out[i] / p97)
  return out
}

function analyse(samples: Float32Array, sampleRate: number, difficulty: Difficulty): { notes: Note[]; bpm: number } {
  const cfg = SETTINGS[difficulty]
  const frames = Math.max(0, Math.floor((samples.length - WIN) / HOP))
  const fps = sampleRate / HOP
  const frameTime = (f: number) => (f * HOP + WIN / 2) / sampleRate // frame center
  const hann = new Float64Array(WIN).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / WIN))
  const re = new Float64Array(WIN), im = new Float64Array(WIN)

  // 48 log-spaced bands, 60 Hz – 16 kHz, at least one bin each
  const lo = new Int32Array(BANDS), hi = new Int32Array(BANDS), center = new Float64Array(BANDS)
  for (let b = 0; b < BANDS; b++) {
    const f0 = 60 * (16000 / 60) ** (b / BANDS), f1 = 60 * (16000 / 60) ** ((b + 1) / BANDS)
    lo[b] = Math.min(WIN / 2 - 1, Math.max(1, Math.floor((f0 * WIN) / sampleRate)))
    hi[b] = Math.min(WIN / 2, Math.max(lo[b] + 1, Math.floor((f1 * WIN) / sampleRate)))
    center[b] = Math.log2(Math.sqrt(f0 * f1))
  }

  const prev = new Float64Array(BANDS)
  const flux = new Float64Array(frames), lowFlux = new Float64Array(frames)
  const energy = new Float64Array(frames), brightness = new Float64Array(frames)

  // 1. STFT → band log magnitudes → flux (rises only), low-band flux, energy, brightness
  for (let f = 0; f < frames; f++) {
    const off = f * HOP
    for (let i = 0; i < WIN; i++) { re[i] = samples[off + i] * hann[i]; im[i] = 0 }
    fft(re, im)
    let fl = 0, low = 0, num = 0, den = 0
    for (let b = 0; b < BANDS; b++) {
      let s = 0
      for (let k = lo[b]; k < hi[b]; k++) s += Math.log1p(20 * Math.hypot(re[k], im[k]))
      const m = s / (hi[b] - lo[b])
      const rise = f > 0 ? Math.max(0, m - prev[b]) : 0 // frame 0 has nothing to compare with
      fl += rise
      if (b < LOW_BANDS) low += rise
      num += center[b] * m; den += m
      prev[b] = m
    }
    flux[f] = fl
    lowFlux[f] = low
    energy[f] = den
    brightness[f] = den > 0 ? num / den : 0
  }
  const W = Math.round(0.35 * fps)
  const env = normalize(flux, W)
  const lowEnv = normalize(lowFlux, W)
  const beatEnv = env.map((v, i) => v + lowEnv[i])

  // 2. peaks: highest within ±3 frames and above 0.58 − 0.5 × sensitivity
  const thr = 0.58 - 0.5 * cfg.sensitivity
  const peaks: number[] = []
  for (let f = 0; f < frames; f++) {
    if (env[f] < thr) continue
    let isMax = true
    for (let j = Math.max(0, f - 3); j <= Math.min(frames - 1, f + 3) && isMax; j++) {
      if (j < f ? env[j] >= env[f] : env[j] > env[f]) isMax = false // plateau: earliest frame wins
    }
    if (isMax) peaks.push(f)
  }
  if (!peaks.length) return { notes: [], bpm: 0 }

  // 3a. tempo: autocorrelate the beat envelope over 60–200 BPM, prior on 125 BPM
  const ac = (L: number) => {
    let s = 0
    for (let i = 0; i + L < frames; i++) s += beatEnv[i] * beatEnv[i + L]
    return s / Math.max(1, frames - L)
  }
  let bestL = 0, bestScore = -1
  for (let L = Math.floor((60 * fps) / 200); L <= Math.ceil((60 * fps) / 60); L++) {
    const score = (ac(L) + 0.5 * ac(2 * L)) * Math.exp(-0.5 * Math.log2((60 * fps) / L / 125) ** 2)
    if (score > bestScore) { bestScore = score; bestL = L }
  }
  let bpm = (60 * fps) / bestL
  while (bpm < 85) bpm *= 2
  while (bpm > 175) bpm /= 2

  // 3b. refine: ±3 % in 0.1 BPM steps × 40 phases, scored by the envelope at predicted beats
  const duration = samples.length / sampleRate
  let first = 0, refined = bpm, bestMean = -1
  for (let k = Math.round(bpm * 9.7); k <= Math.round(bpm * 10.3); k++) {
    const period = 60 / (k / 10)
    for (let p = 0; p < 40; p++) {
      const phase = (p / 40) * period
      let sum = 0, count = 0
      for (let t = phase; t < duration; t += period) {
        const f = Math.round((t * sampleRate - WIN / 2) / HOP)
        if (f >= 0 && f < frames) { sum += beatEnv[f]; count++ }
      }
      if (count && sum / count > bestMean) { bestMean = sum / count; refined = k / 10; first = phase }
    }
  }
  bpm = refined
  const slotDur = 60 / bpm / cfg.division

  // 3c. snap to the grid; same slot keeps the stronger onset
  const slots = new Map<number, number>() // slot → peak frame
  for (const f of peaks) {
    const slot = Math.round((frameTime(f) - first) / slotDur)
    const had = slots.get(slot)
    if (had === undefined || env[f] > env[had]) slots.set(slot, f)
  }
  const kept = [...slots].sort((a, b) => a[0] - b[0])
    .map(([slot, f]) => ({ t: first + slot * slotDur, f }))
    .filter(o => o.t >= 0)

  // 4. lanes from brightness rank (dark = green), so every lane gets used
  const order = kept.map((_, i) => i).sort((a, b) => brightness[kept[a].f] - brightness[kept[b].f])
  const lanes = new Array<number>(kept.length)
  order.forEach((idx, rank) => { lanes[idx] = Math.min(cfg.lanes - 1, Math.floor((rank / kept.length) * cfg.lanes)) })
  for (let i = 3; i < lanes.length; i++) {
    if (lanes[i] === lanes[i - 1] && lanes[i] === lanes[i - 2] && lanes[i] === lanes[i - 3]) {
      lanes[i] = lanes[i] + (lanes[i] < cfg.lanes - 1 ? 1 : -1)
    }
  }

  const frameDur = 1 / fps
  const strengths = kept.map(o => env[o.f] / 2)
  const chordCut = [...strengths].sort((a, b) => b - a)[Math.floor(strengths.length * cfg.chords)] ?? Infinity
  const notes: Note[] = []
  kept.forEach(({ t, f }, i) => {
    const nextT = i + 1 < kept.length ? kept[i + 1].t : Infinity
    // 6. sustain while energy stays up, stopping short of the next note
    let j = f
    while (j + 1 < frames && energy[j + 1] >= energy[f] * 0.6 && (j + 1 - f) * frameDur < nextT - t - 0.15) j++
    const dur = (j - f) * frameDur
    const len = dur > 0.4 ? dur : 0
    const strength = strengths[i]
    notes.push({ t, lane: lanes[i], len, sp: 0, strength })
    // 5. chords on the strongest onsets
    if (cfg.chords > 0 && strength > chordCut) {
      const l2 = lanes[i] < cfg.lanes - 1 ? lanes[i] + 1 : lanes[i] - 1
      notes.push({ t, lane: l2, len, sp: 0, strength })
    }
  })

  // 7. star power: every ~25s, the next 6 note times form a phrase
  let phrase = 0
  for (let next = 10, i = 0; i < notes.length; ) {
    if (notes[i].t < next) { i++; continue }
    phrase++
    let times = 0
    for (; i < notes.length && times < 6; i++) {
      if (i === 0 || notes[i].t !== notes[i - 1].t) times++
      if (times <= 6) notes[i].sp = phrase
    }
    while (i < notes.length && notes[i].t === notes[i - 1].t) notes[i++].sp = phrase
    next = notes[i - 1].t + 25
  }
  return { notes, bpm }
}

export function generateChart(samples: Float32Array, sampleRate: number, difficulty: Difficulty): Note[] {
  return analyse(samples, sampleRate, difficulty).notes
}

// Self-check: tone bursts on a 120 BPM eighth-note grid must give 120 BPM and land on their slots.
if (typeof process !== 'undefined' && process.argv?.[1]?.endsWith('chart.ts')) {
  const sr = 44100
  const s = new Float32Array(sr * 40)
  let seed = 1
  const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 2 - 1
  for (let i = 0; i < s.length; i++) s[i] = rand() * 0.005
  const times: number[] = []
  for (let k = 0, t = 0.5; t < 39; k++, t = 0.5 + k * 0.25) {
    if (k % 8 === 3 || k % 8 === 6) continue // skip some eighths so it's not a metronome
    times.push(t)
    const freq = 150 * 2 ** (times.length % 5) // spread pitches → spread lanes
    for (let i = 0; i < sr * 0.08; i++) {
      s[Math.floor(t * sr) + i] += Math.sin((2 * Math.PI * freq * i) / sr) * 0.8 * Math.exp(-i / (sr * 0.02))
    }
  }
  const { notes, bpm } = analyse(s, sr, 'expert')
  if (Math.abs(bpm - 120) > 1) throw new Error(`expected 120 BPM, got ${bpm}`)
  const found = [...new Set(notes.map(n => n.t))]
  const err = (t: number) => Math.min(...found.map(f => Math.abs(f - t)))
  for (const t of times) if (err(t) > 0.015) throw new Error(`no note near ${t.toFixed(3)}s (off by ${err(t).toFixed(3)}s)`)
  if (found.length !== times.length) throw new Error(`expected ${times.length} onsets, got ${found.length}`)
  if (notes.some(n => n.lane < 0 || n.lane > 4)) throw new Error('lane out of range')
  if (new Set(notes.map(n => n.lane)).size !== 5) throw new Error('not all lanes used')
  if (!notes.some(n => n.sp > 0)) throw new Error('no star power phrases')
  const easy = generateChart(s, sr, 'easy')
  if (easy.some(n => n.lane > 2)) throw new Error('easy uses >3 lanes')
  console.log(`ok: ${bpm} BPM, ${times.length} onsets, ${notes.length} notes, max err ${Math.max(...times.map(err)).toFixed(4)}s`)
}
