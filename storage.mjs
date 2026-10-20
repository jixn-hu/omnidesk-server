import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createCipheriv, createDecipheriv, randomBytes, createHash, scrypt, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

const derive = promisify(scrypt)
export const tokenHash = value => createHash('sha256').update(value).digest('hex')
export const newToken = () => randomBytes(32).toString('base64url')

export async function passwordHash(password, salt) {
  return (await derive(password, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })).toString('hex')
}

export async function passwordMatches(password, user) {
  const candidate = await passwordHash(password, user?.salt ?? 'omnidesk-nonexistent-account')
  return !!user && timingSafeEqual(Buffer.from(candidate, 'hex'), Buffer.from(user.password_hash, 'hex'))
}

export function openStorage(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const keyPath = join(directory, 'server-master.key')
  const databasePath = join(directory, 'official.sqlite')
  if (!existsSync(keyPath)) {
    if (existsSync(databasePath)) throw new Error('服务端主密钥缺失，请恢复原密钥；不会生成新密钥覆盖已有数据')
    writeFileSync(keyPath, randomBytes(32), { mode: 0o600, flag: 'wx' })
  }
  const key = readFileSync(keyPath)
  if (key.length !== 32) throw new Error('服务端主密钥格式不正确')
  const database = new DatabaseSync(databasePath)
  database.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, salt TEXT NOT NULL, password_hash TEXT NOT NULL, sync_key TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS configurations (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, revision INTEGER NOT NULL, contents TEXT NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS shares (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), endpoint_key TEXT NOT NULL UNIQUE, metadata TEXT NOT NULL, credential TEXT NOT NULL, host_key TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);`)
  database.exec(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS gitlab_identities (issuer TEXT NOT NULL, subject TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, username TEXT NOT NULL, PRIMARY KEY(issuer, subject), UNIQUE(user_id, issuer));`)
  database.exec('BEGIN IMMEDIATE')
  try {
    const columns = database.prepare('PRAGMA table_info(users)').all()
    if (!columns.some(column => column.name === 'role')) database.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('admin','user'))")
    if (!columns.some(column => column.name === 'last_login_at')) database.exec('ALTER TABLE users ADD COLUMN last_login_at INTEGER')
    if (!columns.some(column => column.name === 'disabled')) database.exec('ALTER TABLE users ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0 CHECK(disabled IN (0,1))')
    database.exec("UPDATE users SET role='admin' WHERE id=(SELECT id FROM users ORDER BY created_at, rowid LIMIT 1) AND NOT EXISTS (SELECT 1 FROM users WHERE role='admin'); CREATE INDEX IF NOT EXISTS shares_owner ON shares(owner_id); COMMIT;")
  } catch (error) { database.exec('ROLLBACK'); database.close(); throw error }
  const seal = (value, context) => {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    cipher.setAAD(Buffer.from(context))
    const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()])
    return JSON.stringify({ iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') })
  }
  const open = (contents, context) => {
    const box = JSON.parse(contents)
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(box.iv, 'base64'))
    decipher.setAAD(Buffer.from(context))
    decipher.setAuthTag(Buffer.from(box.tag, 'base64'))
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(box.data, 'base64')), decipher.final()]).toString('utf8'))
  }
  return { database, seal, open, close: () => { database.close(); key.fill(0) } }
}
