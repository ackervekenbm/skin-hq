// Renders the app icons from the SVG below into public/. Run after changing
// the design: `npm run icons`, then commit the PNGs.

import sharp from 'sharp'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const pub = (name) => fileURLToPath(new URL(`../public/${name}`, import.meta.url))

const BG = '#0b0d10'
const LIME = '#b9e233'

// A price tag (trading) with a scope reticle cut into it (Counter-Strike), in
// the default Onyx theme's lime. The tag is tilted; the reticle stays upright.
const reticle = { x: 291, y: 221 }
const ticks = [[0, -1], [0, 1], [-1, 0], [1, 0]]
  .map(([dx, dy]) => `<line x1="${reticle.x + dx * 30}" y1="${reticle.y + dy * 30}" x2="${reticle.x + dx * 76}" y2="${reticle.y + dy * 76}"/>`)
  .join('')
const mark = `
  <g transform="rotate(-45 256 256)">
    <path d="M92 256 L176 154 H394 a28 28 0 0 1 28 28 V330 a28 28 0 0 1 -28 28 H176 Z" fill="${LIME}"/>
    <circle cx="178" cy="256" r="24" fill="${BG}"/>
  </g>
  <circle cx="${reticle.x}" cy="${reticle.y}" r="50" fill="none" stroke="${BG}" stroke-width="16"/>
  <g stroke="${BG}" stroke-width="14" stroke-linecap="round">${ticks}</g>
  <circle cx="${reticle.x}" cy="${reticle.y}" r="9" fill="${BG}"/>`

// Rounded tile: favicon, apple-touch-icon and the plain manifest icons.
const tile = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="112" fill="${BG}"/>${mark}
</svg>`

// Full-bleed square with the mark inside the maskable safe zone (centre 80%).
const maskable = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" fill="${BG}"/>
  <g transform="translate(256 256) scale(0.94) translate(-256 -256)">${mark}</g>
</svg>`

await mkdir(pub('icons'), { recursive: true })
await writeFile(pub('favicon.svg'), `${tile}\n`)
await sharp(Buffer.from(tile)).resize(180, 180).png().toFile(pub('apple-touch-icon.png'))
await sharp(Buffer.from(tile)).resize(192, 192).png().toFile(pub('icons/icon-192.png'))
await sharp(Buffer.from(tile)).resize(512, 512).png().toFile(pub('icons/icon-512.png'))
await sharp(Buffer.from(maskable)).resize(512, 512).png().toFile(pub('icons/icon-512-maskable.png'))

console.log('generated: favicon.svg, apple-touch-icon.png, icons/icon-192.png, icons/icon-512.png, icons/icon-512-maskable.png')
