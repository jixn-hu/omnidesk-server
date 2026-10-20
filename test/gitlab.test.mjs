import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createOfficialServer } from '../server.mjs'
import { createAccount } from '../admin-accounts.mjs'
import { createGitlabFixture, completeGitlab, syntheticClientId, syntheticClientSecret } from './gitlab-fixture.mjs'

test('GitLab honors closed registration and disabled accounts without changing existing identities', async context => {
  const directory = mkdtempSync(join(tmpdir(), 'omnidesk-gitlab-policy-'))
  const provider = await createGitlabFixture()
  const service = createOfficialServer({ directory })
  context.after(async () => { await service.close(); await provider.close() })
  service.server.listen(0, '127.0.0.1')
  await once(service.server, 'listening')
  const origin = 'http://127.0.0.1:' + service.server.address().port
  const api = async (path, method = 'GET', body, token) => {
    const response = await fetch(origin + '/v1' + path, { method, headers: { Connection: 'close', ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: 'Bearer ' + token } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
    return { status: response.status, data: await response.json() }
  }
  const administrator = await createAccount(service.storage, { username: 'qa_admin', password: 'QA-synthetic-admin-password' })
  const login = await api('/auth/login', 'POST', { username: 'qa_admin', password: 'QA-synthetic-admin-password' })
  const token = login.data.token
  const gitlab = { enabled: true, issuer: provider.origin, clientId: syntheticClientId, clientSecret: syntheticClientSecret, redirectUri: origin + '/v1/auth/gitlab/callback' }
  const save = registrationOpen => api('/admin/settings', 'PUT', { registrationOpen, gitlab }, token)
  const oauth = async (mode = 'login', memberToken) => {
    const flow = await api('/auth/gitlab/start', 'POST', { mode }, memberToken)
    assert.equal(flow.status, 200)
    await completeGitlab(flow.data.authorizationUrl)
    return api('/auth/gitlab/poll', 'POST', { id: flow.data.id, secret: flow.data.secret })
  }
  assert.equal((await save(false)).status, 200)
  assert.equal((await oauth()).status, 403)
  assert.equal(service.storage.database.prepare('SELECT count(*) AS total FROM users').get().total, 1)
  assert.equal((await save(true)).status, 200)
  const registered = await oauth()
  assert.equal(registered.status, 200)
  const member = registered.data.session
  assert.equal(member.user.role, 'user')
  assert.equal((await save(false)).status, 200)
  const existing = await oauth()
  assert.equal(existing.data.session.user.id, member.user.id)
  assert.equal(existing.data.session.syncKey, member.syncKey)
  const policy = { disabled: true }
  assert.equal((await api('/admin/users/' + member.user.id, 'PATCH', policy, token)).status, 200)
  assert.equal((await api('/me', 'GET', undefined, member.token)).status, 401)
  assert.equal((await oauth()).status, 403)
  assert.equal((await api('/admin/users/' + member.user.id, 'PATCH', { disabled: false }, token)).status, 200)
  assert.equal((await oauth()).data.session.user.id, member.user.id)
  provider.setProfile({ sub: '999', preferred_username: 'qa_new_gitlab' })
  assert.equal((await oauth()).status, 403)
  const memberLocal = await createAccount(service.storage, { username: 'qa_local', password: 'QA-synthetic-local-password' }, administrator.id)
  const localLogin = await api('/auth/login', 'POST', { username: 'qa_local', password: 'QA-synthetic-local-password' })
  assert.equal((await oauth('link', localLogin.data.token)).data.session.user.id, memberLocal.id)
  assert.equal((await api('/admin/users/' + memberLocal.id, 'PATCH', { disabled: true }, token)).status, 200)
  assert.equal((await oauth()).status, 403)
})
