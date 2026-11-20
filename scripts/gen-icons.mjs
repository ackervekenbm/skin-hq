// Renders the app icons from the SVG below into public/. Run after changing
// the design: `npm run icons`, then commit the PNGs.

import sharp from 'sharp'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const pub = (name) => fileURLToPath(new URL(`../public/${name}`, import.meta.url))

// A faceted gem in the default (Onyx) theme's lime-to-gold gradient.
const gem = `
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#b9e233"/>
      <stop offset="1" stop-color="#e2b93c"/>
    </linearGradient>
  </defs>
  <polygon points="166,170 346,170 406,236 256,402 106,236" fill="url(#g)"/>
  <polygon points="166,170 206,236 106,236" fill="#fff" fill-opacity="0.28"/>
  <polygon points="206,236 256,170 306,236" fill="#fff" fill-opacity="0.14"/>
  <polygon points="346,170 406,236 306,236" fill="#000" fill-opacity="0.12"/>
  <polygon points="106,236 206,236 256,402" fill="#000" fill-opacity="0.10"/>
  <polygon points="306,236 406,236 256,402" fill="#000" fill-opacity="0.30"/>`

// Rounded tile: favicon, apple-touch-icon and the plain manifest icons.
const tile = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="112" fill="#0b0d10"/>${gem}
</svg>`

// Full-bleed square with the gem inside the maskable safe zone (centre 80%).
const maskable = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" fill="#0b0d10"/>
  <g transform="translate(256 286) scale(0.78) translate(-256 -286)">${gem}</g>
</svg>`

await mkdir(pub('icons'), { recursive: true })
await writeFile(pub('favicon.svg'), `${tile}\n`)
await sharp(Buffer.from(tile)).resize(180, 180).png().toFile(pub('apple-touch-icon.png'))
await sharp(Buffer.from(tile)).resize(192, 192).png().toFile(pub('icons/icon-192.png'))
await sharp(Buffer.from(tile)).resize(512, 512).png().toFile(pub('icons/icon-512.png'))
await sharp(Buffer.from(maskable)).resize(512, 512).png().toFile(pub('icons/icon-512-maskable.png'))

console.log('generated: favicon.svg, apple-touch-icon.png, icons/icon-192.png, icons/icon-512.png, icons/icon-512-maskable.png')
