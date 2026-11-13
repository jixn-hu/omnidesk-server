import { randomBytes, createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const digest = value => createHash('sha256').update(value).digest('hex')
const lifetime = 15 * 60 * 1000
const downloadPath = '/v1/monitor/install/windows/download'
const errors = {
  INSTALL_TICKET_EXPIRED: '安装命令已超过 15 分钟有效期，请在 OmniDesk 生成并复制新命令',
  INSTALL_TICKET_REPLACED: '此命令已被该节点的新命令替换，请复制最新命令后执行',
  INSTALL_TICKET_INVALID: '安装命令无法识别，可能内容不完整或服务已重启，请在 OmniDesk 生成并复制新命令',
  ACCOUNT_SESSION_INVALID: '生成命令的账号登录已失效，请重新登录后生成并复制新命令',
  INSTALL_NODE_CHANGED: '节点已删除或采集令牌已变更，请在 OmniDesk 生成并复制新命令',
  MONITOR_UNAVAILABLE: '监控模块暂时不可用，当前命令未失效，请在有效期内稍后重试'
}

// Only a fixed, server-built installer can be downloaded. Tickets are scoped to
// the issuing account session and node, and never contain a user session token.
export function registerMonitorInstall({ application, authenticate, route, storage, url, token, directory, fetcher = fetch, now = Date.now }) {
  const tickets = new Map()
  const retired = new Map()
  let source
  const invalidate = (key, code) => {
    tickets.delete(key)
    // Keep only bounded reason records, without installer config or credentials.
    retired.set(key, { code, expiresAt: now() + lifetime })
    while (retired.size > 512) retired.delete(retired.keys().next().value)
  }
  const prune = () => {
    for (const [key, reason] of retired) if (reason.expiresAt <= now()) retired.delete(key)
    for (const [key, ticket] of tickets) if (ticket.expiresAt <= now()) invalidate(key, 'INSTALL_TICKET_EXPIRED')
  }
  const reject = (response, code, status = 410) => response.status(status).json({ error: errors[code], code })
  const rejectTicket = (response, key) => reject(response, retired.get(key)?.code ?? 'INSTALL_TICKET_INVALID')
  const sessionActive = ticket => storage.database.prepare('SELECT users.id FROM sessions JOIN users ON users.id=sessions.user_id WHERE sessions.token_hash=? AND sessions.expires_at>? AND users.disabled=0').get(ticket.sessionHash, now())?.id === ticket.account.id
  const checkNode = async (account, nodeId, agentToken) => {
    const response = await fetcher(url.replace(/\/$/, '') + '/v1/nodes/' + nodeId + '/installation-check', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token, 'X-OmniDesk-User': account.id },
      body: JSON.stringify({ token: agentToken }), redirect: 'error', signal: AbortSignal.timeout(15000)
    })
    if (!response.ok) return { status: [403, 404].includes(response.status) ? response.status : 502 }
    return { status: 200 }
  }
  const load = () => {
    if (source) return source
    const binary = readFileSync(join(directory, 'omnidesk-monitor-agent-windows-amd64.exe'))
    const template = readFileSync(join(directory, 'install-windows.ps1'), 'utf8')
    if (binary.subarray(0, 2).toString() !== 'MZ' || template.split('__OMNIDESK_BUNDLE__').length !== 2) throw new Error('Invalid Windows installer assets')
    return source = { binary: binary.toString('base64'), sha256: digest(binary), template }
  }
  const script = ticket => {
    const fixed = load()
    const bundle = Buffer.from(JSON.stringify({ config: ticket.config, sha256: fixed.sha256, binary: fixed.binary })).toString('base64')
    return Buffer.from('\ufeff' + fixed.template.replace('__OMNIDESK_BUNDLE__', bundle), 'utf8')
  }
  application.post('/v1/monitor/install/windows', authenticate, route(async (request, response) => {
    if (!url || !token || !directory) return response.status(503).json({ error: '服务端尚未提供 Windows 安装程序，请更新服务端或导出手动安装脚本' })
    if (Buffer.byteLength(JSON.stringify(request.body ?? {})) > 4096) return response.status(413).json({ error: '安装请求过大' })
    const { nodeId, token: agentToken, serverUrl, intervalSeconds = 60 } = request.body ?? {}
    let address
    try { address = new URL(serverUrl) } catch {}
    if (typeof nodeId !== 'string' || typeof serverUrl !== 'string' || !Number.isInteger(intervalSeconds) || intervalSeconds < 5 || intervalSeconds > 86400 || !/^[a-f0-9]{24}$/.test(nodeId ?? '') || typeof agentToken !== 'string' || !/^[a-zA-Z0-9_-]{24,128}$/.test(agentToken) || !address || !['http:', 'https:'].includes(address.protocol) || address.username || address.password || address.search || address.hash || address.pathname !== '/v1/monitor' || serverUrl.length > 2048) return response.status(400).json({ error: '无效的 Windows 安装参数' })
    prune()
    let checked
    try { load(); checked = await checkNode(request.account, nodeId, agentToken) } catch { return response.status(503).json({ error: 'Windows 安装程序暂不可用，请重试或导出手动安装脚本' }) }
    if ([403, 404].includes(checked.status)) return reject(response, 'INSTALL_NODE_CHANGED', checked.status)
    if (checked.status !== 200) return reject(response, 'MONITOR_UNAVAILABLE', 503)
    prune()
    const owned = [...tickets.values()].filter(item => item.account.id === request.account.id)
    if ((tickets.size >= 512 || owned.length >= 16) && !owned.some(item => item.nodeId === nodeId)) return response.status(429).json({ error: '安装请求过多，请稍后重试' })
    const ticket = {
      sessionHash: request.sessionHash, account: { id: request.account.id }, nodeId, expiresAt: now() + lifetime,
      config: { managedBy: 'omnidesk-monitor-windows-v1', nodeId, serverUrl, token: agentToken, statePath: '', intervalSeconds, includeNics: [], allowInsecure: address.protocol === 'http:', installationId: randomBytes(16).toString('hex') }
    }
    const bytes = script(ticket)
    // Regenerating revokes earlier commands, including ones already downloaded.
    for (const [key, item] of tickets) if (item.account.id === request.account.id && item.nodeId === nodeId) invalidate(key, 'INSTALL_TICKET_REPLACED')
    const code = randomBytes(32).toString('base64url')
    tickets.set(digest(code), ticket)
    response.status(201).json({ downloadPath, ticket: code, sha256: digest(bytes), expiresAt: ticket.expiresAt, installationId: ticket.config.installationId })
  }))
  application.head(downloadPath, (_request, response) => response.sendStatus(405))
  application.get(downloadPath, route(async (request, response) => {
    prune()
    const code = request.headers['x-omnidesk-install']
    const key = typeof code === 'string' && /^[A-Za-z0-9_-]{43}$/.test(code) ? digest(code) : ''
    const ticket = tickets.get(key)
    if (!ticket) return rejectTicket(response, key)
    if (!sessionActive(ticket)) { invalidate(key, 'ACCOUNT_SESSION_INVALID'); return rejectTicket(response, key) }
    let checked
    try { checked = await checkNode(ticket.account, ticket.nodeId, ticket.config.token) } catch { checked = { status: 503 } }
    // Recheck after the async validation: it may have expired or been replaced,
    // or the issuing session may have been revoked while the request was pending.
    prune()
    if (tickets.get(key) !== ticket) return rejectTicket(response, key)
    if (!sessionActive(ticket)) { invalidate(key, 'ACCOUNT_SESSION_INVALID'); return rejectTicket(response, key) }
    if ([403, 404].includes(checked.status)) { invalidate(key, 'INSTALL_NODE_CHANGED'); return rejectTicket(response, key) }
    if (checked.status !== 200) return reject(response, 'MONITOR_UNAVAILABLE', 503)
    // A download never consumes a valid ticket. Retries use the same fixed script
    // and SHA-256 until the deadline, regeneration, or credential revocation.
    response.set({ 'Cache-Control': 'no-store', 'Content-Disposition': 'attachment; filename="OmniDesk-Monitor-Install.ps1"', 'Referrer-Policy': 'no-referrer' }).type('application/octet-stream').send(script(ticket))
  }))
}
