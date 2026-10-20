import express from 'express'
import { createServer } from 'node:http'
import { randomUUID, randomBytes } from 'node:crypto'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'
import { connectionKey, parseConnectionAddress } from './shared/connection-identity.mjs'
import { openStorage, passwordHash, passwordMatches, newToken, tokenHash } from './storage.mjs'
import { targetResolver, inspectSshKey, TargetError } from './targets.mjs'
import { startGateway } from './gateway.mjs'
import { registerGitlabAuth } from './gitlab-auth.mjs'
import { sharedConfiguration } from './shared/shared-configuration.mjs'
import { registerAdminConsole, adminCookieToken, requireAdminBrowserRequest } from './admin-console.mjs'
import { registerUserManagement } from './admin-users.mjs'

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status }
}
const fail = (status, message) => { throw new HttpError(status, message) }
const text = (value, label, maximum = 256) => {
  if (typeof value !== 'string' || value.length > maximum || /[\0\r\n]/.test(value)) fail(400, `${label}格式不正确`)
  return value.trim()
}
const username = value => {
  const result = text(value, '账号', 32).toLowerCase()
  if (!/^[a-z0-9_]{3,32}$/.test(result)) fail(400, '账号需为 3–32 位字母、数字或下划线')
  return result
}
const password = value => {
  if (typeof value !== 'string' || value.length < 10 || value.length > 1024) fail(400, '账号密码需为 10–1024 个字符')
  return value
}

