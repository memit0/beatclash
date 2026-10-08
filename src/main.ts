import { generateChart, toMono, type Difficulty, type Note } from './chart'
import { Stage } from './scene'

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T
const WINDOW = 0.07 // ±70ms hit window
const LEAD_IN = 3
const KEYS: Record<string, number> = { KeyA: 0, KeyS: 1, KeyD: 2, KeyF: 3, KeyG: 4, Digit1: 0, Digit2: 1, Digit3: 2, Digit4: 3, Digit5: 4 }

const stage = new Stage($<HTMLCanvasElement>('stage'))
const ctx = new AudioContext()

// retro menu blips, synthesized so there are no sound files to ship
function blip(freq: number, dur = 0.05, slide = 1) {
  if (running) return
  ctx.resume()
  const t = ctx.currentTime
  const o = ctx.createOscillator()
  const g = ctx.createGain()
  o.type = 'square'
  o.frequency.setValueAtTime(freq, t)
  o.frequency.exponentialRampToValueAtTime(freq * slide, t + dur)
  g.gain.setValueAtTime(0.06, t)
  g.gain.exponentialRampToValueAtTime(0.001, t + dur)
  o.connect(g).connect(ctx.destination)
  o.start(t)
  o.stop(t + dur)
}
const moveSound = () => blip(880)
const selectSound = () => blip(440, 0.14, 2)

// ---- settings (per-viewer convenience; game works without storage) ----
const difficulty = $<HTMLSelectElement>('difficulty')
const speed = $<HTMLInputElement>('speed')
const offset = $<HTMLInputElement>('offset')
const nofail = $<HTMLInputElement>('nofail')
try {
  const saved = JSON.parse(localStorage.getItem('fretfall') ?? '{}')
  if (saved.difficulty) difficulty.value = saved.difficulty
  if (saved.speed) speed.value = saved.speed
  if (saved.offset !== undefined) offset.value = saved.offset
  nofail.checked = !!saved.nofail
} catch {}
const syncSettings = () => {
  $('speedOut').textContent = speed.value
  $('offsetOut').textContent = `${offset.value} ms`
  try {
    localStorage.setItem('fretfall', JSON.stringify({ difficulty: difficulty.value, speed: speed.value, offset: offset.value, nofail: nofail.checked }))
  } catch {}
}
for (const el of [difficulty, speed, offset, nofail]) el.addEventListener('input', () => { syncSettings(); moveSound() })
syncSettings()

// ---- screens ----
const screens = ['menu', 'loading', 'paused', 'results'] as const
function show(name: (typeof screens)[number] | null) {
  for (const s of screens) $(s).hidden = s !== name
  $('hud').hidden = name === 'menu' || name === 'loading'
  if (name === 'menu') $('play').focus()
}

// ---- audio input ----
let buffer: AudioBuffer | null = null
let mono: Float32Array | null = null

async function loadFile(file: File | undefined) {
  if (file) loadSong(file.name, () => file.arrayBuffer(), `Couldn't read “${file.name}”. Try an mp3, wav, ogg or m4a file.`)
}

async function loadYouTube(url: string) {
  let err = 'Couldn’t load that YouTube link.'
  loadSong('Fetching from YouTube…', async () => {
    const res = await fetch(`/yt?url=${encodeURIComponent(url)}`)
    if (!res.ok) throw new Error(err = await res.text() || err)
    $('songName').textContent = decodeURIComponent(res.headers.get('X-Title') ?? '') || url
    return res.arrayBuffer()
  }, () => err)
}

async function loadSong(name: string, bytes: () => Promise<ArrayBuffer>, error: string | (() => string)) {
  $('error').textContent = ''
  $('songName').textContent = name
  show('loading')
  try {
    await ctx.resume()
    buffer = await ctx.decodeAudioData(await bytes())
    mono = toMono(buffer)
    await startGame()
  } catch (e) {
    console.error(e)
    $('error').textContent = typeof error === 'string' ? error : error()
    show('menu')
  }
}

