import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

function loadKey(): Buffer {
  const fromEnv = process.env.SKINHQ_SESSION_KEY
  if (fromEnv) return createHash('sha256').update(fromEnv).digest()

  if (process.env.NODE_ENV === 'production') {
    throw new Error('SKINHQ_SESSION_KEY is required in production; see .env.example')
  }

  const keyFile = path.resolve(process.env.DATA_DIR ?? path.resolve(process.cwd(), 'data'), '.dev-session-key')
  try {
    return createHash('sha256').update(readFileSync(keyFile, 'utf8').trim()).digest()
  } catch {
    const generated = randomBytes(32).toString('hex')
    mkdirSync(path.dirname(keyFile), { recursive: true })
    writeFileSync(keyFile, generated, { mode: 0o600 })
    console.warn('[crypto] Generated a dev session key at data/.dev-session-key (not for production)')
    return createHash('sha256').update(generated).digest()
  }
}

export function encryptSecret(plain: string): string {
  const key = loadKey()
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return [iv.toString('base64'), enc.toString('base64'), tag.toString('base64')].join('.')
}

export function decryptSecret(payload: string): string {
  const key = loadKey()
  const [ivB64, dataB64, tagB64] = payload.split('.')
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'))
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'))
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8')
}