import express from 'express'
import { fileURLToPath } from 'node:url'
import { passwordMatches } from './storage.mjs'

export const adminCookieName = request => request.socket.encrypted || request.headers['x-forwarded-proto'] === 'https' || request.headers.origin?.startsWith('https://') ? 'omnidesk_admin' : 'omnidesk_admin_http'
export const adminCookieToken = request => new RegExp(`(?:^|;\\s*)${adminCookieName(request)}=([A-Za-z0-9_-]{43})(?:;|$)`).exec(request.headers.cookie ?? '')?.[1]

export function requireAdminBrowserRequest(request) {
  if (request.headers['x-omnidesk-admin'] !== '1' || request.headers['sec-fetch-site'] === 'cross-site') throw Object.assign(new Error('管理请求校验失败，请从本服务管理页面操作'), { status: 403, expose: true })
}

export function sendAdminSession(request, response, user, loginResult) {
  const duration = 12 * 60 * 60 * 1000
  const result = loginResult(user, duration)
  const name = adminCookieName(request)
  response.cookie(name, result.token, { httpOnly: true, sameSite: 'strict', secure: name === 'omnidesk_admin', path: '/v1/admin', maxAge: duration })
  response.json({ user: result.user, expiresAt: result.expiresAt })
}

export function registerAdminConsole({ application, database, route, fail, rate, loginResult, publicUser }) {
  const directory = fileURLToPath(new URL('./public/', import.meta.url))
  application.get('/', (_request, response) => response.redirect(302, '/admin/'))
  application.get(/^\/admin$/, (_request, response) => response.redirect(302, '/admin/'))
  application.use('/admin/', (_request, response, next) => {
    response.set({ 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'", 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY' })
    next()
  }, express.static(directory, { dotfiles: 'deny', index: 'index.html', etag: false, maxAge: 0 }))
  let busy = 0
  application.post('/v1/admin/login', route(async (request, response) => {
    requireAdminBrowserRequest(request)
    rate('admin-login:' + request.socket.remoteAddress, 10)
    const { username, password } = request.body
    if (typeof username !== 'string' || !/^[a-zA-Z0-9_]{3,32}$/.test(username) || typeof password !== 'string' || password.length < 6 || password.length > 1024) fail(400, '请输入有效的管理员账号和密码')
    if (busy >= 4) fail(429, '登录服务繁忙，请稍后重试')
    busy++
    try {
      const user = database.prepare('SELECT * FROM users WHERE username=?').get(username.toLowerCase())
      if (!await passwordMatches(password, user) || user?.role !== 'admin' || user?.disabled) fail(401, '管理员账号或密码不正确，或账号已停用')
      sendAdminSession(request, response, user, loginResult)
    } finally { busy-- }
  }))
}