const menu = $('menu')
$<HTMLInputElement>('file').addEventListener('change', e => loadFile((e.target as HTMLInputElement).files?.[0]))
$('play').onclick = () => { selectSound(); $('file').click() }
$<HTMLFormElement>('ytForm').onsubmit = e => {
  e.preventDefault()
  selectSound()
  loadYouTube($<HTMLInputElement>('yt').value.trim())
}
for (const [btn, panel] of [['optionsBtn', 'settings'], ['howBtn', 'keys']]) {
  $(btn).onclick = () => {
    selectSound()
    $(panel).hidden = !$(panel).hidden
    $(btn).setAttribute('aria-expanded', String(!$(panel).hidden))
  }
}
// arrow keys move between menu items, like a console menu
menu.addEventListener('keydown', e => {
  const items = [...menu.querySelectorAll<HTMLButtonElement>('.menu-list button')]
  const i = items.indexOf(document.activeElement as HTMLButtonElement)
  if (i < 0 || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return
  e.preventDefault()
  items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus()
  moveSound()
})
// hovering selects an item too, so mouse and keyboard share one highlight
for (const b of menu.querySelectorAll<HTMLButtonElement>('.menu-list button')) {
  b.addEventListener('mouseenter', () => { if (document.activeElement !== b) { b.focus(); moveSound() } })
}
addEventListener('dragover', e => { e.preventDefault(); menu.classList.add('over') })
addEventListener('dragleave', () => menu.classList.remove('over'))
addEventListener('drop', e => {
  e.preventDefault()
  menu.classList.remove('over')
  if (!menu.hidden) loadFile(e.dataTransfer?.files[0])
})
addEventListener('paste', e => {
  if (!menu.hidden) loadFile([...(e.clipboardData?.files ?? [])].find(f => f.type.startsWith('audio') || f.type.startsWith('video')) ?? e.clipboardData?.files[0])
})

// ---- game state ----
let notes: Note[] = []
let source: AudioBufferSourceNode | null = null
let startAt = 0
let running = false
let cursor = 0 // first note that may still need judging
let score = 0, streak = 0, bestStreak = 0, hits = 0
let rock = 0.5, spMeter = 0, spActive = false
const failedPhrases = new Set<number>()
const phraseEnd = new Map<number, number>() // phrase id → index of its last note
const held = [false, false, false, false, false]

const songTime = () => ctx.currentTime - startAt - (ctx.outputLatency || 0) - Number(offset.value) / 1000
const multiplier = () => Math.min(4, 1 + Math.floor(streak / 10)) * (spActive ? 2 : 1)

async function startGame() {
  show('loading')
  await new Promise(r => setTimeout(r, 30)) // let "Charting…" paint before the heavy work
  notes = generateChart(mono!, buffer!.sampleRate, difficulty.value as Difficulty)
  phraseEnd.clear()
  notes.forEach((n, i) => { if (n.sp) phraseEnd.set(n.sp, i) })
  score = streak = bestStreak = hits = cursor = 0
  rock = 0.5; spMeter = 0; spActive = false
  failedPhrases.clear()
  await ctx.resume()
  source?.stop()
  source = ctx.createBufferSource()
  source.buffer = buffer
  source.connect(ctx.destination)
  startAt = ctx.currentTime + LEAD_IN
  source.start(startAt)
  running = true
  show(null)
}

function stopAudio() {
  running = false
  source?.stop()
  source = null
}

function finish(failed: boolean) {
  stopAudio()
  const total = notes.length
  const ratio = score / Math.max(1, total * 50)
  const stars = failed ? 0 : [0.5, 1.2, 1.9, 2.5, 3.0].filter(t => ratio >= t).length
  $('resultTitle').textContent = failed ? 'Song failed' : 'Song complete'
  $('stars').textContent = '★'.repeat(stars) + '☆'.repeat(5 - stars)
  $('stars').setAttribute('aria-label', `${stars} of 5 stars`)
  $('rScore').textContent = score.toLocaleString()
  $('rHit').textContent = `${hits} / ${total}`
  $('rAcc').textContent = `${total ? Math.round((hits / total) * 100) : 0}%`
  $('rStreak').textContent = String(bestStreak)
  show('results')
}

function onHit(n: Note) {
  n.hit = true
  hits++
  streak++
  bestStreak = Math.max(bestStreak, streak)
  score += 50 * multiplier()
  rock = Math.min(1, rock + (spActive ? 0.04 : 0.02))
  if (n.len > 0) n.holding = true
  stage.hit(n.lane, n.sp > 0)
  if (n.sp && !failedPhrases.has(n.sp) && phraseEnd.get(n.sp) === notes.indexOf(n)) spMeter = Math.min(1, spMeter + 0.25)
}

function breakStreak(lane: number, penalty: number) {
  streak = 0
  rock -= penalty
  stage.miss(lane)
}

addEventListener('keydown', e => {
  if (e.code === 'Escape' && (running || !$('paused').hidden)) return togglePause()
  if (!running || ctx.state !== 'running' || e.repeat) return
  if (e.code === 'Space') {
    e.preventDefault()
    if (!spActive && spMeter >= 0.5) spActive = true
    return
  }
  const lane = KEYS[e.code]
  if (lane === undefined) return
  held[lane] = true
  const t = songTime()
  let best: Note | null = null
  for (let i = cursor; i < notes.length && notes[i].t <= t + WINDOW; i++) {
    const n = notes[i]
    if (n.lane === lane && !n.hit && !n.missed && Math.abs(n.t - t) <= WINDOW && (!best || Math.abs(n.t - t) < Math.abs(best.t - t))) best = n
  }
  if (best) onHit(best)
  else if (t > 0) breakStreak(lane, 0.02) // overhit (free during countdown)
})
addEventListener('keyup', e => {
  const lane = KEYS[e.code]
  if (lane === undefined) return
  held[lane] = false
  for (let i = cursor; i < notes.length && notes[i].t <= songTime(); i++) if (notes[i].lane === lane) notes[i].holding = false
})

// ---- pause ----
function togglePause() {
  if (!$('paused').hidden) {
    show(null)
    ctx.resume()
  } else {
    ctx.suspend()
    show('paused')
  }
}
$('resume').onclick = togglePause
$('restart').onclick = () => startGame()
$('quit').onclick = () => { stopAudio(); show('menu') }
$('again').onclick = () => startGame()
$('newSong').onclick = () => { $<HTMLInputElement>('file').value = ''; show('menu') }
document.addEventListener('visibilitychange', () => { if (document.hidden && running && $('paused').hidden) togglePause() })

// ---- loop ----
let last = performance.now()
function frame(now: number) {
  requestAnimationFrame(frame)
  const dt = Math.min(0.05, (now - last) / 1000)
  last = now
  const t = running ? songTime() : -LEAD_IN

  if (running && ctx.state === 'running') {
    // misses, beat pulses, sustains
    for (let i = cursor; i < notes.length && notes[i].t < t; i++) {
      const n = notes[i]
      if (!n.hit && !n.missed && n.t < t - WINDOW) {
        n.missed = true
        if (n.sp) failedPhrases.add(n.sp)
        breakStreak(n.lane, 0.06)
      }
      if (n.holding) {
        if (t >= n.t + n.len) n.holding = false
        else score += Math.round(60 * dt * multiplier())
      }
    }
    while (cursor < notes.length && (notes[cursor].hit || notes[cursor].missed) && !notes[cursor].holding && notes[cursor].t < t - WINDOW) {
      if (notes[cursor].strength > 0.5) stage.beat(notes[cursor].strength)
      cursor++
    }
    if (spActive) {
      spMeter -= dt / 16 // full meter lasts 16s
      if (spMeter <= 0) { spMeter = 0; spActive = false }
    }
    if (rock <= 0 && !nofail.checked) finish(true)
    else if (t > buffer!.duration + 1) finish(false)
    rock = Math.max(0, rock)
  }

  // HUD
  if (!$('hud').hidden) {
    $('score').textContent = score.toLocaleString()
    $('streak').textContent = streak >= 10 ? `${streak} note streak` : ''
    const m = multiplier()
    const mult = $('mult')
    mult.textContent = `×${m}`
    mult.className = `mult x${Math.min(4, m)}${spActive ? ' sp' : ''}`
    $('rock').style.width = `${rock * 100}%`
    $('sp').style.width = `${spMeter * 100}%`
    $('sp').parentElement!.parentElement!.classList.toggle('ready', spMeter >= 0.5 && !spActive)
    $('progress').style.width = `${buffer ? Math.max(0, Math.min(1, t / buffer.duration)) * 100 : 0}%`
    $('countdown').textContent = t < 0 && t > -LEAD_IN ? String(Math.ceil(-t)) : ''
  }

  stage.render(t, notes, cursor, Number(speed.value), held, spActive)
}
requestAnimationFrame(frame)
show('menu')
// dev-only hook for the browser test bot
if (import.meta.env.DEV) Object.assign(window, { beatclash: { notes: () => notes, songTime } })
