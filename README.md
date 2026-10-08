# Beat Clash

A Guitar Hero–style rhythm game that runs in the browser and charts **any song you give it**. Drop in an audio file, and Beat Clash analyses it, generates a five-lane note chart on the fly, and plays it on a 3D highway inside a low-poly concert venue.

No backend, no accounts, no pre-made charts: everything happens client-side.

## Playing

```sh
npm install
npm run dev      # http://localhost:5173
```

1. **Career** opens a file picker. Or drop/paste an audio file anywhere on the menu (mp3, wav, ogg, m4a… anything the browser can decode). No local music? Paste a YouTube link into the field under the menu. This needs [`yt-dlp`](https://github.com/yt-dlp/yt-dlp) on your PATH (`brew install yt-dlp`) and only works under `npm run dev` / `vite preview`, where the dev server downloads the audio for you.
2. Notes scroll toward the strike line. Hit them as they cross it.
3. Get to the end of the song without your rock meter running out.

| Key | Action |
| --- | --- |
| `A` `S` `D` `F` `G` (or `1`–`5`) | Green, red, yellow, blue, orange frets |
| `Space` | Activate star power (meter at least half full) |
| `Esc` | Pause / resume |
| `↑` `↓` | Move through the main menu |

### Rules

- **Hit window:** ±70 ms. A tap is 50 points × multiplier. Holding a sustain adds points for as long as you hold it.
- **Multiplier:** +1 for every 10-note streak, up to ×4. Star power doubles it (up to ×8).
- **Rock meter:** starts half full. Hits raise it; misses and overhits (pressing a fret with no note there) lower it. If it empties you fail, unless **No fail** is on.
- **Star power:** about every 25 seconds a six-note phrase glows cyan. Hit every note in it to add a quarter to the star meter. Once the meter is at least half full, press `Space` to spend it. A full meter lasts 16 seconds.
- **Results:** stars come from score relative to note count (0–5), plus notes hit, accuracy and best streak.

### Options

| Setting | Effect |
| --- | --- |
| Difficulty | Easy uses 3 lanes, quarter notes; Medium 4 lanes, eighths; Hard 5 lanes, eighths and some chords; Expert 5 lanes, sixteenths and more chords |
| Note speed | How fast the highway scrolls (6–18) |
| Audio offset | Shifts note timing ±200 ms to fix audio latency on your setup |
| No fail | The rock meter can't end the song |

Settings are saved in `localStorage`. The game still works if storage is blocked.

## Architecture

Plain TypeScript and Vite, with [three.js](https://threejs.org) as the only runtime dependency. There's no UI framework: the screens are static HTML that the game shows and hides.

```
index.html        screens (menu, loading, pause, results) + HUD markup
src/
  main.ts         game loop, input, scoring, audio playback, screen flow
  chart.ts        audio → note chart (pure functions, self-tested)
  scene.ts        three.js highway, notes, effects and concert props
  style.css       all styling (menu poster, panels, HUD, overlays)
public/
  menu/           menu art: background, layered logo, button SVGs (from Figma)
  models/         low-poly concert props (.glb)
  fonts/          Nightmare Hero display font
```

### Data flow

```
audio file ──decodeAudioData──▶ AudioBuffer ──toMono──▶ Float32Array
                                                          │
                                         generateChart(samples, rate, difficulty)
                                                          │
                                                          ▼
                                        Note[] { t, lane, len, sp, strength }
                                                          │
          ┌───────────────────────── main.ts frame loop ──┴─────────────────────────┐
          │ songTime() from AudioContext clock − output latency − user offset       │
          │ keydown → judge nearest note in ±70 ms → score / streak / rock / SP     │
          │ notes past the window → miss; sustains score while held                 │
          └──────────────────────────────┬──────────────────────────────────────────┘
                                         ▼
                      Stage.render(songTime, notes, cursor, speed, held, spActive)
```

### `chart.ts`: charting a song

This is the core of the game. It's a pure, DOM-free module that turns raw samples into notes. It roughly follows Flux Mapper's onset-detection approach:

1. **Spectral flux.** A short-time FFT (1024-sample Hann window, 512 hop; the FFT is a hand-written radix-2) feeds 48 log-spaced bands from 60 Hz to 16 kHz. Each frame records the positive change in log magnitude (onset strength), low-band flux (kick drum, used for tempo), energy and spectral brightness.
2. **Peak picking.** The flux is normalised against a moving mean and its 97th percentile. Local maxima above a threshold set by difficulty become onsets.
3. **Tempo and grid.** Autocorrelating the beat envelope finds a BPM between 60 and 200 (biased toward 125, folded into 85–175). A fine search then refines BPM (±3 %, 0.1 steps) and beat phase. Onsets snap to a grid of 1, 2 or 4 slots per beat depending on difficulty.
4. **Lanes.** Onsets are ranked by brightness, darkest to green and brightest to orange, so every lane gets used. Runs of four or more in the same lane are broken up.
5. **Chords.** The strongest onsets get a second note in the neighbouring lane (Hard and Expert).
6. **Sustains.** A note holds while energy stays above 60 % of its attack, if that lasts longer than 0.4 s and ends before the next note.
7. **Star power.** Every ~25 s, the next six note times form a phrase.

Known limits: it assumes a constant tempo, so songs that change tempo drift off the grid, and lanes follow timbre rather than pitch.

`npm run check` runs the built-in self-test: synthetic tone bursts on a 120 BPM grid must come back at 120 BPM, with every onset within 15 ms and all five lanes used.

### `main.ts`: game loop and state

- **Clock:** song time comes from `AudioContext.currentTime`, not frame time, so notes stay locked to the audio. It's corrected by `outputLatency` and the user offset, and a 3-second lead-in shows a countdown.
- **Judging:** a `cursor` index tracks the first note that may still need judging, so each frame only looks at a small slice of the chart.
- **Pausing:** the `AudioContext` is suspended, which freezes the clock too. Switching tabs pauses automatically.
- **Menu sounds:** short square-wave blips generated with Web Audio, so there are no sound files.
- **Screens:** `show(name)` toggles the `hidden` attribute on the `<section>` screens and the HUD.

### `scene.ts`: rendering

A single `Stage` class owns the three.js renderer, scene and camera.

- **Highway:** a plane with a procedurally drawn wood texture that scrolls with song time. It has rails, strings, fret bars every half second, and fog at the far end.
- **Notes:** a fixed pool of 220 note objects is reused every frame, with no allocation during play. Each is a flat-shaded hexagonal body and cap, plus a stretched box for sustains. Star power notes are cyan.
- **Strike line:** hexagonal rings and pads per lane. They light up when held, flash when hit (an additive flame sprite plus spark particles) and flash red on a miss.
- **Venue:** a truss stage at the end of the highway, speaker stacks with moving-head lights, mic stands and barricades, loaded with `GLTFLoader` and scaled to fit. Spotlight cones and pink and cyan wash lights pulse on strong onsets.

### UI

The main menu is built from a Figma design. A 1440×1024 frame scales to fit the window over a full-screen poster background, and the layered logo and button art are SVGs. The Options and Tutorial panels, the pause screen and the results screen share the same look: heavy white uppercase type with a thick black outline on black cards.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Vite dev server |
| `npm run build` | Type-check and production build to `dist/` |
| `npm run check` | Run the chart generator's self-test |

## Credits

- Concert props: [Concert Pack](https://poly.pizza/bundle/Concert-Pack-ag2DBgUKV5) by iPoly3D, CC0.
- Display font: Nightmare Hero.
- Charting approach adapted from Flux Mapper's description of its onset and tempo pipeline.
