import { defineConfig, type Connect } from 'vite'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// GET /yt?url=<youtube link> → audio bytes. Browsers can't fetch YouTube audio
// themselves (CORS), so the dev server shells out to yt-dlp, which must be on PATH.
// ponytail: dev/preview only; a static deploy has no /yt and the menu shows the error.
const youtube: Connect.NextHandleFunction = async (req, res, next) => {
  if (!req.url?.startsWith('/yt?')) return next()
  const fail = (code: number, msg: string) => { res.statusCode = code; res.end(msg) }
  let link: URL
  try { link = new URL(new URLSearchParams(req.url.slice(4)).get('url') ?? '') } catch { return fail(400, 'Not a valid link') }
  if (!/^https?:$/.test(link.protocol) || !/(^|\.)(youtube\.com|youtu\.be)$/.test(link.hostname)) return fail(400, 'Not a YouTube link')

  const dir = await mkdtemp(join(tmpdir(), 'beatclash-'))
  try {
    // m4a first: every browser's decodeAudioData reads it, and it needs no ffmpeg
    const out = await new Promise<string>((ok, err) => execFile('yt-dlp', [
      '-f', 'bestaudio[ext=m4a]/bestaudio', '--no-playlist', '--no-simulate',
      '-O', 'title', '-O', 'after_move:filepath', '-o', join(dir, '%(id)s.%(ext)s'), '--', link.href,
    ], { maxBuffer: 1 << 20 }, (e, stdout, stderr) => e ? err(Object.assign(e, { stderr })) : ok(stdout)))
    const [title, file] = out.trim().split('\n')
    res.setHeader('X-Title', encodeURIComponent(title))
    res.end(await readFile(file))
  } catch (e: any) {
    console.error(e.stderr || e)
    fail(e.code === 'ENOENT' ? 501 : 502, e.code === 'ENOENT' ? 'yt-dlp is not installed on the server' : 'Could not download that video')
  } finally {
    rm(dir, { recursive: true, force: true })
  }
}

export default defineConfig({
  plugins: [{
    name: 'youtube-audio',
    configureServer: s => { s.middlewares.use(youtube) },
    configurePreviewServer: s => { s.middlewares.use(youtube) },
  }],
})
