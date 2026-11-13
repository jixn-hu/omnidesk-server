import { readDesktopServerImport } from './desktop-server-import.mjs'
import { sharedConfiguration } from './shared/shared-configuration.mjs'
import { parseConnectionAddress } from './shared/connection-identity.mjs'

function csvRows(contents) {
  const rows = []
  let row = [], value = '', quoted = false
  for (let index = 0; index < contents.length; index++) {
    const character = contents[index]
    if (character === '"') {
      if (quoted && contents[index + 1] === '"') { value += '"'; index++ }
      else if (quoted || value === '') quoted = !quoted
      else throw new Error('CSV 引号格式不正确')
    } else if (!quoted && (character === ',' || character === '\n' || character === '\r')) {
      row.push(value); value = ''
      if (character !== ',') {
        if (row.some(cell => cell.trim())) rows.push(row)
        row = []
        if (character === '\r' && contents[index + 1] === '\n') index++
      }
    } else value += character
  }
  if (quoted) throw new Error('CSV 引号未闭合')
  row.push(value)
  if (row.some(cell => cell.trim())) rows.push(row)
  if (!rows.length) throw new Error('配置文件为空')
  const aliases = { '名称': 'name', '协议': 'kind', '主机': 'host', '地址': 'host', '端口': 'port', '用户名': 'username', '密码': 'password', '私钥': 'privateKey', '私钥口令': 'passphrase', '分组': 'group', '备注': 'note', '域': 'domain', '标签': 'tags', '认证方式': 'authMethod' }
  const headers = rows.shift().map(cell => aliases[cell.trim()] ?? cell.trim())
  if (new Set(headers).size !== headers.length || !headers.includes('host')) throw new Error('CSV 需要唯一的列名，并包含 host / 主机列')
  return rows.map((cells, index) => {
    if (cells.length !== headers.length) throw new Error(`CSV 第 ${index + 2} 行列数与表头不一致`)
    return Object.fromEntries(headers.map((header, position) => [header, cells[position]]))
  })
}
export function readSharedServerImport(contents, format = 'json') {
  return readSharedServerDocument(contents, format).entries
}
export function readSharedServerDocument(contents, format = 'json') {
  let entries, warnings = []
  if (format === 'rdo' || format === 'xterminal') ({ entries, warnings } = readDesktopServerImport(contents, format))
  else {
    if (typeof contents !== 'string' || Buffer.byteLength(contents) > 8 * 1024 * 1024) throw new Error('请选择不超过 8 MB 的配置文件')
    const text = contents.replace(/^\uFEFF/, '')
    if (format === 'csv') entries = csvRows(text)
    else if (format === 'json') {
      let document
      try { document = JSON.parse(text) } catch { throw new Error('JSON 格式不正确，请检查文件内容') }
      entries = Array.isArray(document) ? document : document?.servers ?? document?.connections
    } else throw new Error('支持 RDO、XTerminal 配置库、JSON 或 CSV 配置')
  }
  if (!Array.isArray(entries) || entries.length === 0 || entries.length > 1000) throw new Error('配置需要包含 1–1000 台服务器')
  return { entries, warnings }
}
export function normalizeSharedServer(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('服务器条目需要为对象')
  const raw = entry.configuration ?? entry
  const kind = typeof raw.kind === 'string' ? raw.kind.trim().toLowerCase() : raw.kind
  const tags = typeof raw.tags === 'string' ? raw.tags.split(/[;；|]/).map(tag => tag.trim()).filter(Boolean) : raw.tags
  const configuration = sharedConfiguration({ ...raw, kind, port: raw.port === '' || raw.port === undefined ? kind === 'ssh' ? 22 : 3389 : Number(raw.port), authMethod: raw.authMethod || (entry.privateKey ? 'privateKey' : 'password'), ...(tags === undefined ? {} : { tags }) })
  parseConnectionAddress(configuration.host, configuration.port)
  return { configuration, credential: entry.credential ?? { secret: entry.privateKey || entry.password || entry.secret, ...(entry.passphrase ? { passphrase: entry.passphrase } : {}) } }
}
export function sharedServerCredential(value) {
  if (!value || typeof value.secret !== 'string' || !value.secret || value.secret.length > 1024 * 1024 || (value.passphrase !== undefined && (typeof value.passphrase !== 'string' || value.passphrase.length > 4096))) throw new Error('请提供服务器密码或私钥；编辑时留空可保留原凭据')
  return { secret: value.secret, ...(value.passphrase === undefined ? {} : { passphrase: value.passphrase }) }
}
