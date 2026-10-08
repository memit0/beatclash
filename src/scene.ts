import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import type { Note } from './chart'

export const LANE_COLORS = [0x22c55e, 0xef4444, 0xfacc15, 0x3b82f6, 0xf97316]
const SP_COLOR = 0x9be7ff
const LANE_W = 1
const HW = 2.75 // highway half-width
const LEN = 60 // highway length
const POOL = 220

const laneX = (l: number) => (l - 2) * LANE_W

function woodTexture() {
  const c = document.createElement('canvas')
  c.width = 256; c.height = 1024
  const g = c.getContext('2d')!
  g.fillStyle = '#2a170c'
  g.fillRect(0, 0, c.width, c.height)
  for (let i = 0; i < 140; i++) {
    const x = Math.random() * c.width
    const shade = 20 + Math.random() * 40
    g.strokeStyle = `rgba(${shade + 40},${shade + 15},${shade / 2},${0.15 + Math.random() * 0.25})`
    g.lineWidth = 0.5 + Math.random() * 2
    g.beginPath()
    for (let y = 0; y <= c.height; y += 16) g.lineTo(x + Math.sin(y / 90 + i) * 4, y)
    g.stroke()
  }
  const tex = new THREE.CanvasTexture(c)
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping
  tex.repeat.set(1, 4)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

function glowTexture() {
  const c = document.createElement('canvas')
  c.width = c.height = 64
  const g = c.getContext('2d')!
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32)
  grad.addColorStop(0, 'rgba(255,255,255,1)')
  grad.addColorStop(0.3, 'rgba(255,255,255,0.6)')
  grad.addColorStop(1, 'rgba(255,255,255,0)')
  g.fillStyle = grad
  g.fillRect(0, 0, 64, 64)
  return new THREE.CanvasTexture(c)
}

interface Gem { group: THREE.Group; body: THREE.Mesh; tail: THREE.Mesh }
interface Spark { life: number; vx: number; vy: number; vz: number; c: THREE.Color }