export function createOfficialServer(options = {}) {
  const storage = openStorage(options.directory ?? resolve('official-data'))
  const { database, seal, open } = storage
  database.prepare('INSERT OR IGNORE INTO settings VALUES (?, ?)').run('registrationOpen', JSON.stringify(options.registration ?? process.env.OFFICIAL_REGISTRATION === 'true'))
  const registrationOpen = () => database.prepare('SELECT value FROM settings WHERE key=?').get('registrationOpen').value === 'true'
  const resolveTarget = targetResolver(options.targetCidrs ?? process.env.OFFICIAL_TARGET_CIDRS ?? '')
  const guacd = options.guacd ?? { host: process.env.GUACD_HOST ?? '127.0.0.1', port: Number(process.env.GUACD_PORT ?? 4822) }
  const application = express()
  application.disable('x-powered-by')
  application.use((request, response, next) => {
    response.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
    if (request.headers.origin) {
      try {
        const origin = new URL(request.headers.origin)
        const expected = options.publicUrl ?? process.env.OFFICIAL_PUBLIC_URL
        const localHttp = origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)
        if (expected ? origin.origin !== new URL(expected).origin : origin.host !== request.headers.host || !(origin.protocol === 'https:' || localHttp)) throw new Error()
      } catch { return response.status(403).json({ error: '不允许跨站请求' }) }
    }
    next()
  })
  application.use(express.json({ limit: '18mb', strict: true }))
  const server = createServer(application)
  server.requestTimeout = 30000
  server.headersTimeout = 10000
  const websocketServer = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024, perMessageDeflate: false })
  const rates = new Map()
  const tickets = new Map()
  const active = new Map()
  let authBusy = 0
  let targetBusy = 0
  const rate = (key, maximum, duration = 60000) => {
    const now = Date.now()
    const current = rates.get(key)
    if (!current || current.expires < now) {
      if (!current && rates.size >= 20000) fail(503, '服务繁忙，请稍后重试')
      rates.set(key, { count: 1, expires: now + duration })
    }
    else if (++current.count > maximum) fail(429, '操作过于频繁，请稍后重试')
  }
  const route = handler => (request, response, next) => Promise.resolve().then(() => handler(request, response)).catch(next)
  const session = hash => database.prepare('SELECT users.id, users.username, users.role, sessions.expires_at FROM sessions JOIN users ON users.id=sessions.user_id WHERE sessions.token_hash=? AND sessions.expires_at>? AND users.disabled=0').get(hash, Date.now())
  const authenticate = (request, response, next) => {
    try {
      const browserAdmin = request.path.startsWith('/admin/') && !request.headers.authorization
      const token = browserAdmin ? adminCookieToken(request) : /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.authorization ?? '')?.[1]
      if (browserAdmin) requireAdminBrowserRequest(request)
      if (!token) fail(401, '请登录官方账号')
      request.sessionHash = tokenHash(token)
      request.account = session(request.sessionHash)
      if (!request.account) fail(401, '登录已过期，请重新登录')
      if (browserAdmin && request.account.role !== 'admin') fail(403, '只有管理员可以访问管理后台')
      rate('api:' + request.account.id, 180)
      next()
    } catch (error) { next(error) }
  }
  const publicUser = user => {
    const identity = database.prepare('SELECT issuer, username FROM gitlab_identities WHERE user_id=? ORDER BY issuer LIMIT 1').get(user.id)
    return { id: user.id, username: user.username, role: user.role, ...(identity ? { gitlab: identity } : {}) }
  }
  const loginResult = (user, lifetime = 30 * 24 * 60 * 60 * 1000) => {
    const current = database.prepare('SELECT * FROM users WHERE id=? AND disabled=0').get(user.id)
    if (!current) fail(403, '该账号已被停用，请联系管理员')
    user = current
    const token = newToken()
    const expiresAt = Date.now() + lifetime
    database.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run(tokenHash(token), user.id, expiresAt)
    database.prepare('DELETE FROM sessions WHERE token_hash IN (SELECT token_hash FROM sessions WHERE user_id=? ORDER BY expires_at DESC LIMIT -1 OFFSET 20)').run(user.id)
    database.prepare('UPDATE users SET last_login_at=? WHERE id=?').run(Date.now(), user.id)
    return { user: publicUser(user), token, expiresAt, syncKey: open(user.sync_key, 'sync:' + user.id) }
  }
  application.get('/health', (_request, response) => response.json({ service: 'omnidesk-official', version: 1 }))
  const gitlab = registerGitlabAuth({ application, database, seal, open, route, fail, rate, session, loginResult, registrationOpen, configuration: options.gitlab })
  registerAdminConsole({ application, database, route, fail, rate, loginResult, publicUser })
  application.get('/v1/auth/providers', (_request, response) => response.json({ registrationOpen: registrationOpen(), gitlab: gitlab.provider() }))
  for (const action of ['register', 'login']) application.post('/v1/auth/' + action, route(async (request, response) => {
    rate('auth-ip:' + request.socket.remoteAddress, 20)
    const name = username(request.body.username)
    const secret = password(request.body.password)
    rate('auth-account:' + name, 10)
    if (authBusy >= 4) fail(429, '登录服务繁忙，请稍后重试')
    authBusy++
    try {
      let user = database.prepare('SELECT * FROM users WHERE username=?').get(name)
      if (action === 'register') {
        if (!registrationOpen()) fail(403, '管理员已关闭新账号注册')
        if (user) fail(409, '该账号已注册')
        const id = randomUUID()
        const salt = randomBytes(16).toString('hex')
        const hash = await passwordHash(secret, salt)
        database.exec('BEGIN IMMEDIATE')
        try {
          if (!registrationOpen()) fail(403, '管理员已关闭新账号注册')
          const role = database.prepare('SELECT 1 FROM users LIMIT 1').get() ? 'user' : 'admin'
          database.prepare('INSERT INTO users (id, username, salt, password_hash, sync_key, created_at, role) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, name, salt, hash, seal(newToken(), 'sync:' + id), Date.now(), role)
          database.exec('COMMIT')
        }
        catch (error) { database.exec('ROLLBACK'); if ((error.errcode & 255) === 19) fail(409, '该账号已注册'); throw error }
        user = database.prepare('SELECT * FROM users WHERE id=?').get(id)
      } else {
        if (!await passwordMatches(secret, user)) fail(401, '账号或密码不正确')
        if (user.disabled) fail(403, '该账号已被停用，请联系管理员')
      }
      response.json(loginResult(user))
    } finally { authBusy-- }
  }))
  application.use('/v1', authenticate)
  application.get('/v1/me', (request, response) => response.json(publicUser(request.account)))
  registerUserManagement({ application, storage, route, fail, active, tickets, publicUser })
  application.get('/v1/admin/settings', route((request, response) => {
    if (request.account.role !== 'admin') fail(403, '只有管理员可以管理注册设置')
    response.json({ registrationOpen: registrationOpen(), gitlab: gitlab.settings() })
  }))
  application.get('/v1/admin/auth-diagnostics', route((request, response) => {
    if (request.account.role !== 'admin') fail(403, '只有管理员可以查看授权诊断')
    response.json({ failures: gitlab.diagnostics() })
  }))
  application.put('/v1/admin/settings', route((request, response) => {
    if (request.account.role !== 'admin') fail(403, '只有管理员可以管理注册设置')
    if (typeof request.body.registrationOpen !== 'boolean') fail(400, '注册开关必须为布尔值')
    const gitlabSettings = request.body.gitlab === undefined ? undefined : gitlab.prepareSettings(request.body.gitlab)
    const gitlabChanged = gitlabSettings !== undefined && gitlabSettings !== database.prepare('SELECT value FROM settings WHERE key=?').get('gitlab').value
    database.exec('BEGIN IMMEDIATE')
    try {
      database.prepare('UPDATE settings SET value=? WHERE key=?').run(JSON.stringify(request.body.registrationOpen), 'registrationOpen')
      if (gitlabSettings) database.prepare('UPDATE settings SET value=? WHERE key=?').run(gitlabSettings, 'gitlab')
      database.exec('COMMIT')
    } catch (error) { database.exec('ROLLBACK'); throw error }
    if (gitlabChanged) gitlab.invalidate()
    response.json({ registrationOpen: registrationOpen(), gitlab: gitlab.settings() })
  }))
  application.get('/v1/admin/users', route((request, response) => {
    if (request.account.role !== 'admin') fail(403, '只有管理员可以查看用户信息')
    const query = typeof request.query.search === 'string' ? request.query.search.slice(0, 200) : ''
    const page = Number(request.query.page ?? 0)
    if (!Number.isSafeInteger(page) || page < 0 || page > 100000) fail(400, '页码无效')
    const pattern = '%' + query.replace(/[\\%_]/g, value => '\\' + value) + '%'
    const total = database.prepare('SELECT count(*) AS total FROM users WHERE username LIKE ? ESCAPE char(92)').get(pattern).total
    const rows = database.prepare(`SELECT users.id, users.username, users.role, users.disabled, users.created_at AS createdAt, users.last_login_at AS lastLoginAt,
      configurations.revision AS configurationRevision, configurations.updated_at AS configurationUpdatedAt,
      length(CAST(configurations.contents AS BLOB)) AS configurationBytes,
      (SELECT count(*) FROM shares WHERE owner_id=users.id) AS sharedServers,
      (SELECT count(*) FROM sessions WHERE user_id=users.id AND expires_at>?) AS loginSessions
      FROM users LEFT JOIN configurations ON configurations.user_id=users.id
      WHERE users.username LIKE ? ESCAPE char(92) ORDER BY users.created_at, users.rowid LIMIT 50 OFFSET ?`).all(Date.now(), pattern, page * 50)
    const summary = database.prepare("SELECT count(*) AS users, sum(CASE WHEN role='admin' THEN 1 ELSE 0 END) AS administrators, (SELECT count(*) FROM configurations) AS synchronizedUsers, (SELECT count(*) FROM shares) AS sharedServers FROM users").get()
    response.json({ total, summary, items: rows })
  }))
  application.post('/v1/logout', (request, response) => {
    database.prepare('DELETE FROM sessions WHERE token_hash=?').run(request.sessionHash)
    for (const item of active.values()) if (item.sessionHash === request.sessionHash) item.close()
    response.json({ ok: true })
  })
  application.get('/v1/configuration', (request, response) => {
    const record = database.prepare('SELECT revision, contents, updated_at FROM configurations WHERE user_id=?').get(request.account.id)
    response.json(record ? { revision: record.revision, contents: record.contents, updatedAt: record.updated_at } : { revision: 0, contents: null })
  })
  application.put('/v1/configuration', route((request, response) => {
    const { contents, revision } = request.body
    if (!Number.isSafeInteger(revision) || revision < 0 || typeof contents !== 'string' || Buffer.byteLength(contents) > 16 * 1024 * 1024) fail(400, '配置同步参数不正确')
    let envelope
    try { envelope = JSON.parse(contents) } catch { fail(400, '配置必须为加密备份') }
    if (envelope.format !== 'omnidesk-encrypted-configuration' || envelope.version !== 1 || typeof envelope.data !== 'string') fail(400, '配置必须为加密备份')
    const now = Date.now()
    const current = database.prepare('SELECT revision FROM configurations WHERE user_id=?').get(request.account.id)
    if ((current?.revision ?? 0) !== revision) fail(409, '另一台设备已更新云端配置，请先拉取合并后再上传')
    database.prepare('INSERT INTO configurations VALUES (?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET revision=excluded.revision, contents=excluded.contents, updated_at=excluded.updated_at').run(request.account.id, revision + 1, contents, now)
    response.json({ revision: revision + 1, updatedAt: now })
  }))
  const metadataFrom = body => {
    if (body.sharingMode === 'copy') {
      if (body.credentialDisclosure !== true) fail(400, '发布配置共享前必须明确确认接收者会获得密码或私钥')
      let configuration
      try { configuration = sharedConfiguration(body.configuration); parseConnectionAddress(configuration.host, configuration.port) }
      catch (error) { fail(400, error.message) }
      return { ...configuration, sharingMode: 'copy', configuration, ignoreCertificate: configuration.options?.ignoreCertificate !== false }
    }
    const kind = body.kind
    if (!['ssh', 'rdp'].includes(kind)) fail(400, '只支持共享 SSH 和 RDP 服务器')
    if (body.ignoreCertificate !== undefined && typeof body.ignoreCertificate !== 'boolean') fail(400, 'RDP 证书选项必须为布尔值')
    const metadata = { kind, name: text(body.name, '名称'), host: text(body.host, '主机地址', 1024), port: body.port, username: text(body.username, '登录账号'), note: typeof body.note === 'string' ? body.note.slice(0, 4000) : '', domain: text(body.domain ?? '', '域'), authMethod: body.authMethod ?? 'password', ignoreCertificate: body.ignoreCertificate !== false }
    if (!metadata.name || !metadata.username || !Number.isInteger(metadata.port) || metadata.port < 1 || metadata.port > 65535) fail(400, '请先补全连接名称、账号和服务端口')
    if (!['password', 'privateKey'].includes(metadata.authMethod) || (kind === 'rdp' && metadata.authMethod !== 'password')) fail(400, '共享连接需要已保存的密码或私钥，不支持 SSH Agent')
    try { parseConnectionAddress(metadata.host, metadata.port) } catch { fail(400, '主机地址或穿透端口格式不正确') }
    return metadata
  }
  const withTarget = async operation => {
    if (targetBusy >= 8) fail(429, '网关正在建立其他连接，请稍后重试')
    targetBusy++
    try { return await operation() }
    catch (error) { if (error instanceof TargetError) fail(400, error.message); throw error }
    finally { targetBusy-- }
  }
  application.post('/v1/shares/check-target', route(async (request, response) => {
    rate('target:' + request.account.id, 120)
    const metadata = metadataFrom(request.body)
    const existing = database.prepare('SELECT id, owner_id, updated_at FROM shares WHERE endpoint_key=?').get(connectionKey(metadata))
    if (existing && existing.owner_id !== request.account.id) fail(409, '该服务器已由其他账号共享，请从共享目录使用，不会创建重复记录')
    if (metadata.sharingMode === 'copy') return response.json({ existing: existing ? { id: existing.id, updatedAt: existing.updated_at } : undefined })
    const result = await withTarget(async () => {
      const endpoint = await resolveTarget(metadata.host, metadata.port)
      return metadata.kind === 'ssh' ? await inspectSshKey(endpoint) : {}
    })
    response.json({ fingerprint: result.fingerprint, existing: existing ? { id: existing.id, updatedAt: existing.updated_at } : undefined })
  }))
  application.post('/v1/shares', route(async (request, response) => {
    rate('share:' + request.account.id, 120)
    const metadata = metadataFrom(request.body)
    const key = connectionKey(metadata)
    const existing = database.prepare('SELECT id, owner_id, updated_at FROM shares WHERE endpoint_key=?').get(key)
    if (existing && existing.owner_id !== request.account.id) fail(409, '该服务器已经共享，目录中只保留一条；请从共享列表使用或由原共享者更新')
    if (existing && (request.body.existingId !== existing.id || request.body.existingUpdatedAt !== existing.updated_at)) fail(409, '共享已存在或已被更新，请重新确认后再发布')
    if (!existing && database.prepare('SELECT count(*) AS total FROM shares WHERE owner_id=?').get(request.account.id).total >= 1000) fail(400, '每个账号最多共享 1000 台服务器')
    const credential = request.body.credential
    if (!credential || typeof credential.secret !== 'string' || !credential.secret || credential.secret.length > 1024 * 1024 || (credential.passphrase !== undefined && (typeof credential.passphrase !== 'string' || credential.passphrase.length > 4096))) fail(400, '请先保存服务器凭据')
    const hostKey = await withTarget(async () => {
      if (metadata.sharingMode === 'copy') return null
      const endpoint = await resolveTarget(metadata.host, metadata.port)
      if (metadata.kind !== 'ssh') return null
      const inspected = await inspectSshKey(endpoint)
      if (request.body.trustedFingerprint !== inspected.fingerprint) fail(409, 'SSH 主机身份未确认或已变化，请重新发布并核对指纹')
      return inspected.key
    })
    const id = existing?.id ?? randomUUID()
    const now = Math.max(Date.now(), (existing?.updated_at ?? 0) + 1)
    const encrypted = seal({ secret: credential.secret, passphrase: credential.passphrase }, 'share:' + id)
    try {
      if (existing) {
        const result = database.prepare('UPDATE shares SET metadata=?, credential=?, host_key=?, updated_at=? WHERE id=? AND owner_id=? AND updated_at=?').run(JSON.stringify(metadata), encrypted, hostKey, now, id, request.account.id, existing.updated_at)
        if (!result.changes) fail(409, '共享已被修改，请刷新后重试')
        for (const item of [...active.values()]) if (item.shareId === id) item.close()
      } else database.prepare('INSERT INTO shares VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(id, request.account.id, key, JSON.stringify(metadata), encrypted, hostKey, now, now)
    }
    catch (error) { if ((error.errcode & 255) === 19) fail(409, '该服务器已被其他账号共享，未创建重复记录'); throw error }
    response.status(201).json({ id })
  }))
  application.get('/v1/shares', route((request, response) => {
    const query = typeof request.query.search === 'string' ? request.query.search.slice(0, 200) : ''
    const page = Math.max(0, Math.min(100000, Number(request.query.page) || 0))
    if (!Number.isInteger(page)) fail(400, '页码无效')
    const pattern = '%' + query.replace(/[\\%_]/g, value => '\\' + value) + '%'
    const predicate = "(json_extract(metadata, '$.name') LIKE ? ESCAPE char(92) OR json_extract(metadata, '$.host') LIKE ? ESCAPE char(92) OR json_extract(metadata, '$.note') LIKE ? ESCAPE char(92))"
    const total = database.prepare('SELECT count(*) AS total FROM shares WHERE ' + predicate).get(pattern, pattern, pattern).total
    const rows = database.prepare('SELECT shares.id, shares.owner_id, shares.metadata, shares.created_at, users.username AS owner FROM shares JOIN users ON users.id=shares.owner_id WHERE ' + predicate + ' ORDER BY shares.created_at DESC, shares.id LIMIT 50 OFFSET ?').all(pattern, pattern, pattern, page * 50)
    response.json({ total, items: rows.map(row => ({ id: row.id, ...JSON.parse(row.metadata), downloadable: JSON.parse(row.metadata).sharingMode === 'copy' || row.owner_id === request.account.id, owner: row.owner, owned: row.owner_id === request.account.id, createdAt: row.created_at })) })
  }))
  application.get('/v1/shares/:id/configuration', route((request, response) => {
    rate('share-download:' + request.account.id, 120)
    const record = database.prepare('SELECT * FROM shares WHERE id=?').get(request.params.id)
    if (!record) fail(404, '共享已撤销或不存在')
    const metadata = JSON.parse(record.metadata)
    if (metadata.sharingMode !== 'copy' && record.owner_id !== request.account.id) fail(409, '这是旧版免密网关共享，请共享者确认凭据可下载后重新发布；不会直接公开旧共享的密码')
    response.json({ configuration: sharedConfiguration(metadata.configuration ?? metadata), credential: open(record.credential, 'share:' + record.id) })
  }))
  application.delete('/v1/shares/:id', route((request, response) => {
    const shared = database.prepare('SELECT owner_id FROM shares WHERE id=?').get(request.params.id)
    if (!shared || shared.owner_id !== request.account.id) fail(404, '共享不存在或不属于当前账号')
    database.prepare('DELETE FROM shares WHERE id=?').run(request.params.id)
    for (const item of active.values()) if (item.shareId === request.params.id) item.close()
    response.json({ ok: true })
  }))
  application.post('/v1/shares/:id/ticket', route((request, response) => {
    rate('ticket:' + request.account.id, 20)
    if (!database.prepare('SELECT id FROM shares WHERE id=?').get(request.params.id)) fail(404, '共享已撤销或不存在')
    if (JSON.parse(database.prepare('SELECT metadata FROM shares WHERE id=?').get(request.params.id).metadata).sharingMode === 'copy') fail(409, '该条目是配置共享，请下载到本机后使用 SSH 或 RDP 连接')
    if ([...active.values()].filter(item => item.userId === request.account.id).length >= 8) fail(429, '每个账号最多同时打开 8 个共享会话')
    if (tickets.size >= 1000) fail(503, '共享会话服务繁忙')
    const ticket = newToken()
    const dimensions = { width: Math.max(320, Math.min(4096, Number(request.body.width) || 1280)), height: Math.max(240, Math.min(2160, Number(request.body.height) || 800)) }
    tickets.set(tokenHash(ticket), { shareId: request.params.id, sessionHash: request.sessionHash, userId: request.account.id, expires: Date.now() + 30000, dimensions })
    response.json({ ticket })
  }))
  application.use((error, request, response, _next) => {
    if (!(error instanceof HttpError) && !error.expose) {
      if (options.onError) options.onError(error)
      else console.error('[official] request failed', request.method, request.route?.path ?? 'unknown', error.code ?? error.name ?? 'Error')
    }
    response.status(error.status ?? 500).json({ error: error instanceof HttpError || error.expose ? error.message : error.type === 'entity.too.large' ? '请求数据过大' : '操作未完成，请检查官方服务配置与日志' })
  })
  application.use((_request, response) => response.status(404).json({ error: '接口不存在' }))
  server.on('upgrade', (request, socket, head) => {
    let address
    try { address = new URL(request.url ?? '/', 'http://localhost') } catch { return socket.destroy() }
    const ticketId = tokenHash(address.searchParams.get('ticket') ?? '')
    const ticket = tickets.get(ticketId)
    tickets.delete(ticketId)
    if (address.pathname !== '/tunnel' || request.headers.origin || !ticket || ticket.expires < Date.now() || !session(ticket.sessionHash) || [...active.values()].filter(item => item.userId === ticket.userId).length >= 8 || active.size >= 100) return socket.destroy()
    const shared = database.prepare('SELECT * FROM shares WHERE id=?').get(ticket.shareId)
    if (!shared) return socket.destroy()
    websocketServer.handleUpgrade(request, socket, head, websocket => {
      const id = randomUUID()
      const pending = { ...ticket, close: () => websocket.close() }
      active.set(id, pending)
      websocket.on('close', () => active.delete(id))
      void withTarget(async () => {
        const metadata = JSON.parse(shared.metadata)
        const endpoint = await resolveTarget(metadata.host, metadata.port)
        if (websocket.readyState !== 1) return
        if (!session(ticket.sessionHash) || !database.prepare('SELECT id FROM shares WHERE id=?').get(shared.id)) return websocket.close()
        pending.close = startGateway(websocket, { metadata, endpoint, credential: open(shared.credential, 'share:' + shared.id), hostKey: shared.host_key, dimensions: ticket.dimensions, guacd,
          stillAuthorized: () => !!session(ticket.sessionHash) && !!database.prepare('SELECT id FROM shares WHERE id=?').get(shared.id), onClose: () => active.delete(id) })
      }).catch(() => { websocket.close(1011); active.delete(id) })
    })
  })
  const cleanup = setInterval(() => {
    const now = Date.now()
    for (const [key, record] of rates) if (record.expires < now) rates.delete(key)
    for (const [key, record] of tickets) if (record.expires < now) tickets.delete(key)
    gitlab.cleanup()
    database.prepare('DELETE FROM sessions WHERE expires_at<?').run(now)
  }, 30000)
  cleanup.unref()
  return { server, storage, close: async () => {
    clearInterval(cleanup)
    gitlab.close()
    for (const item of [...active.values()]) item.close()
    websocketServer.close()
    server.closeAllConnections()
    await new Promise(resolveClose => server.close(resolveClose))
    storage.close()
  } }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const service = createOfficialServer({ directory: resolve(process.env.OFFICIAL_DATA_DIR ?? 'official-data') })
  const host = process.env.OFFICIAL_HOST ?? '127.0.0.1'
  const port = Number(process.env.OFFICIAL_PORT ?? 47830)
  service.server.listen(port, host, () => console.log(`OmniDesk official service listening on ${host}:${port}`))
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => void service.close().then(() => process.exit(0)))
}
