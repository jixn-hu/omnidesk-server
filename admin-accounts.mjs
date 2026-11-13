import { randomBytes, randomUUID } from 'node:crypto'
import { newToken, passwordHash } from './storage.mjs'

const reject = (status, message) => { throw Object.assign(new Error(message), { status, expose: true }) }

export function requireAdministrator(database, id) {
  const account = database.prepare('SELECT id, role, disabled FROM users WHERE id=?').get(id)
  if (!account || account.role !== 'admin' || account.disabled) reject(403, '只有启用中的管理员可以管理用户')
}

export function validatePassword(value) {
  if (typeof value !== 'string' || value.length < 6 || value.length > 1024 || value.includes('\0')) reject(400, '账号密码需为 6–1024 个字符，不能包含空字符')
  return value
}

export async function createAccount(storage, input, administratorId) {
  if (typeof input?.username !== 'string' || !/^[a-zA-Z0-9_]{3,32}$/.test(input.username)) reject(400, '账号需为 3–32 位字母、数字或下划线')
  const name = input.username.toLowerCase()
  const role = input.role ?? 'user'
  if (!['user', 'admin'].includes(role)) reject(400, '用户角色不正确')
  if (administratorId) requireAdministrator(storage.database, administratorId)
  else if (storage.database.prepare('SELECT 1 FROM users LIMIT 1').get()) reject(409, '已有用户，请由现有管理员在管理后台创建账号')
  const salt = randomBytes(16).toString('hex')
  const hash = await passwordHash(validatePassword(input.password), salt)
  const id = randomUUID()
  const database = storage.database
  database.exec('BEGIN IMMEDIATE')
  try {
    if (administratorId) requireAdministrator(database, administratorId)
    else if (database.prepare('SELECT 1 FROM users LIMIT 1').get()) reject(409, '初始化已完成，不能重复创建初始管理员')
    database.prepare('INSERT INTO users (id, username, salt, password_hash, sync_key, created_at, role) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, name, salt, hash, storage.seal(newToken(), 'sync:' + id), Date.now(), administratorId ? role : 'admin')
    database.exec('COMMIT')
  } catch (error) {
    database.exec('ROLLBACK')
    if ((error.errcode & 255) === 19) reject(409, '该账号已存在')
    throw error
  }
  return database.prepare('SELECT * FROM users WHERE id=?').get(id)
}

export function updateAccount(database, administratorId, userId, input) {
  if (input.role !== undefined && !['user', 'admin'].includes(input.role)) reject(400, '用户角色不正确')
  if (input.disabled !== undefined && typeof input.disabled !== 'boolean') reject(400, '停用状态必须为布尔值')
  database.exec('BEGIN IMMEDIATE')
  try {
    requireAdministrator(database, administratorId)
    const user = database.prepare('SELECT * FROM users WHERE id=?').get(userId)
    if (!user) reject(404, '用户不存在')
    const role = input.role ?? user.role
    const disabled = input.disabled === undefined ? user.disabled : Number(input.disabled)
    if (userId === administratorId && (disabled || role !== 'admin')) reject(400, '不能停用或降级当前登录的管理员')
    const administrators = database.prepare("SELECT count(*) AS total FROM users WHERE role='admin' AND disabled=0").get().total
    if (user.role === 'admin' && !user.disabled && (disabled || role !== 'admin') && administrators <= 1) reject(409, '必须保留至少一名启用的管理员')
    database.prepare('UPDATE users SET role=?, disabled=? WHERE id=?').run(role, disabled, userId)
    database.exec('COMMIT')
    return database.prepare('SELECT * FROM users WHERE id=?').get(userId)
  } catch (error) { database.exec('ROLLBACK'); throw error }
}