export class Stage {
  private renderer: THREE.WebGLRenderer
  private scene = new THREE.Scene()
  private camera = new THREE.PerspectiveCamera(55, 1, 0.1, 200)
  private wood = woodTexture()
  private highwayMat: THREE.MeshLambertMaterial
  private frets: THREE.Mesh[] = []
  private rings: THREE.Mesh[] = []
  private pads: THREE.Mesh[] = []
  private flames: THREE.Sprite[] = []
  private flash = [0, 0, 0, 0, 0]
  private missFlash = [0, 0, 0, 0, 0]
  private gems: Gem[] = []
  private laneMats = LANE_COLORS.map(c => new THREE.MeshLambertMaterial({ color: c, emissive: c, emissiveIntensity: 0.35, flatShading: true }))
  private tailMats = LANE_COLORS.map(c => new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: 0.8 }))
  private spMat = new THREE.MeshLambertMaterial({ color: SP_COLOR, emissive: SP_COLOR, emissiveIntensity: 0.6, flatShading: true })
  private spTailMat = new THREE.MeshBasicMaterial({ color: SP_COLOR, transparent: true, opacity: 0.8 })
  private sparks: THREE.Points
  private sparkData: Spark[] = []
  private sparkCursor = 0
  private beams: THREE.Mesh[] = []
  private washes: THREE.PointLight[] = []
  private pulse = 0
  private clock = performance.now()

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
    this.scene.background = new THREE.Color(0x07040c)
    this.scene.fog = new THREE.Fog(0x07040c, 28, 58)
    this.camera.position.set(0, 3.4, 4.6)
    this.camera.lookAt(0, 0, -10)

    this.scene.add(new THREE.AmbientLight(0xffffff, 1.2))
    const key = new THREE.DirectionalLight(0xffffff, 1.6)
    key.position.set(0, 6, 4)
    this.scene.add(key)

    // highway
    this.highwayMat = new THREE.MeshLambertMaterial({ map: this.wood, emissive: 0x000000 })
    const hw = new THREE.Mesh(new THREE.PlaneGeometry(HW * 2, LEN), this.highwayMat)
    hw.rotation.x = -Math.PI / 2
    hw.position.z = -LEN / 2 + 2
    this.scene.add(hw)

    const railMat = new THREE.MeshLambertMaterial({ color: 0xd9d4c7 })
    for (const x of [-HW, HW]) {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.08, LEN), railMat)
      rail.position.set(x, 0.04, -LEN / 2 + 2)
      this.scene.add(rail)
    }
    const stringMat = new THREE.MeshBasicMaterial({ color: 0x8c857a })
    for (let l = 0; l < 5; l++) {
      const s = new THREE.Mesh(new THREE.BoxGeometry(0.025, 0.02, LEN), stringMat)
      s.position.set(laneX(l), 0.02, -LEN / 2 + 2)
      this.scene.add(s)
    }
    const fretMat = new THREE.MeshLambertMaterial({ color: 0xb8b2a6 })
    for (let i = 0; i < 40; i++) {
      const f = new THREE.Mesh(new THREE.BoxGeometry(HW * 2, 0.03, 0.06), fretMat)
      this.frets.push(f)
      this.scene.add(f)
    }
    const strike = new THREE.Mesh(new THREE.BoxGeometry(HW * 2, 0.05, 0.1), new THREE.MeshBasicMaterial({ color: 0xffffff }))
    strike.position.set(0, 0.03, 0)
    this.scene.add(strike)

    // strike rings + pads + flames
    const glow = glowTexture()
    LANE_COLORS.forEach((c, l) => {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.36, 0.07, 3, 6), new THREE.MeshLambertMaterial({ color: c, emissive: c, emissiveIntensity: 0.2, flatShading: true }))
      ring.rotation.x = -Math.PI / 2
      ring.position.set(laneX(l), 0.08, 0)
      this.rings.push(ring)
      this.scene.add(ring)
      const pad = new THREE.Mesh(new THREE.CircleGeometry(0.3, 6), new THREE.MeshBasicMaterial({ color: 0x111111 }))
      pad.rotation.x = -Math.PI / 2
      pad.position.set(laneX(l), 0.07, 0)
      this.pads.push(pad)
      this.scene.add(pad)
      const flame = new THREE.Sprite(new THREE.SpriteMaterial({ map: glow, color: c, blending: THREE.AdditiveBlending, transparent: true, opacity: 0, depthWrite: false }))
      flame.position.set(laneX(l), 0.6, 0)
      this.flames.push(flame)
      this.scene.add(flame)
    })

    // gem pool
    // low-poly look: hexagonal notes, rings and pads with flat-shaded facets
    const bodyGeo = new THREE.CylinderGeometry(0.32, 0.36, 0.16, 6)
    const capGeo = new THREE.CylinderGeometry(0.2, 0.2, 0.17, 6)
    const capMat = new THREE.MeshLambertMaterial({ color: 0xffffff, emissive: 0x666666, flatShading: true })
    const tailGeo = new THREE.BoxGeometry(0.14, 0.03, 1)
    tailGeo.translate(0, 0, -0.5) // extends away from the player
    for (let i = 0; i < POOL; i++) {
      const group = new THREE.Group()
      const body = new THREE.Mesh(bodyGeo, this.laneMats[0])
      const cap = new THREE.Mesh(capGeo, capMat)
      group.add(body, cap)
      const tail = new THREE.Mesh(tailGeo, this.tailMats[0])
      group.visible = tail.visible = false
      this.gems.push({ group, body, tail })
      this.scene.add(group, tail)
    }

    // sparks
    const n = 400
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3))
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3), 3))
    this.sparks = new THREE.Points(geo, new THREE.PointsMaterial({ size: 0.12, map: glow, vertexColors: true, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false }))
    for (let i = 0; i < n; i++) this.sparkData.push({ life: 0, vx: 0, vy: 0, vz: 0, c: new THREE.Color() })
    this.scene.add(this.sparks)

    // stage spotlight beams behind the highway
    const beamGeo = new THREE.ConeGeometry(4, 40, 6, 1, true)
    beamGeo.translate(0, -20, 0) // apex at origin
    ;[0xff3d7f, 0x6c5cff, 0xffb347, 0x3dd6ff].forEach((c, i) => {
      const beam = new THREE.Mesh(beamGeo, new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: 0.06, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false }))
      beam.position.set((i - 1.5) * 14, 30, -70)
      this.beams.push(beam)
      this.scene.add(beam)
    })

    this.loadProps()
    this.resize()
    addEventListener('resize', () => this.resize())
  }

  // concert props: CC0 "Concert Pack" by iPoly3D, poly.pizza/bundle/Concert-Pack-ag2DBgUKV5
  private loadProps() {
    // coloured wash lights so the black props read against the dark background; they pulse with the beat
    for (const [c, x] of [[0xff3d7f, -9], [0x3dd6ff, 9]]) {
      const wash = new THREE.PointLight(c, 40, 0, 1.2)
      wash.position.set(x, 6, -10)
      this.washes.push(wash)
      this.scene.add(wash)
    }
    const stageLight = new THREE.PointLight(0xffb347, 600, 0, 1.6)
    stageLight.position.set(0, 18, -48)
    this.scene.add(stageLight)

    const loader = new GLTFLoader()
    // each model is scaled to `height`, centred on x/z and set on the floor, then copied to every [x, y, z, rotY] spot
    const place = (file: string, height: number, spots: number[][], fog = true) =>
      loader.load(`/models/${file}.glb`, ({ scene: model }) => {
        const box = new THREE.Box3().setFromObject(model)
        const size = box.getSize(new THREE.Vector3()), centre = box.getCenter(new THREE.Vector3())
        model.position.set(-centre.x, -box.min.y, -centre.z)
        model.traverse(o => { if (o instanceof THREE.Mesh) o.material.fog = fog })
        const unit = new THREE.Group().add(model)
        unit.scale.setScalar(height / size.y)
        for (const [x, y, z, r = 0] of spots) {
          const prop = unit.clone()
          prop.position.set(x, y, z)
          prop.rotation.y = r
          this.scene.add(prop)
        }
      })
    place('stage', 16, [[0, 0, -62]], false) // past the fog, so it stays lit at the end of the highway
    place('speaker-tall', 3, [[-7.5, 0, -9, 0.4], [7.5, 0, -9, -0.4], [-8, 0, -22, 0.3], [8, 0, -22, -0.3]])
    place('speaker-small', 1.6, [[-7.5, 3, -9, 0.4], [7.5, 3, -9, -0.4], [-8, 3, -22, 0.3], [8, 3, -22, -0.3]])
    place('moto', 1.1, [[-7.5, 4.6, -9, 0.4], [7.5, 4.6, -9, -0.4]])
    place('mic', 3.4, [[-4.5, 0, -6, 0.3], [4.5, 0, -6, -0.3]])
    place('barricade', 1.2, [-1, 1].flatMap(side => Array.from({ length: 8 }, (_, i) => [side * 10.5, 0, -2 - i * 3.6, Math.PI / 2])))
  }

  private resize() {
    const w = innerWidth, h = innerHeight
    this.renderer.setSize(w, h, false)
    this.camera.aspect = w / h
    // keep the whole highway in view on narrow screens
    this.camera.fov = w / h < 1 ? 75 : 55
    this.camera.updateProjectionMatrix()
  }

  hit(lane: number, sp: boolean) {
    this.flash[lane] = 1
    const c = new THREE.Color(sp ? SP_COLOR : LANE_COLORS[lane])
    const pos = this.sparks.geometry.attributes.position as THREE.BufferAttribute
    for (let k = 0; k < 16; k++) {
      const i = this.sparkCursor = (this.sparkCursor + 1) % this.sparkData.length
      const a = Math.random() * Math.PI * 2
      this.sparkData[i] = { life: 1, vx: Math.cos(a) * 2.5, vy: 3 + Math.random() * 4, vz: Math.sin(a) * 1.5, c }
      pos.setXYZ(i, laneX(lane), 0.2, 0)
    }
  }

  miss(lane: number) { this.missFlash[lane] = 1 }

  beat(strength: number) { this.pulse = Math.max(this.pulse, strength) }

  render(songTime: number, notes: Note[], from: number, speed: number, held: boolean[], spActive: boolean) {
    const now = performance.now()
    const dt = Math.min(0.05, (now - this.clock) / 1000)
    this.clock = now
    const horizon = LEN / speed

    // scrolling wood + fret bars every half second of song time
    this.wood.offset.y = (songTime * speed) / (LEN / this.wood.repeat.y)
    const interval = 0.5
    const first = Math.floor(songTime / interval)
    this.frets.forEach((f, i) => {
      const z = -((first + i) * interval - songTime) * speed
      f.visible = z <= 0.1 && z > -LEN
      f.position.set(0, 0.02, z)
    })
    this.highwayMat.emissive.setHex(spActive ? 0x1c3a66 : 0x000000)

    // gems
    let g = 0
    for (let i = from; i < notes.length && g < POOL; i++) {
      const n = notes[i]
      if (n.t - songTime > horizon) break
      const tailEnd = n.t + n.len
      if (tailEnd < songTime - 0.2) continue
      const gem = this.gems[g++]
      const sp = n.sp > 0
      const z = -(n.t - songTime) * speed
      gem.group.visible = !n.hit
      gem.group.position.set(laneX(n.lane), 0.1, z)
      gem.body.material = sp ? this.spMat : this.laneMats[n.lane]
      gem.tail.visible = n.len > 0 && !n.missed && !(n.hit && !n.holding)
      if (gem.tail.visible) {
        const start = Math.max(n.t, n.hit ? songTime : -Infinity)
        gem.tail.position.set(laneX(n.lane), 0.05, -(start - songTime) * speed)
        gem.tail.scale.z = Math.max(0.01, (tailEnd - start) * speed)
        gem.tail.material = sp ? this.spTailMat : this.tailMats[n.lane]
      }
    }
    for (; g < POOL; g++) this.gems[g].group.visible = this.gems[g].tail.visible = false

    // strike line feedback
    for (let l = 0; l < 5; l++) {
      this.flash[l] = Math.max(0, this.flash[l] - dt * 4)
      this.missFlash[l] = Math.max(0, this.missFlash[l] - dt * 3)
      const ring = this.rings[l].material as THREE.MeshLambertMaterial
      ring.emissiveIntensity = 0.2 + (held[l] ? 0.5 : 0) + this.flash[l] * 1.5
      const pad = this.pads[l].material as THREE.MeshBasicMaterial
      pad.color.setHex(held[l] ? LANE_COLORS[l] : 0x111111)
      if (this.missFlash[l] > 0) pad.color.lerp(new THREE.Color(0x550000), this.missFlash[l])
      this.rings[l].position.y = 0.08 + (held[l] ? -0.03 : 0)
      const flame = this.flames[l]
      ;(flame.material as THREE.SpriteMaterial).opacity = this.flash[l]
      flame.scale.setScalar(0.8 + (1 - this.flash[l]) * 1.4)
    }

    // sparks
    const pos = this.sparks.geometry.attributes.position as THREE.BufferAttribute
    const col = this.sparks.geometry.attributes.color as THREE.BufferAttribute
    this.sparkData.forEach((s, i) => {
      if (s.life <= 0) return
      s.life -= dt * 2
      s.vy -= 12 * dt
      pos.setXYZ(i, pos.getX(i) + s.vx * dt, Math.max(0, pos.getY(i) + s.vy * dt), pos.getZ(i) + s.vz * dt)
      const f = Math.max(0, s.life) // additive blending: darker = more transparent
      col.setXYZ(i, s.c.r * f, s.c.g * f, s.c.b * f)
    })
    pos.needsUpdate = col.needsUpdate = true

    // spotlights sway and pulse on strong onsets
    this.pulse = Math.max(0, this.pulse - dt * 2.5)
    this.beams.forEach((b, i) => {
      b.rotation.z = Math.sin(now / 1400 + i * 1.7) * 0.5
      ;(b.material as THREE.MeshBasicMaterial).opacity = 0.05 + this.pulse * 0.18
    })
    for (const w of this.washes) w.intensity = 40 + this.pulse * 160

    this.renderer.render(this.scene, this.camera)
  }
}
