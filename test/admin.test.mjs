import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import { createOfficialServer } from '../server.mjs'
import { createAccount } from '../admin-accounts.mjs'
import { openStorage } from '../storage.mjs'

const secret = 'QA-synthetic-account-password'
async function fixture(context, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'omnidesk-server-test-'))
  const errors = []
  const service = createOfficialServer({ directory, onError: error => errors.push(error), ...options })
  service.server.listen(0, '127.0.0.1')
  await once(service.server, 'listening')
  context.after(async () => { await service.close(); assert.deepEqual(errors, []) })
  const origin = 'http://127.0.0.1:' + service.server.address().port
  const api = async (path, { method = 'GET', body, token, cookie, browser = false, origin: suppliedOrigin, headers = {} } = {}) => {
    const response = await fetch(origin + path, { method, headers: { Connection: 'close', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(cookie ? { Cookie: cookie } : {}), ...(browser ? { 'X-OmniDesk-Admin': '1', Origin: suppliedOrigin ?? origin } : suppliedOrigin ? { Origin: suppliedOrigin } : {}), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    const content = await response.text()
    let data
    try { data = JSON.parse(content) } catch { data = content }
    return { status: response.status, data, headers: response.headers }
  }
  const login = async name => {
    const result = await api('/v1/auth/login', { method: 'POST', body: { username: name, password: secret } })
    assert.equal(result.status, 200)
    return result.data
  }
  const bootstrap = async () => {
    const user = await createAccount(service.storage, { username: 'qa_admin', password: secret })
    return { user, ...await login('qa_admin') }
  }
  return { ...service, directory, origin, api, login, bootstrap }
}

test('registration defaults closed; initial administrator requires local initialization', async context => {
  const service = await fixture(context)
  const { api } = service
  assert.equal((await api('/v1/auth/providers')).data.registrationOpen, false)
  assert.equal((await api('/v1/auth/register', { method: 'POST', body: { username: 'qa_public', password: secret } })).status, 403)
  const administrator = await service.bootstrap()
  assert.equal(administrator.user.role, 'admin')
  await assert.rejects(createAccount(service.storage, { username: 'qa_second', password: secret }), /已有用户/)
  const opened = await api('/v1/admin/settings', { method: 'PUT', token: administrator.token, body: { registrationOpen: true } })
  assert.equal(opened.data.registrationOpen, true)
  const registered = await api('/v1/auth/register', { method: 'POST', body: { username: 'qa_public', password: secret, role: 'admin' } })
  assert.equal(registered.status, 200)
  assert.equal(registered.data.user.role, 'user')
  await api('/v1/admin/settings', { method: 'PUT', token: administrator.token, body: { registrationOpen: false } })
  assert.equal((await service.login('qa_public')).user.role, 'user')
  assert.equal((await api('/v1/auth/register', { method: 'POST', body: { username: 'qa_blocked', password: secret } })).status, 403)
  assert.equal((await api('/v1/admin/settings', { token: registered.data.token })).status, 403)
})

test('web console uses protected HttpOnly cookie; client token and sync key never returned by console login', async context => {
  const service = await fixture(context)
  await service.bootstrap()
  const { api } = service
  const index = await api('/admin/')
  assert.equal(index.status, 200)
  assert(index.headers.get('content-security-policy').includes("script-src 'self'"))
  assert.equal(index.headers.get('x-frame-options'), 'DENY')
  assert.equal((await api('/admin/admin.js')).status, 200)
  assert.equal((await api('/admin/admin.css')).status, 200)
  const body = { username: 'qa_admin', password: secret }
  assert.equal((await api('/v1/admin/login', { method: 'POST', body })).status, 403)
  assert.equal((await api('/v1/admin/login', { method: 'POST', body, browser: true, origin: 'https://attacker.invalid' })).status, 403)
  const login = await api('/v1/admin/login', { method: 'POST', body, browser: true })
  assert.equal(login.status, 200)
  assert.equal(login.data.token, undefined)
  assert.equal(login.data.syncKey, undefined)
  const setCookie = login.headers.get('set-cookie')
  assert.match(setCookie, /HttpOnly/i)
  assert.match(setCookie, /SameSite=Strict/i)
  assert.match(setCookie, /Path=\/v1\/admin/)
  const cookie = setCookie.split(';')[0]
  assert.equal((await api('/v1/admin/me', { cookie, browser: true })).data.username, 'qa_admin')
  assert.equal((await api('/v1/admin/users', { cookie })).status, 403)
  assert.equal((await api('/v1/me', { cookie, browser: true })).status, 401)
  const https = await api('/v1/admin/login', { method: 'POST', body, browser: true, origin: service.origin.replace('http:', 'https:') })
  assert.match(https.headers.get('set-cookie'), /Secure/i)
  assert.equal((await api('/v1/admin/logout', { method: 'POST', body: {}, cookie, browser: true })).status, 200)
  assert.equal((await api('/v1/admin/me', { cookie, browser: true })).status, 401)
})

test('administrators create users while public registration is closed; permissions and public metadata are constrained', async context => {
  const service = await fixture(context)
  const administrator = await service.bootstrap()
  const { api } = service
  const created = await api('/v1/admin/users', { method: 'POST', token: administrator.token, body: { username: 'qa_member', password: secret } })
  assert.equal(created.status, 201)
  const member = await service.login('qa_member')
  for (const [path, method, body] of [['/v1/admin/users', 'POST', { username: 'qa_intruder', password: secret }], ['/v1/admin/users/' + created.data.id, 'PATCH', { role: 'admin' }], ['/v1/admin/users/' + administrator.user.id, 'DELETE', { confirmation: 'qa_admin' }], ['/v1/admin/users/' + administrator.user.id + '/password', 'POST', { password: secret }]]) assert.equal((await api(path, { method, token: member.token, body })).status, 403)
  assert.equal((await api('/v1/admin/users', { method: 'POST', token: administrator.token, body: { username: 'QA_MEMBER', password: secret } })).status, 409)
  assert.equal((await api('/v1/admin/users', { method: 'POST', token: administrator.token, body: { username: 'bad', password: 'short' } })).status, 400)
  const listing = await api('/v1/admin/users', { token: administrator.token })
  assert.equal(listing.data.total, 2)
  for (const item of listing.data.items) for (const property of ['password', 'password_hash', 'salt', 'sync_key', 'token', 'syncKey']) assert.equal(item[property], undefined)
  assert.equal((await api('/v1/admin/users?search=%25', { token: administrator.token })).data.total, 0)
  assert.equal((await api('/v1/admin/users?page=-1', { token: administrator.token })).status, 400)
  assert.equal((await api('/v1/admin/login', { method: 'POST', browser: true, body: { username: 'qa_member', password: secret } })).status, 401)
})

test('disable, enable, role changes and password resets revoke existing sessions without deleting configurations', async context => {
  const service = await fixture(context)
  const administrator = await service.bootstrap()
  const { api, storage } = service
  const user = await createAccount(storage, { username: 'qa_member', password: secret }, administrator.user.id)
  let member = await service.login('qa_member')
  const path = '/v1/admin/users/' + user.id
  storage.database.prepare('INSERT INTO configurations VALUES (?, ?, ?, ?)').run(user.id, 1, 'QA opaque encrypted configuration', Date.now())
  assert.equal((await api(path, { method: 'PATCH', token: administrator.token, body: { disabled: true } })).status, 200)
  assert.equal((await api('/v1/me', { token: member.token })).status, 401)
  assert.equal((await api('/v1/auth/login', { method: 'POST', body: { username: 'qa_member', password: secret } })).status, 403)
  await api(path, { method: 'PATCH', token: administrator.token, body: { disabled: false } })
  assert.equal((await api('/v1/me', { token: member.token })).status, 401)
  member = await service.login('qa_member')
  await api(path, { method: 'PATCH', token: administrator.token, body: { role: 'admin' } })
  assert.equal((await api('/v1/me', { token: member.token })).status, 401)
  member = await service.login('qa_member')
  assert.equal(member.user.role, 'admin')
  await api(path + '/password', { method: 'POST', token: administrator.token, body: { password: secret + '-changed' } })
  assert.equal((await api('/v1/me', { token: member.token })).status, 401)
  assert.equal((await api('/v1/auth/login', { method: 'POST', body: { username: 'qa_member', password: secret } })).status, 401)
  const changed = await api('/v1/auth/login', { method: 'POST', body: { username: 'qa_member', password: secret + '-changed' } })
  assert.equal(changed.status, 200)
  await api(path + '/revoke-sessions', { method: 'POST', token: administrator.token, body: {} })
  assert.equal((await api('/v1/me', { token: changed.data.token })).status, 401)
  assert.equal(storage.database.prepare('SELECT revision FROM configurations WHERE user_id=?').get(user.id).revision, 1)
})

test('self lockout is rejected; deleting a user requires exact confirmation and removes only their cloud data', async context => {
  const service = await fixture(context)
  const administrator = await service.bootstrap()
  const { api, storage } = service
  const own = '/v1/admin/users/' + administrator.user.id
  for (const body of [{ disabled: true }, { role: 'user' }]) assert.equal((await api(own, { method: 'PATCH', token: administrator.token, body })).status, 400)
  assert.equal((await api(own, { method: 'DELETE', token: administrator.token, body: { confirmation: 'qa_admin' } })).status, 400)
  const user = await createAccount(storage, { username: 'qa_member', password: secret }, administrator.user.id)
  const member = await service.login('qa_member')
  storage.database.prepare('INSERT INTO configurations VALUES (?, ?, ?, ?)').run(user.id, 1, 'QA encrypted', Date.now())
  const share = await api('/v1/shares', { method: 'POST', token: member.token, body: { sharingMode: 'copy', credentialDisclosure: true, configuration: { name: 'QA share', kind: 'rdp', host: '192.0.2.1', port: 3389, username: 'qa_remote', authMethod: 'password' }, credential: { secret: 'QA synthetic remote password' } } })
  assert.equal(share.status, 201)
  assert.equal((await api('/v1/admin/users/' + user.id, { method: 'DELETE', token: administrator.token, body: { confirmation: 'wrong' } })).status, 400)
  assert.equal((await api('/v1/admin/users/' + user.id, { method: 'DELETE', token: administrator.token, body: { confirmation: 'qa_member' } })).status, 200)
  assert.equal((await api('/v1/me', { token: member.token })).status, 401)
  for (const table of ['configurations', 'sessions']) assert.equal(storage.database.prepare('SELECT count(*) AS total FROM ' + table + ' WHERE user_id=?').get(user.id).total, 0)
  assert.equal(storage.database.prepare('SELECT count(*) AS total FROM shares WHERE owner_id=?').get(user.id).total, 0)
  assert.equal((await api('/v1/admin/users', { token: administrator.token })).data.total, 1)
})

test('restart preserves registration policy, password hashes and encryption key; migration is idempotent', async context => {
  const directory = mkdtempSync(join(tmpdir(), 'omnidesk-server-migration-'))
  let storage = openStorage(directory)
  const user = await createAccount(storage, { username: 'qa_admin', password: secret })
  storage.database.prepare('INSERT INTO settings VALUES (?,?)').run('registrationOpen', 'false')
  const key = readFileSync(join(directory, 'server-master.key'))
  storage.close()
  storage = openStorage(directory)
  try {
    const restored = storage.database.prepare('SELECT * FROM users WHERE id=?').get(user.id)
    assert.equal(restored.password_hash, user.password_hash)
    assert.equal(restored.disabled, 0)
    assert.equal(restored.role, 'admin')
    assert.deepEqual(readFileSync(join(directory, 'server-master.key')), key)
    assert.equal(storage.database.prepare('SELECT value FROM settings WHERE key=?').get('registrationOpen').value, 'false')
  } finally { storage.close() }
})

test('bootstrap CLI reads credentials from stdin, never prints passwords and refuses overwrite', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'omnidesk-server-cli-'))
  const run = async () => {
    const child = spawn(process.execPath, ['tools/create-admin.mjs', '--stdin-json'], { cwd: new URL('../', import.meta.url), env: { ...process.env, OFFICIAL_DATA_DIR: directory }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', chunk => { output += chunk })
    child.stderr.on('data', chunk => { output += chunk })
    child.stdin.end(JSON.stringify({ username: 'qa_cli_admin', password: secret }))
    const [code] = await once(child, 'close')
    assert(!output.includes(secret))
    return { code, output }
  }
  assert.equal((await run()).code, 0)
  const repeated = await run()
  assert.equal(repeated.code, 1)
  assert.match(repeated.output, /已有用户/)
})

test('user directory paginates and treats search wildcards as literal text', async context => {
  const service = await fixture(context)
  const administrator = await service.bootstrap()
  const database = service.storage.database
  const original = database.prepare('SELECT * FROM users WHERE id=?').get(administrator.user.id)
  const insert = database.prepare('INSERT INTO users (id, username, salt, password_hash, sync_key, created_at) VALUES (?, ?, ?, ?, ?, ?)')
  for (let index = 0; index < 54; index++) insert.run('qa-page-' + index, 'qa_page_' + String(index).padStart(2, '0'), original.salt, original.password_hash, 'QA synthetic encrypted key', index + Date.now())
  const first = await service.api('/v1/admin/users?page=0', { token: administrator.token })
  const second = await service.api('/v1/admin/users?page=1', { token: administrator.token })
  assert.equal(first.data.total, 55)
  assert.equal(first.data.items.length, 50)
  assert.equal(second.data.items.length, 5)
  assert.equal(new Set([...first.data.items, ...second.data.items].map(user => user.id)).size, 55)
  assert.equal((await service.api('/v1/admin/users?search=qa_page_', { token: administrator.token })).data.total, 54)
  assert.equal((await service.api('/v1/admin/users?search=%25', { token: administrator.token })).data.total, 0)
})
