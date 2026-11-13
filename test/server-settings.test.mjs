import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createOfficialServer } from '../server.mjs'
import { createAccount } from '../admin-accounts.mjs'

const password = 'QA-settings-admin-password'
const clientSecret = 'QA-settings-provider-secret'
const gitlab = { enabled: true, issuer: 'https://gitlab.example.com', clientId: 'qa-settings-client', redirectUri: 'https://account.example.com/v1/auth/gitlab/callback', clientSecret }
async function fixture(context) {
  const directory = mkdtempSync(join(tmpdir(), 'omnidesk-web-settings-'))
  let service = createOfficialServer({ directory })
  context.after(() => service.close())
  await createAccount(service.storage, { username: 'qa_admin', password })
  const listen = async () => { service.server.listen(0, '127.0.0.1'); await once(service.server, 'listening') }
  await listen()
  const api = async (path, method = 'GET', body, token) => {
    const response = await fetch('http://127.0.0.1:' + service.server.address().port + '/v1' + path, { method, headers: { Connection: 'close', 'X-OmniDesk-Admin': '1', ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: 'Bearer ' + token } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
    return { status: response.status, data: await response.json() }
  }
  const login = await api('/auth/login', 'POST', { username: 'qa_admin', password })
  return { api, token: login.data.token, directory, get service() { return service }, restart: async () => { await service.close(); service = createOfficialServer({ directory, registration: true, gitlab: { issuer: 'https://ignored.example.com' } }); await listen() } }
}

test('Web settings are admin only, validate atomically and never return encrypted or plaintext secrets', async context => {
  const f = await fixture(context), { api, token } = f
  await createAccount(f.service.storage, { username: 'qa_member', password }, (await api('/me', 'GET', undefined, token)).data.id)
  const member = (await api('/auth/login', 'POST', { username: 'qa_member', password })).data.token
  for (const path of ['/admin/settings', '/admin/auth-diagnostics']) {
    assert.equal((await api(path)).status, 401)
    assert.equal((await api(path, 'GET', undefined, member)).status, 403)
  }
  assert.equal((await api('/admin/settings', 'PUT', { registrationOpen: true, gitlab }, member)).status, 403)
  const initial = (await api('/admin/settings', 'GET', undefined, token)).data
  const invalid = await api('/admin/settings', 'PUT', { registrationOpen: true, gitlab: { ...gitlab, redirectUri: 'https://invalid.example.com/wrong' }, revision: initial.revision }, token)
  assert.equal(invalid.status, 400)
  assert.deepEqual((await api('/admin/settings', 'GET', undefined, token)).data, initial)
  const saved = await api('/admin/settings', 'PUT', { registrationOpen: false, gitlab, revision: initial.revision }, token)
  assert.equal(saved.status, 200)
  assert.equal(saved.data.gitlab.secretConfigured, true)
  assert.equal('clientSecret' in saved.data.gitlab, false)
  assert(!JSON.stringify(saved.data).includes(clientSecret))
  const stored = JSON.parse(f.service.storage.database.prepare('SELECT value FROM settings WHERE key=?').get('gitlab').value)
  assert(!stored.clientSecret.includes(clientSecret))
  assert.equal(f.service.storage.open(stored.clientSecret, 'gitlab-client-secret'), clientSecret)
  assert.deepEqual((await api('/auth/providers')).data.gitlab, { enabled: true, issuer: gitlab.issuer })
  // A stale browser must not overwrite either registration policy or the provider.
  assert.equal((await api('/admin/settings', 'PUT', { registrationOpen: true, gitlab: { ...gitlab, enabled: false }, revision: initial.revision }, token)).status, 409)
  assert.deepEqual((await api('/admin/settings', 'GET', undefined, token)).data, saved.data)
  const { clientSecret: omitted, ...withoutSecret } = gitlab
  const kept = await api('/admin/settings', 'PUT', { registrationOpen: false, gitlab: { ...withoutSecret, clientSecret: '' }, revision: saved.data.revision }, token)
  assert.equal(kept.status, 200)
  assert.equal(kept.data.revision, saved.data.revision)
  assert.equal(JSON.parse(f.service.storage.database.prepare('SELECT value FROM settings WHERE key=?').get('gitlab').value).clientSecret, stored.clientSecret)
  for (const changed of [{ issuer: 'https://another.example.com' }, { clientId: 'new-application' }]) {
    assert.equal((await api('/admin/settings', 'PUT', { registrationOpen: true, gitlab: { ...withoutSecret, ...changed }, revision: kept.data.revision }, token)).status, 400)
  }
  assert.deepEqual((await api('/admin/settings', 'GET', undefined, token)).data, kept.data)
  const key = readFileSync(join(f.directory, 'server-master.key'))
  await f.restart()
  assert.deepEqual((await api('/admin/settings', 'GET', undefined, token)).data, kept.data)
  assert.deepEqual(readFileSync(join(f.directory, 'server-master.key')), key)
})

test('saving unchanged GitLab settings keeps pending OAuth; changing provider invalidates old flows', async context => {
  const { api, token } = await fixture(context)
  assert.equal((await api('/admin/settings', 'PUT', { registrationOpen: false, gitlab }, token)).status, 200)
  const flow = (await api('/auth/gitlab/start', 'POST', { mode: 'login' })).data
  const { clientSecret: omitted, ...unchanged } = gitlab
  const settings = (await api('/admin/settings', 'GET', undefined, token)).data
  assert.equal((await api('/admin/settings', 'PUT', { registrationOpen: true, gitlab: unchanged, revision: settings.revision }, token)).status, 200)
  const poll = () => api('/auth/gitlab/poll', 'POST', { id: flow.id, secret: flow.secret })
  assert.deepEqual((await poll()).data, { state: 'pending' })
  const revision = (await api('/admin/settings', 'GET', undefined, token)).data.revision
  assert.equal((await api('/admin/settings', 'PUT', { registrationOpen: true, gitlab: { ...unchanged, enabled: false }, revision }, token)).status, 200)
  assert.equal((await poll()).status, 410)
  assert.deepEqual((await api('/auth/providers')).data.gitlab, { enabled: false })
})
