import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { newToken, tokenHash } from './storage.mjs'
import { adminCookieName, requireAdminBrowserRequest, sendAdminSession } from './admin-console.mjs'

const tokenPattern = /^[A-Za-z0-9_-]{43}$/
const lifetime = 5 * 60 * 1000
const endpoint = (value, allowHttp = false) => {
  const url = new URL(value)
  if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && (allowHttp || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))))) throw new Error('GitLab 服务地址需使用 HTTPS，回调地址支持 HTTP 或 HTTPS')
  return url.href.replace(/\/$/, '')
}

class OAuthFailure extends Error {
  constructor(code, message) { super(message); this.code = code }
}

async function requestJson(url, options, stage) {
  let response
  try { response = await fetch(url, { ...options, headers: { Accept: 'application/json', ...options.headers }, redirect: 'error', signal: AbortSignal.timeout(15000) }) }
  catch (error) {
    const tls = ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY'].includes(error.cause?.code)
    throw new OAuthFailure(stage + (tls ? '_tls' : '_network'), tls ? '官方后台无法验证企业账号站点的 HTTPS 证书，请管理员修复证书信任链；不要改用 HTTP' : '官方后台访问企业账号服务失败或超时，请检查服务器 DNS、网络及反向代理')
  }
  try {
    const chunks = []
    let length = 0
    for await (const chunk of response.body) {
      length += chunk.byteLength
      if (length > 64 * 1024) throw new Error('GitLab 响应过大')
      chunks.push(Buffer.from(chunk))
    }
    let data
    try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new OAuthFailure(stage + '_response', '企业账号服务未返回 JSON，请检查 OAuth 接口地址及反向代理') }
    if (!response.ok) {
      const reasons = { invalid_client: 'Application ID 或 Secret 被企业账号服务拒绝，请管理员检查对应应用的凭据', invalid_grant: '授权码被拒绝：可能已使用、过期，或应用回调地址 / PKCE 校验不一致；请重新发起，仍失败时核对应用回调', invalid_scope: '应用没有所需的 openid / profile 权限，请管理员修改 GitLab 应用授权范围', access_denied: '用户未同意应用授权，或企业账号服务拒绝了该应用' }
      throw new OAuthFailure(stage + '_' + (Object.hasOwn(reasons, data?.error) ? data.error : 'http_' + response.status), Object.hasOwn(reasons, data?.error) ? reasons[data.error] : '企业账号服务拒绝请求，请管理员检查应用授权、接口和服务日志')
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('GitLab 响应无效')
    return data
  } finally { await response.body?.cancel().catch(() => {}) }
}

