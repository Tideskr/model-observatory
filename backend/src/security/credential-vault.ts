import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto'
import { AppError } from '../errors.js'
import type { DatabasePool } from '../db/connection.js'

interface Envelope {
  ciphertext: Buffer
  iv: Buffer
  authTag: Buffer
  aad: string
  expiresAt: number
}

export interface CredentialVault {
  put(secret: string, aad: string, expiresAt: Date): Promise<string>
  read(handle: string): Promise<string>
  delete(handle: string): Promise<void>
  purgeExpired(now?: Date): Promise<number>
  close(): Promise<void>
}

export class MemoryCredentialVault implements CredentialVault {
  readonly #envelopes = new Map<string, Envelope>()

  constructor(private readonly key: Buffer) {
    if (key.length !== 32) throw new Error('credential vault key must be 32 bytes')
  }

  async put(secret: string, aad: string, expiresAt: Date): Promise<string> {
    const handle = randomUUID()
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.key, iv)
    cipher.setAAD(Buffer.from(aad))
    const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()])
    this.#envelopes.set(handle, { ciphertext, iv, authTag: cipher.getAuthTag(), aad, expiresAt: expiresAt.getTime() })
    return handle
  }

  async read(handle: string): Promise<string> {
    const envelope = this.#envelopes.get(handle)
    if (!envelope || envelope.expiresAt <= Date.now()) {
      this.#envelopes.delete(handle)
      throw new AppError(410, 'credential_expired', 'The temporary credential is unavailable or expired.')
    }
    const decipher = createDecipheriv('aes-256-gcm', this.key, envelope.iv)
    decipher.setAAD(Buffer.from(envelope.aad))
    decipher.setAuthTag(envelope.authTag)
    return Buffer.concat([decipher.update(envelope.ciphertext), decipher.final()]).toString('utf8')
  }

  async delete(handle: string): Promise<void> {
    const envelope = this.#envelopes.get(handle)
    envelope?.ciphertext.fill(0)
    this.#envelopes.delete(handle)
  }

  async purgeExpired(now = new Date()): Promise<number> {
    let purged = 0
    for (const [handle, envelope] of this.#envelopes) {
      if (envelope.expiresAt <= now.getTime()) {
        await this.delete(handle)
        purged += 1
      }
    }
    return purged
  }

  async close(): Promise<void> {
    for (const handle of this.#envelopes.keys()) await this.delete(handle)
  }

  get size(): number {
    return this.#envelopes.size
  }
}

export class PostgresCredentialVault implements CredentialVault {
  constructor(
    private readonly pool: DatabasePool,
    private readonly key: Buffer,
  ) {
    if (key.length !== 32) throw new Error('credential vault key must be 32 bytes')
  }

  async put(secret: string, aad: string, expiresAt: Date): Promise<string> {
    const handle = randomUUID()
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.key, iv)
    cipher.setAAD(Buffer.from(aad))
    const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()])
    await this.pool.query(
      `INSERT INTO secret_envelopes(handle,ciphertext,iv,auth_tag,aad,key_version,expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [handle, ciphertext, iv, cipher.getAuthTag(), aad, 'local-envelope-v1', expiresAt],
    )
    return handle
  }

  async read(handle: string): Promise<string> {
    const result = await this.pool.query<{
      ciphertext: Buffer
      iv: Buffer
      auth_tag: Buffer
      aad: string
      expires_at: Date
    }>(
      'SELECT ciphertext,iv,auth_tag,aad,expires_at FROM secret_envelopes WHERE handle = $1',
      [handle],
    )
    const envelope = result.rows[0]
    if (!envelope || envelope.expires_at.getTime() <= Date.now()) {
      await this.delete(handle)
      throw new AppError(410, 'credential_expired', 'The temporary credential is unavailable or expired.')
    }
    const decipher = createDecipheriv('aes-256-gcm', this.key, envelope.iv)
    decipher.setAAD(Buffer.from(envelope.aad))
    decipher.setAuthTag(envelope.auth_tag)
    return Buffer.concat([decipher.update(envelope.ciphertext), decipher.final()]).toString('utf8')
  }

  async delete(handle: string): Promise<void> {
    await this.pool.query('DELETE FROM secret_envelopes WHERE handle = $1', [handle])
  }

  async purgeExpired(now = new Date()): Promise<number> {
    const result = await this.pool.query('DELETE FROM secret_envelopes WHERE expires_at <= $1', [now])
    return result.rowCount ?? 0
  }

  async close(): Promise<void> {}
}
