import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createOfficialServer } from '../server.mjs'
import { createAccount } from '../admin-accounts.mjs'
import { authorizeGitlab, createGitlabFixture, syntheticClientId, syntheticClientSecret } from './gitlab-fixture.mjs'

async function fixture(context) {
  const provider = await createGitlabFixture()
  const errors = []
  const service = createOfficialServer({ directory: mkdtempSync(join(tmpdir(), 'omnidesk-admin-gitlab-')), registration: true, onError: error => errors.push(error) })
  context.after(async () => { await service.close(); await provider.close(); assert.deepEqual(errors, []) })
  service.server.listen(0, '127.0.0.1'); await once(service.server, 'listening')
  const origin = 'http://127.0.0.1:' + service.server.address().port
  const { database, seal } = service.storage
  const configuration = { enabled: true, issuer: provider.origin, clientId: syntheticClientId, clientSecret: seal(syntheticClientSecret, 'gitlab-client-secret'), redirectUri: origin + '/v1/auth/gitlab/callback' }
  database.prepare('UPDATE settings SET value=? WHERE key=?').run(JSON.stringify(configuration), 'gitlab')
  const admin = await createAccount(service.storage, { username: 'qa_admin', password: 'QA-local-admin-password' })
  database.prepare('INSERT INTO gitlab_identities VALUES (?, ?, ?, ?)').run(provider.origin, '101', admin.id, 'qa_gitlab')
  const api = async (path, body, options = {}) => {
    const response = await fetch(origin + '/v1' + path, { method: body === undefined ? 'GET' : 'POST', redirect: 'manual', headers: { Connection: 'close', 'X-OmniDesk-Admin': '1', Origin: origin, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(options.cookie ? { Cookie: options.cookie } : {}), ...options.headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    return { status: response.status, data: await response.json(), headers: response.headers }
  }
  const start = async (view = 'shares', headers) => {
    const result = await api('/admin/auth/gitlab/start', { view }, { headers })
    assert.equal(result.status, 200)
    assert.deepEqual(Object.keys(result.data).sort(), ['authorizationUrl', 'expiresAt', 'id'])
    return { ...result.data, cookie: result.headers.get('set-cookie').split(';')[0], setCookie: result.headers.get('set-cookie') }
  }
  const callback = async flow => {
    const browser = await authorizeGitlab(flow.authorizationUrl, flow.cookie)
    const result = await fetch(browser.callback, { redirect: 'manual', headers: { Cookie: browser.cookie, Connection: 'close' } })
    assert.equal(result.status, 303)
    assert.equal(result.headers.get('referrer-policy'), 'no-referrer')
    assert.equal(result.headers.get('location'), origin + '/admin/#shares')
    return browser
  }
  const complete = flow => api('/admin/auth/gitlab/complete', { id: flow.id }, { cookie: flow.cookie })
  return { ...service, provider, database, admin, origin, api, start, callback, complete, configuration }
}

test('Web GitLab login gives bound administrator a browser-only session and preserves password login', async context => {
  const f = await fixture(context)
  const configuration = f.database.prepare('SELECT value FROM settings WHERE key=?').get('gitlab').value
  const flow = await f.start()
  assert.match(flow.setCookie, /HttpOnly/)
  assert.match(flow.setCookie, /SameSite=Lax/)
  assert.match(flow.setCookie, /Path=\/v1;/)
  assert(!flow.setCookie.includes('; Secure'))
  assert.equal((await f.complete(flow)).data.state, 'pending')
  const browser = await f.callback(flow)
  const result = await f.complete(flow)
  assert.equal(result.status, 200)
  assert.equal(result.data.user.id, f.admin.id)
  assert.deepEqual(Object.keys(result.data).sort(), ['expiresAt', 'user'])
  assert.equal(result.data.user.role, 'admin')
  const cookies = result.headers.getSetCookie()
  assert(cookies.some(value => /_gitlab_.*Max-Age=0/.test(value)))
  const sessionCookie = cookies.find(value => value.startsWith('omnidesk_admin_http='))
  assert.match(sessionCookie, /HttpOnly/)
  assert.match(sessionCookie, /SameSite=Strict/)
  assert.match(sessionCookie, /Max-Age=43200/)
  const cookie = sessionCookie.split(';')[0]
  assert.equal((await f.api('/admin/me', undefined, { cookie })).data.id, f.admin.id)
  assert.equal((await f.api('/me', undefined, { cookie })).status, 401)
  assert.equal((await f.complete(flow)).status, 410)
  const replay = await fetch(browser.callback, { redirect: 'manual', headers: { Cookie: browser.cookie, Connection: 'close' } })
  assert.equal(replay.status, 400)
  assert.equal(f.database.prepare('SELECT count(*) AS n FROM sessions').get().n, 1)
  const password = await f.api('/admin/login', { username: 'qa_admin', password: 'QA-local-admin-password' })
  assert.equal(password.status, 200)
  assert.equal(password.data.user.id, f.admin.id)
  assert.equal(f.database.prepare('SELECT value FROM settings WHERE key=?').get('gitlab').value, configuration)
})

test('Web GitLab login denies ordinary, unknown and disabled identities without creating or binding users', async context => {
  const f = await fixture(context)
  const member = await createAccount(f.storage, { username: 'qa_member', password: 'QA-local-member-password', role: 'user' }, f.admin.id)
  f.database.prepare('INSERT INTO gitlab_identities VALUES (?, ?, ?, ?)').run(f.provider.origin, '102', member.id, 'qa_member')
  const before = JSON.stringify(f.database.prepare('SELECT * FROM gitlab_identities ORDER BY subject').all())
  for (const subject of ['102', 'unknown', '101']) {
    if (subject === '101') f.database.prepare('UPDATE users SET disabled=1 WHERE id=?').run(f.admin.id)
    f.provider.setProfile({ sub: subject, preferred_username: subject === 'unknown' ? 'qa_admin' : 'renamed_user' })
    const flow = await f.start(); await f.callback(flow)
    const result = await f.complete(flow)
    assert.equal(result.status, 403)
    assert.match(result.data.error, /管理员/)
    assert(!result.headers.getSetCookie().some(value => /^omnidesk_admin_http=/.test(value)))
    assert.equal((await f.complete(flow)).status, 410)
  }
  assert.equal(f.database.prepare('SELECT count(*) AS n FROM users').get().n, 2)
  assert.equal(f.database.prepare('SELECT count(*) AS n FROM sessions').get().n, 0)
  assert.equal(JSON.stringify(f.database.prepare('SELECT * FROM gitlab_identities ORDER BY subject').all()), before)
})

test('Web GitLab proof, origin, expiry, cancellation and desktop protocol are isolated', async context => {
  const f = await fixture(context)
  const path = '/admin/auth/gitlab/'
  assert.equal((await f.api(path + 'start', {}, { headers: { 'X-OmniDesk-Admin': '' } })).status, 403)
  assert.equal((await f.api(path + 'start', {}, { headers: { Origin: '' } })).status, 403)
  assert.equal((await f.api(path + 'start', {}, { headers: { Origin: 'https://attacker.invalid' } })).status, 403)
  assert.equal((await f.api(path + 'start', {}, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403)
  const flow = await f.start()
  const body = { id: flow.id }
  const copied = await fetch(flow.authorizationUrl, { redirect: 'manual', headers: { Connection: 'close' } })
  assert.equal(copied.status, 400)
  assert.equal(copied.headers.get('location'), null)
  assert.match(await copied.text(), /同一浏览器/)
  assert.equal((await f.complete(flow)).data.state, 'pending')
  assert.equal((await f.api(path + 'complete', body)).status, 401)
  assert.equal((await f.api(path + 'complete', body, { cookie: flow.cookie.replace(/=.+$/, '=' + 'x'.repeat(43)) })).status, 401)
  assert.equal((await f.api(path + 'complete', body, { cookie: flow.cookie, headers: { Origin: f.origin.replace('http:', 'https:') } })).status, 401)
  const secret = flow.cookie.split('=')[1]
  for (const action of ['poll', 'cancel']) assert.equal((await f.api('/auth/gitlab/' + action, { ...body, secret })).status, 401)
  await f.callback(flow)
  assert.equal((await f.complete(flow)).status, 200)
  const desktop = await f.api('/auth/gitlab/start', { mode: 'login' })
  const forgedCookie = 'omnidesk_admin_http_gitlab_' + desktop.data.id.slice(0, 16) + '=' + desktop.data.secret
  for (const action of ['complete', 'cancel']) assert.equal((await f.api(path + action, { id: desktop.data.id }, { cookie: forgedCookie })).status, 401)
  assert.equal((await f.api('/auth/gitlab/poll', { id: desktop.data.id, secret: desktop.data.secret })).data.state, 'pending')
  const canceled = await f.start()
  assert.equal((await f.api(path + 'cancel', { id: canceled.id }, { cookie: canceled.cookie })).status, 200)
  assert.equal((await f.complete(canceled)).status, 410)
  const expired = await f.start()
  const now = Date.now()
  context.mock.method(Date, 'now', () => now + 6 * 60 * 1000)
  try { assert.equal((await f.complete(expired)).status, 410) } finally { context.mock.restoreAll() }
})

test('provider refusal returns to Web with an actionable error and does not issue an administrator session', async context => {
  const f = await fixture(context)
  const flow = await f.start()
  const browser = await authorizeGitlab(flow.authorizationUrl, flow.cookie)
  const denied = new URL(browser.callback)
  denied.searchParams.delete('code'); denied.searchParams.set('error', 'access_denied')
  const result = await fetch(denied, { redirect: 'manual', headers: { Cookie: browser.cookie, Connection: 'close' } })
  assert.equal(result.status, 303)
  assert.equal(result.headers.get('location'), f.origin + '/admin/#shares')
  const failure = await f.complete(flow)
  assert.equal(failure.status, 400)
  assert.match(failure.data.error, /provider_denied/)
  assert.equal(f.database.prepare('SELECT count(*) AS n FROM sessions').get().n, 0)
})

test('HTTP Web login retains the configured HTTPS callback and secure proof cookies stay separate', async context => {
  const f = await fixture(context)
  f.configuration.redirectUri = 'https://127.0.0.1:45678/v1/auth/gitlab/callback'
  f.database.prepare('UPDATE settings SET value=? WHERE key=?').run(JSON.stringify(f.configuration), 'gitlab')
  const http = await f.start()
  assert(http.authorizationUrl.startsWith('https://127.0.0.1:45678/v1/auth/gitlab/authorize?'))
  assert(!http.setCookie.includes('; Secure'))
  const https = await f.start('shares', { Origin: f.origin.replace('http:', 'https:') })
  assert.match(https.setCookie, /^omnidesk_admin_gitlab_/)
  assert.match(https.setCookie, /; Secure/)
  assert.equal((await f.api('/admin/auth/gitlab/complete', { id: https.id }, { cookie: https.cookie })).status, 401)
})

test('Web GitLab start rejects a callback on another hostname before opening authorization', async context => {
  const f = await fixture(context)
  f.configuration.redirectUri = 'https://another-host.invalid/v1/auth/gitlab/callback'
  f.database.prepare('UPDATE settings SET value=? WHERE key=?').run(JSON.stringify(f.configuration), 'gitlab')
  const result = await f.api('/admin/auth/gitlab/start', {})
  assert.equal(result.status, 400)
  assert.match(result.data.error, /相同的主机/)
  assert.equal(result.headers.get('set-cookie'), null)
})