export function registerGitlabAuth({ application, database, seal, open, route, fail, rate, session, loginResult, registrationOpen, configuration }) {
  const supplied = configuration ?? { issuer: process.env.OFFICIAL_GITLAB_ISSUER ?? 'https://gitlab.com', clientId: process.env.OFFICIAL_GITLAB_CLIENT_ID, clientSecret: process.env.OFFICIAL_GITLAB_CLIENT_SECRET, redirectUri: process.env.OFFICIAL_GITLAB_REDIRECT_URI }
  if (!database.prepare('SELECT 1 FROM settings WHERE key=?').get('gitlab')) {
    database.prepare('INSERT INTO settings VALUES (?, ?)').run('gitlab', JSON.stringify({ enabled: !!(supplied.clientId && supplied.clientSecret && supplied.redirectUri), issuer: supplied.issuer ?? 'https://gitlab.com', clientId: supplied.clientId ?? '', redirectUri: supplied.redirectUri ?? '', clientSecret: supplied.clientSecret ? seal(supplied.clientSecret, 'gitlab-client-secret') : '' }))
  }
  const stored = () => JSON.parse(database.prepare('SELECT value FROM settings WHERE key=?').get('gitlab').value)
  const settings = () => { const value = stored(); return { enabled: value.enabled, issuer: value.issuer, clientId: value.clientId, redirectUri: value.redirectUri, secretConfigured: !!value.clientSecret } }
  const provider = () => { const value = stored(); return { enabled: value.enabled, ...(value.enabled ? { issuer: value.issuer } : {}) } }
  const prepareSettings = input => {
    if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.enabled !== 'boolean' || ['issuer', 'clientId', 'redirectUri'].some(name => typeof input[name] !== 'string' || input[name].length > 2048 || /[\0\r\n]/.test(input[name])) || (input.clientSecret !== undefined && (typeof input.clientSecret !== 'string' || input.clientSecret.length > 8192 || /[\0\r\n]/.test(input.clientSecret)))) fail(400, 'GitLab 设置格式不正确')
    const previous = stored()
    let issuer, redirectUri
    try {
      issuer = endpoint(input.issuer)
      redirectUri = input.redirectUri ? endpoint(input.redirectUri, true) : ''
      if (redirectUri && !redirectUri.endsWith('/v1/auth/gitlab/callback')) throw new Error('GitLab 回调地址必须以 /v1/auth/gitlab/callback 结尾')
    } catch { fail(400, '请填写有效的 HTTPS GitLab 地址，以及以 /v1/auth/gitlab/callback 结尾的 HTTP 或 HTTPS 回调地址') }
    const clientId = input.clientId.trim()
    if (previous.clientSecret && (issuer !== previous.issuer || clientId !== previous.clientId) && !input.clientSecret) fail(400, '修改 GitLab 服务或 Application ID 时，请同时填写对应的新 Secret')
    const clientSecret = input.clientSecret ? seal(input.clientSecret, 'gitlab-client-secret') : previous.clientSecret
    if (input.enabled && (!clientId || !clientSecret || !redirectUri)) fail(400, '开启 GitLab 登录前，请完整填写 Application ID、Secret 和回调地址')
    return JSON.stringify({ enabled: input.enabled, issuer, clientId, redirectUri, clientSecret })
  }
  const pending = new Map()
  const cleanup = () => { for (const [state, record] of pending) if (record.expiresAt <= Date.now()) pending.delete(state) }
  const find = state => {
    const record = typeof state === 'string' && tokenPattern.test(state) ? pending.get(state) : null
    if (!record || record.expiresAt <= Date.now()) fail(410, 'GitLab 登录已过期或取消，请重试')
    return record
  }
  const pollRecord = request => {
    const record = find(request.body.id)
    if (record.purpose !== 'desktop') fail(401, 'GitLab 登录校验失败')
    if (!tokenPattern.test(request.body.secret ?? '') || tokenHash(request.body.secret) !== record.secretHash) fail(401, 'GitLab 登录校验失败')
    return record
  }
  const cookieName = state => 'omnidesk_gitlab_' + state.slice(0, 16)
  const cookie = (state, value, maxAge, config) => `${cookieName(state)}=${value}; HttpOnly; SameSite=Lax; Path=${new URL(config.redirectUri).pathname}; Max-Age=${maxAge}${config.redirectUri.startsWith('https:') ? '; Secure' : ''}`
  const escape = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character])
  const failures = []
  const failure = (record, code, message) => {
    const event = { at: Date.now(), reference: record?.reference ?? randomBytes(6).toString('hex'), stage: record?.stage ?? 'callback', code, message }
    failures.push(event)
    if (failures.length > 50) failures.shift()
    console.warn('[official-oauth]', JSON.stringify(event))
    return event
  }
  const page = (response, success, error, record) => response.status(success ? 200 : 400).set({ 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'", 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY' }).send(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>OmniDesk · 企业账号授权</title><body style="margin:0;background:#10171d;color:#e2e8ed;font:16px system-ui;display:grid;place-items:center;min-height:100vh"><main style="max-width:560px;padding:40px"><p style="color:#fca326;letter-spacing:3px">OMNIDESK / OAUTH</p><h1>${success ? '企业账号授权已完成' : '企业账号授权未完成'}</h1><p style="line-height:1.8;color:#a5b3bd">${success ? '请返回发起登录的 OmniDesk 客户端完成登录。可以关闭此页面。' : escape(error?.message ?? '请回到 OmniDesk 重新发起登录，不要刷新旧回调页面。')}</p>${record?.purpose === 'admin' ? `<p><a style="color:#fca326" href="${escape(record.adminOrigin + '/admin/#' + record.returnView)}">返回 Web 管理台，取消后重新登录</a></p>` : ''}${error ? `<p style="font-size:12px;color:#a5b3bd">原因：${escape(error.code)} · 排查编号：${escape(error.reference)}</p>` : ''}<p style="font-size:12px;color:#a5b3bd">这是你配置的企业账号站点的 OAuth 授权，不是要求注册 GitLab.com。</p></main></body></html>`)
  const identityUser = record => {
    const config = record.config
    const identity = database.prepare('SELECT user_id FROM gitlab_identities WHERE issuer=? AND subject=?').get(config.issuer, record.profile.sub)
    let userId = identity?.user_id
    database.exec('BEGIN IMMEDIATE')
    try {
      if (record.linkSessionHash) {
        const account = session(record.linkSessionHash)
        if (!account || account.id !== record.linkUserId) fail(401, '绑定期间原账号已退出，请重新登录后绑定')
        if (userId && userId !== account.id) fail(409, '该 GitLab 身份已绑定其他官方账号，不会自动合并账号')
        const linked = database.prepare('SELECT subject FROM gitlab_identities WHERE issuer=? AND user_id=?').get(config.issuer, account.id)
        if (linked && linked.subject !== record.profile.sub) fail(409, '当前账号已绑定另一个 GitLab 身份')
        userId = account.id
      } else if (!userId) {
        if (!registrationOpen()) fail(403, '管理员已关闭新账号注册；已有 GitLab 账号仍可登录')
        userId = randomUUID()
        const suffix = tokenHash(config.issuer + '\0' + record.profile.sub).slice(0, 8)
        const slug = record.profile.username.toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 16) || 'user'
        const name = `gitlab_${slug}_${suffix}`
        const role = database.prepare('SELECT 1 FROM users LIMIT 1').get() ? 'user' : 'admin'
        database.prepare('INSERT INTO users (id, username, salt, password_hash, sync_key, created_at, role) VALUES (?, ?, ?, ?, ?, ?, ?)').run(userId, name, randomBytes(16).toString('hex'), randomBytes(32).toString('hex'), seal(newToken(), 'sync:' + userId), Date.now(), role)
      }
      if (database.prepare('SELECT disabled FROM users WHERE id=?').get(userId)?.disabled) fail(403, '该账号已被停用，请联系管理员')
      database.prepare('INSERT INTO gitlab_identities VALUES (?, ?, ?, ?) ON CONFLICT(issuer, subject) DO UPDATE SET username=excluded.username').run(config.issuer, record.profile.sub, userId, record.profile.username)
      database.exec('COMMIT')
      return database.prepare('SELECT * FROM users WHERE id=?').get(userId)
    } catch (error) { database.exec('ROLLBACK'); throw error }
  }
  const startRecord = (request, purpose, details = {}) => {
    const saved = stored()
    if (!saved.enabled) fail(503, '管理员尚未开启 GitLab 登录')
    const config = { ...saved, issuer: endpoint(saved.issuer), redirectUri: endpoint(saved.redirectUri, true), clientSecret: open(saved.clientSecret, 'gitlab-client-secret') }
    if (purpose === 'admin' && new URL(config.redirectUri).hostname !== new URL(details.adminOrigin).hostname) fail(400, 'Web GitLab 登录需使用与回调地址相同的主机，请通过回调地址对应的主机打开管理台；HTTP 和 HTTPS 可以不同')
    rate('gitlab-start:' + request.socket.remoteAddress, 20)
    cleanup()
    if (pending.size >= 1000) fail(503, 'GitLab 登录服务繁忙，请稍后重试')
    const id = newToken()
    const secret = newToken()
    const expiresAt = Date.now() + lifetime
    pending.set(id, { purpose, secretHash: tokenHash(secret), verifier: newToken(), expiresAt, stage: 'created', reference: randomBytes(6).toString('hex'), config, ...details })
    const url = new URL(config.redirectUri.replace(/callback$/, 'authorize'))
    url.searchParams.set('request', id)
    return { id, secret, expiresAt, authorizationUrl: url.href }
  }
  const adminOrigin = request => {
    requireAdminBrowserRequest(request)
    let origin
    try { origin = new URL(request.headers.origin) } catch { fail(403, '请从本服务管理页面发起 GitLab 登录') }
    if (origin.origin !== request.headers.origin || origin.host !== request.headers.host || !['http:', 'https:'].includes(origin.protocol)) fail(403, '请从本服务管理页面发起 GitLab 登录')
    return origin.origin
  }
  const adminProofName = (request, id) => adminCookieName(request) + '_gitlab_' + id.slice(0, 16)
  const adminProofCookie = (request, response, id, value, maxAge) => response.cookie(adminProofName(request, id), value, { httpOnly: true, sameSite: 'lax', secure: adminCookieName(request) === 'omnidesk_admin', path: '/v1', maxAge })
  const adminRecord = request => {
    const origin = adminOrigin(request)
    const record = find(request.body.id)
    const name = adminProofName(request, request.body.id)
    const proof = new RegExp(`(?:^|;\\s*)${name}=([A-Za-z0-9_-]{43})(?:;|$)`).exec(request.headers.cookie ?? '')?.[1]
    if (record.purpose !== 'admin' || origin !== record.adminOrigin || !proof || tokenHash(proof) !== record.secretHash) fail(401, 'GitLab 管理员登录校验失败，请在发起登录的浏览器重试')
    return record
  }
  const adminReturn = (response, record) => response.set('Referrer-Policy', 'no-referrer').redirect(303, record.adminOrigin + '/admin/#' + record.returnView)
  application.post('/v1/admin/auth/gitlab/start', route((request, response) => {
    const origin = adminOrigin(request)
    const returnView = ['users', 'shares', 'settings'].includes(request.body.view) ? request.body.view : 'users'
    const { secret, ...result } = startRecord(request, 'admin', { adminOrigin: origin, returnView })
    adminProofCookie(request, response, result.id, secret, lifetime)
    response.json(result)
  }))
  application.post('/v1/admin/auth/gitlab/complete', route((request, response) => {
    rate('gitlab-admin-complete:' + request.socket.remoteAddress, 240)
    const record = adminRecord(request)
    if (!['ready', 'failed'].includes(record.stage)) return response.json({ state: 'pending' })
    pending.delete(request.body.id)
    adminProofCookie(request, response, request.body.id, '', 0)
    if (record.stage === 'failed') fail(400, record.error)
    const user = database.prepare('SELECT users.* FROM users JOIN gitlab_identities ON gitlab_identities.user_id=users.id WHERE gitlab_identities.issuer=? AND gitlab_identities.subject=?').get(record.config.issuer, record.profile.sub)
    if (!user || user.role !== 'admin' || user.disabled) fail(403, '该 GitLab 账号未绑定启用的管理员账号，请联系管理员确认权限，或使用管理员账号密码登录')
    sendAdminSession(request, response, user, loginResult)
  }))
  application.post('/v1/admin/auth/gitlab/cancel', route((request, response) => {
    adminRecord(request)
    pending.delete(request.body.id)
    adminProofCookie(request, response, request.body.id, '', 0)
    response.json({ ok: true })
  }))
  application.post('/v1/auth/gitlab/start', route((request, response) => {
    if (!['login', 'link'].includes(request.body.mode)) fail(400, 'GitLab 登录操作无效')
    let linkSessionHash
    let linkUserId
    if (request.body.mode === 'link') {
      const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.authorization ?? '')?.[1]
      const account = token && session(tokenHash(token))
      if (!account) fail(401, '请先登录要绑定的官方账号')
      linkSessionHash = tokenHash(token); linkUserId = account.id
    }
    response.json(startRecord(request, 'desktop', { linkSessionHash, linkUserId }))
  }))
  application.get('/v1/auth/gitlab/authorize', route((request, response) => {
    const record = find(request.query.request)
    const config = record.config
    if (record.purpose === 'admin') {
      const name = (record.adminOrigin.startsWith('https:') ? 'omnidesk_admin' : 'omnidesk_admin_http') + '_gitlab_' + request.query.request.slice(0, 16)
      const proof = new RegExp(`(?:^|;\\s*)${name}=([A-Za-z0-9_-]{43})(?:;|$)`).exec(request.headers.cookie ?? '')?.[1]
      if (!proof || tokenHash(proof) !== record.secretHash) return page(response, false, failure(record, 'admin_browser_cookie', '请在发起 Web 登录的同一浏览器完成授权，不要复制授权链接到其他浏览器。返回管理台后重新登录。'), record)
    }
    if (record.stage !== 'created') fail(409, '该 GitLab 登录请求已使用，请重新发起')
    const browserSecret = newToken()
    record.browserHash = tokenHash(browserSecret); record.stage = 'authorizing'
    const url = new URL(config.issuer + '/oauth/authorize')
    for (const [name, value] of Object.entries({ client_id: config.clientId, redirect_uri: config.redirectUri, response_type: 'code', scope: 'openid profile', state: request.query.request, code_challenge: createHash('sha256').update(record.verifier).digest('base64url'), code_challenge_method: 'S256' })) url.searchParams.set(name, value)
    response.set('Set-Cookie', cookie(request.query.request, browserSecret, 300, config)).redirect(302, url.href)
  }))
  application.get('/v1/auth/gitlab/callback', route(async (request, response) => {
    rate('gitlab-callback:' + request.socket.remoteAddress, 120)
    let record
    try {
      record = find(request.query.state)
      const config = record.config
      const cookies = Object.fromEntries((request.headers.cookie ?? '').split(';').map(value => value.trim().split('=')))
      const proof = cookies[cookieName(request.query.state)]
      if (record.stage !== 'authorizing') return page(response, false, failure(record, 'request_used', '这次授权已处理或仍在交换授权码，请返回原客户端；重复刷新回调不会重新登录'), record)
      if (!tokenPattern.test(proof ?? '') || tokenHash(proof) !== record.browserHash) return page(response, false, failure(record, 'browser_cookie', '浏览器缺少授权校验 Cookie：请保持同一浏览器和同一官方服务地址，不要复制回调链接到另一浏览器；从客户端重新发起'), record)
      record.stage = 'exchanging'
      response.set('Set-Cookie', cookie(request.query.state, '', 0, config))
      if (request.query.error) throw new OAuthFailure(request.query.error === 'invalid_scope' ? 'invalid_scope' : 'provider_denied', request.query.error === 'invalid_scope' ? '应用缺少 openid / profile 授权范围，请管理员调整应用权限后重新发起' : '企业账号服务没有批准授权，请重新同意应用授权；如仍失败请检查应用权限')
      if (typeof request.query.code !== 'string' || !request.query.code.length || request.query.code.length > 4096) throw new OAuthFailure('missing_code', '回调没有有效授权码，请从 OmniDesk 客户端重新发起，不要直接打开回调地址')
      const token = await requestJson(config.issuer + '/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, code: request.query.code, grant_type: 'authorization_code', redirect_uri: config.redirectUri, code_verifier: record.verifier }) }, 'token')
      if (typeof token.access_token !== 'string' || !token.access_token.length || token.access_token.length > 8192 || /[\r\n]/.test(token.access_token)) throw new Error('GitLab 登录响应无效')
      record.stage = 'userinfo'
      const profile = await requestJson(config.issuer + '/oauth/userinfo', { headers: { Authorization: 'Bearer ' + token.access_token } }, 'userinfo')
      const username = profile.preferred_username || profile.nickname
      if (typeof profile.sub !== 'string' || !profile.sub.length || profile.sub.length > 256 || /[\0\r\n]/.test(profile.sub) || typeof username !== 'string' || !username.length || username.length > 256 || /[\0\r\n]/.test(username)) throw new OAuthFailure('userinfo_identity', '企业账号服务没有返回有效的 sub 和用户名，请检查 openid / profile 范围及 UserInfo 兼容性')
      record.profile = { sub: profile.sub, username }; record.stage = 'ready'
      if (record.purpose === 'admin') return adminReturn(response, record)
      return page(response, true)
    } catch (error) {
      const detail = failure(record, error instanceof OAuthFailure ? error.code : record ? 'invalid_response' : 'request_expired', error instanceof OAuthFailure ? error.message : record ? '授权响应格式不正确，请管理员检查企业账号 OAuth 接口' : '登录请求已过期、已取消或后台已重启。请回到 OmniDesk 重新发起，不要刷新旧回调页面')
      if (['exchanging', 'userinfo'].includes(record?.stage)) { record.stage = 'failed'; record.error = detail.message + '（' + detail.code + '，排查编号 ' + detail.reference + '）' }
      if (record?.purpose === 'admin' && record.stage === 'failed') return adminReturn(response, record)
      return page(response, false, detail, record)
    }
  }))
  application.post('/v1/auth/gitlab/poll', route((request, response) => {
    rate('gitlab-poll:' + request.socket.remoteAddress, 240)
    const record = pollRecord(request)
    if (record.stage === 'failed') { pending.delete(request.body.id); fail(400, record.error) }
    if (record.stage !== 'ready') return response.json({ state: 'pending' })
    pending.delete(request.body.id)
    response.json({ state: 'complete', session: loginResult(identityUser(record)) })
  }))
  application.post('/v1/auth/gitlab/cancel', route((request, response) => {
    pollRecord(request)
    pending.delete(request.body.id)
    response.json({ ok: true })
  }))
  return { provider, settings, prepareSettings, diagnostics: () => failures.slice().reverse(), invalidate: () => pending.clear(), cleanup, close: () => pending.clear() }
}
