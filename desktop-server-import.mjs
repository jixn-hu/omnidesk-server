import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { parseRdo, parseXTerminalRecords, candidateToConnection } from './shared/desktop-import.mjs'

const maximum = 8 * 1024 * 1024
function xterminal(bytes) {
  if (bytes.subarray(0, 16).toString('ascii') !== 'SQLite format 3\0') throw new Error('请选择 XTerminal 的 local-store.db 配置库')
  const directory = mkdtempSync(join(tmpdir(), 'omnidesk-import-'))
  const filename = join(directory, 'local-store.db')
  let db
  try {
    writeFileSync(filename, bytes, { mode: 0o600 })
    db = new DatabaseSync(filename, { readOnly: true })
    db.exec('PRAGMA trusted_schema=OFF; PRAGMA query_only=ON')
    if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='local_store'").get()) throw new Error('invalid XTerminal database')
    const rowsOf = fragment => db.prepare('SELECT payload FROM local_store WHERE store_key LIKE ? LIMIT 10001').all('%' + fragment + '%').map(row => {
      const value = JSON.parse(String(row.payload))
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid XTerminal row')
      return value
    })
    return parseXTerminalRecords({ sshRecords: rowsOf('ServerDatabaseServerImp'), rdpRecords: rowsOf('RdpDatabaseServerImp'), identities: rowsOf('IdentityDatabaseServerImp'), groups: rowsOf('GroupDatabaseServerImp') })
  } catch {
    throw new Error('XTerminal 配置库无效或已损坏，请先退出 XTerminal，再复制完整的 local-store.db 文件')
  } finally {
    db?.close()
    try { unlinkSync(filename) } finally { rmdirSync(directory) }
  }
}
export function readDesktopServerImport(contents, format) {
  if (typeof contents !== 'string' || !contents.length || contents.length > Math.ceil(maximum / 3) * 4 || contents.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(contents)) throw new Error('请选择不超过 8 MB 的 RDO 或 XTerminal 配置文件')
  const bytes = Buffer.from(contents, 'base64')
  if (bytes.length > maximum || bytes.toString('base64') !== contents) throw new Error('配置文件编码不正确或超过 8 MB')
  try {
    const parsed = format === 'rdo' ? parseRdo(bytes) : xterminal(bytes)
    const entries = parsed.candidates.map(candidate => ({
      configuration: candidateToConnection(candidate), credential: parsed.credentials.get(candidate.tempId),
      requiresReview: !!candidate.requiresReview || !!candidate.hostInferred,
      reviewReason: candidate.reviewReason || (candidate.hostInferred ? '地址由名称推断，请核对后勾选' : undefined)
    }))
    return { entries, warnings: parsed.warnings.map(warning => warning.replace('可导入配置后补填或选择公共凭据。', '共享目录要求完整凭据，请补全后重新上传。').replace('仍不可读的项可先导入连接信息。', '仍不可读的条目需补全凭据后重新上传。')) }
  } finally { bytes.fill(0) }
}
