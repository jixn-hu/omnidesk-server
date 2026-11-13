import { randomBytes } from 'node:crypto'
import { createAccount, requireAdministrator, updateAccount, validatePassword } from './admin-accounts.mjs'
import { passwordHash } from './storage.mjs'
import { adminCookieName } from './admin-console.mjs'

export function registerUserManagement({ application, storage, route, fail, active, tickets, publicUser }) {
  const { database } = storage
  const revoke = userId => {
    const hashes = new Set(database.prepare('SELECT token_hash FROM sessions WHERE user_id=?').all(userId).map(record => record.token_hash))
    database.prepare('DELETE FROM sessions WHERE user_id=?').run(userId)
    for (const [id, ticket] of tickets) if (hashes.has(ticket.sessionHash)) tickets.delete(id)
    for (const connection of active.values()) if (hashes.has(connection.sessionHash)) connection.close()
  }
  const find = id => {
    const user = database.prepare('SELECT * FROM users WHERE id=?').get(id)
    if (!user) fail(404, '用户不存在')
    return user
  }
  let hashing = 0
  application.get('/v1/admin/me', route((request, response) => {
    requireAdministrator(database, request.account.id)
    response.json(publicUser(request.account))
  }))
  application.post('/v1/admin/logout', route((request, response) => {
    requireAdministrator(database, request.account.id)
    database.prepare('DELETE FROM sessions WHERE token_hash=?').run(request.sessionHash)
    for (const connection of active.values()) if (connection.sessionHash === request.sessionHash) connection.close()
    response.clearCookie(adminCookieName(request), { path: '/v1/admin', httpOnly: true, sameSite: 'strict', secure: adminCookieName(request) === 'omnidesk_admin' })
    response.json({ ok: true })
  }))
  const withHashing = async operation => {
    if (hashing >= 4) fail(429, '账号服务繁忙，请稍后重试')
    hashing++
    try { return await operation() } finally { hashing-- }
  }
  application.post('/v1/admin/users', route(async (request, response) => {
    requireAdministrator(database, request.account.id)
    const user = await withHashing(() => createAccount(storage, request.body, request.account.id))
    response.status(201).json(publicUser(user))
  }))
  application.patch('/v1/admin/users/:id', route((request, response) => {
    requireAdministrator(database, request.account.id)
    const previous = find(request.params.id)
    const user = updateAccount(database, request.account.id, request.params.id, request.body)
    if (user.disabled || previous.role !== user.role) revoke(user.id)
    response.json({ ...publicUser(user), disabled: !!user.disabled })
  }))
  application.post('/v1/admin/users/:id/revoke-sessions', route((request, response) => {
    requireAdministrator(database, request.account.id)
    find(request.params.id)
    revoke(request.params.id)
    response.json({ ok: true })
  }))
  application.post('/v1/admin/users/:id/password', route(async (request, response) => {
    requireAdministrator(database, request.account.id)
    find(request.params.id)
    const salt = randomBytes(16).toString('hex')
    const hash = await withHashing(() => passwordHash(validatePassword(request.body.password), salt))
    database.exec('BEGIN IMMEDIATE')
    try {
      requireAdministrator(database, request.account.id)
      find(request.params.id)
      database.prepare('UPDATE users SET salt=?, password_hash=? WHERE id=?').run(salt, hash, request.params.id)
      database.exec('COMMIT')
    } catch (error) { database.exec('ROLLBACK'); throw error }
    revoke(request.params.id)
    response.json({ ok: true })
  }))
  application.delete('/v1/admin/users/:id', route((request, response) => {
    requireAdministrator(database, request.account.id)
    const user = find(request.params.id)
    if (user.id === request.account.id) fail(400, '不能删除当前登录的管理员')
    if (request.body?.confirmation !== user.username) fail(400, '请输入要删除的准确账号名以确认')
    const shareIds = new Set(database.prepare("SELECT id FROM shares WHERE owner_id=? AND coalesce(json_extract(metadata,'$.source'),'user')!='managed'").all(user.id).map(share => share.id))
    const hashes = new Set(database.prepare('SELECT token_hash FROM sessions WHERE user_id=?').all(user.id).map(record => record.token_hash))
    database.exec('BEGIN IMMEDIATE')
    try {
      const administrators = database.prepare("SELECT count(*) AS total FROM users WHERE role='admin' AND disabled=0").get().total
      if (user.role === 'admin' && !user.disabled && administrators <= 1) fail(409, '必须保留至少一名启用的管理员')
      database.prepare("UPDATE shares SET owner_id=? WHERE owner_id=? AND json_extract(metadata,'$.source')='managed'").run(request.account.id, user.id)
      database.prepare('DELETE FROM shares WHERE owner_id=?').run(user.id)
      database.prepare('DELETE FROM users WHERE id=?').run(user.id)
      database.exec('COMMIT')
    } catch (error) { database.exec('ROLLBACK'); throw error }
    for (const [id, ticket] of tickets) if (hashes.has(ticket.sessionHash) || shareIds.has(ticket.shareId)) tickets.delete(id)
    for (const connection of active.values()) if (hashes.has(connection.sessionHash) || shareIds.has(connection.shareId)) connection.close()
    response.json({ ok: true })
  }))
}
