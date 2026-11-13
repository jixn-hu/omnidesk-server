import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { createOfficialServer } from '../server.mjs'
import { createAccount } from '../admin-accounts.mjs'
import { normalizeSharedServer, readSharedServerImport } from '../shared-server-import.mjs'

const password = 'QA-shared-servers-password'
const configuration = (name = '团队 Linux', host = '192.0.2.10') => ({ kind: 'ssh', name, host, port: 22, username: 'ops', authMethod: 'password', group: '生产环境', note: '团队配置', tags: ['shared'] })
const payload = (config = configuration()) => ({ configuration: config, credential: { secret: 'synthetic-server-password' }, credentialDisclosure: true })
async function fixture(context) {
  const service = createOfficialServer({ directory: mkdtempSync(join(tmpdir(), 'omnidesk-shared-test-')) })
  const admin = await createAccount(service.storage, { username: 'qa_admin', password })
  const user = await createAccount(service.storage, { username: 'qa_user', password }, admin.id)
  service.server.listen(0, '127.0.0.1'); await once(service.server, 'listening')
  context.after(() => service.close())
  const origin = 'http://127.0.0.1:' + service.server.address().port
  const api = async (path, method = 'GET', body, token) => {
    const response = await fetch(origin + '/v1' + path, { method, headers: { Connection: 'close', ...(path.startsWith('/admin/') ? { 'X-OmniDesk-Admin': '1' } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: 'Bearer ' + token } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
    return { status: response.status, data: await response.json() }
  }
  const login = async username => (await api('/auth/login', 'POST', { username, password })).data.token
  const adminToken = await login('qa_admin'), userToken = await login('qa_user')
  return { ...service, admin, user, api, login, adminToken, userToken, asAdmin: (path, method, body) => api(path, method, body, adminToken) }
}

test('only administrators manage the entire shared directory; credentials remain encrypted and downloadable to clients', async context => {
  const f = await fixture(context)
  assert.equal((await f.api('/admin/shares')).status, 401)
  assert.equal((await f.api('/admin/shares', 'GET', undefined, f.userToken)).status, 403)
  for (const [path, method, body] of [['/admin/shares','POST',payload()], ['/admin/shares/import/preview','POST',{ contents: '[]' }], ['/admin/shares/import','POST',{}], ['/admin/shares/batch-delete','POST',{}], ['/admin/shares/invalid','GET'], ['/admin/shares/invalid','PATCH',{}], ['/admin/shares/invalid','DELETE',{}]]) {
    assert.equal((await f.api(path, method, body, f.userToken)).status, 403)
  }
  assert.equal((await f.asAdmin('/admin/shares', 'POST', { ...payload(), credentialDisclosure: false })).status, 400)
  assert.equal((await f.asAdmin('/admin/shares/batch-delete', 'POST', { items: [null], confirmation: 'DELETE' })).status, 400)
  assert.equal((await f.asAdmin('/admin/shares/import/preview', 'POST', {})).status, 400)
  const created = await f.asAdmin('/admin/shares', 'POST', payload())
  assert.equal(created.status, 201); assert.equal(created.data.source, 'managed')
  assert(!JSON.stringify(created.data).includes('synthetic-server-password'))
  const row = f.storage.database.prepare('SELECT * FROM shares WHERE id=?').get(created.data.id)
  assert(!row.credential.includes('synthetic-server-password')); assert(!row.metadata.includes('synthetic-server-password'))
  assert.equal((await f.asAdmin('/admin/shares', 'POST', payload(configuration('重复', '192.0.2.10:22')))).status, 409)
  const list = await f.asAdmin('/admin/shares?search=' + encodeURIComponent('生产环境'))
  assert.equal(list.data.total, 1); assert.equal(list.data.summary.managed, 1)
  assert(!JSON.stringify(list.data).includes('synthetic-server-password'))
  const shared = await f.api('/shares?search=' + encodeURIComponent('生产环境'), 'GET', undefined, f.userToken)
  assert.equal(shared.data.total, 1); assert.equal(shared.data.items[0].source, 'managed')
  const download = await f.api('/shares/' + created.data.id + '/configuration', 'GET', undefined, f.userToken)
  assert.equal(download.data.credential.secret, 'synthetic-server-password'); assert.deepEqual(download.data.configuration, created.data.configuration)
  assert.equal((await f.api('/shares/' + created.data.id, 'DELETE', undefined, f.adminToken)).status, 403)
  const modified = await f.asAdmin('/admin/shares/' + created.data.id, 'PATCH', { configuration: { ...configuration(), name: '新名称' }, updatedAt: created.data.updatedAt, credentialDisclosure: true })
  assert.equal(modified.status, 200); assert(modified.data.updatedAt > created.data.updatedAt)
  assert.equal((await f.api('/shares/' + created.data.id + '/configuration', 'GET', undefined, f.userToken)).data.credential.secret, 'synthetic-server-password')
  assert.equal((await f.asAdmin('/admin/shares/' + created.data.id, 'PATCH', { ...payload(), updatedAt: created.data.updatedAt })).status, 409)
  assert.equal((await f.asAdmin('/admin/shares/' + created.data.id, 'DELETE', { updatedAt: created.data.updatedAt })).status, 409)
  assert.equal((await f.asAdmin('/admin/shares/' + created.data.id, 'DELETE', { updatedAt: modified.data.updatedAt })).status, 200)
  assert.equal((await f.api('/shares/' + created.data.id + '/configuration', 'GET', undefined, f.userToken)).status, 404)
})

test('administrators edit user-owned shares without taking ownership and batch deletion is atomic on stale versions', async context => {
  const f = await fixture(context)
  const published = await f.api('/shares', 'POST', { ...payload(), sharingMode: 'copy' }, f.userToken)
  assert.equal(published.status, 201)
  const before = await f.asAdmin('/admin/shares/' + published.data.id)
  assert.equal(before.data.source, 'user'); assert.equal(before.data.owner, 'qa_user')
  const updated = await f.asAdmin('/admin/shares/' + published.data.id, 'PATCH', { ...payload({ ...configuration(), name: '管理员修订' }), updatedAt: before.data.updatedAt })
  assert.equal(updated.status, 200); assert.equal(updated.data.owner, 'qa_user')
  const other = await f.asAdmin('/admin/shares', 'POST', payload(configuration('其他服务器', '192.0.2.11')))
  const stale = await f.asAdmin('/admin/shares/batch-delete', 'POST', { items: [{ id: published.data.id, updatedAt: before.data.updatedAt }, { id: other.data.id, updatedAt: other.data.updatedAt }], confirmation: 'DELETE' })
  assert.equal(stale.status, 409); assert.equal(f.storage.database.prepare('SELECT count(*) AS total FROM shares').get().total, 2)
  const removed = await f.asAdmin('/admin/shares/batch-delete', 'POST', { items: [updated.data, other.data].map(({ id, updatedAt }) => ({ id, updatedAt })), confirmation: 'DELETE' })
  assert.equal(removed.data.deleted, 2)
})

test('import preview does not write or disclose secrets; errors block the whole import and duplicates preserve existing records', async context => {
  const f = await fixture(context)
  const entries = [payload(), { ...configuration('桌面', '192.0.2.12'), kind: 'rdp', port: 3389, password: 'exact-rdp-password', options: { engine: 'freerdp', securityMode: 'legacy', ignoreCertificate: false } }, payload(configuration('文件内重复', '192.0.2.10:22'))]
  const body = { contents: JSON.stringify({ servers: entries }), format: 'json', credentialDisclosure: true }
  const preview = await f.asAdmin('/admin/shares/import/preview', 'POST', body)
  assert.equal(preview.data.ready, 2); assert.equal(preview.data.skipped, 1)
  assert(!JSON.stringify(preview.data).includes('synthetic-server-password')); assert(!JSON.stringify(preview.data).includes('exact-rdp-password'))
  assert.equal(f.storage.database.prepare('SELECT count(*) AS total FROM shares').get().total, 0)
  const invalid = { ...body, contents: JSON.stringify([...entries, { ...configuration('错误'), port: 0, password: 'private-value' }]) }
  assert.equal((await f.asAdmin('/admin/shares/import/preview', 'POST', invalid)).data.errors, 1)
  assert.equal((await f.asAdmin('/admin/shares/import', 'POST', invalid)).status, 400)
  assert.equal(f.storage.database.prepare('SELECT count(*) AS total FROM shares').get().total, 0)
  const imported = await f.asAdmin('/admin/shares/import', 'POST', body)
  assert.equal(imported.status, 201); assert.deepEqual(imported.data, { imported: 2, skipped: 1 })
  assert.deepEqual((await f.asAdmin('/admin/shares/import', 'POST', body)).data, { imported: 0, skipped: 3 })
  const desktop = (await f.asAdmin('/admin/shares?kind=rdp&source=managed')).data.items[0]
  assert.deepEqual(desktop.configuration.options, { engine: 'freerdp', securityMode: 'legacy', ignoreCertificate: false })
  assert.equal((await f.asAdmin('/admin/shares?search=' + encodeURIComponent('%'))).data.total, 0)
  assert.equal((await f.asAdmin('/admin/shares?page=0.5')).status, 400)
})

test('CSV handles BOM, Chinese headers, quoted commas, multiline notes, and exact credential whitespace', () => {
  const rows = readSharedServerImport('\uFEFF协议,名称,主机,端口,用户名,密码,备注\r\nssh,"中文,服务器",[2001:db8::1]:2222,22,ops," secret ","第一行\n第二行"\r\n', 'csv')
  const normalized = normalizeSharedServer(rows[0])
  assert.equal(normalized.configuration.name, '中文,服务器'); assert.equal(normalized.configuration.note, '第一行\n第二行'); assert.equal(normalized.credential.secret, ' secret ')
  assert.equal(normalizeSharedServer(readSharedServerImport('kind,name,host,username,password\nssh,name,192.0.2.1,ops, final space ', 'csv')[0]).credential.secret, ' final space ')
  assert.throws(() => readSharedServerImport('host,host\na,b','csv'), /唯一/)
  assert.throws(() => readSharedServerImport('host,name\n"unclosed','csv'), /未闭合/)
  assert.throws(() => readSharedServerImport('host,name\na,b,c','csv'), /列数/)
  assert.throws(() => readSharedServerImport('[]'), /1–1000/)
})

test('deleting an administrator retains managed team servers and reassigns maintenance to the acting administrator', async context => {
  const f = await fixture(context)
  const second = await createAccount(f.storage, { username: 'qa_second', password, role: 'admin' }, f.admin.id)
  const token = await f.login(second.username)
  const created = await f.api('/admin/shares', 'POST', payload(), token)
  assert.equal(created.status, 201)
  assert.equal((await f.asAdmin('/admin/users/' + second.id, 'DELETE', { confirmation: second.username })).status, 200)
  const retained = await f.asAdmin('/admin/shares/' + created.data.id)
  assert.equal(retained.status, 200); assert.equal(retained.data.owner, 'qa_admin'); assert.equal(retained.data.source, 'managed')
  assert.equal((await f.api('/shares/' + created.data.id + '/configuration', 'GET', undefined, f.userToken)).data.credential.secret, 'synthetic-server-password')
})


test('batch metadata edits preserve ownership, credentials, RDP options and untouched servers; downloads and tag search agree', async context => {
  const f = await fixture(context)
  const first = (await f.asAdmin('/admin/shares', 'POST', payload())).data
  const second = (await f.api('/shares', 'POST', { ...payload({ ...configuration('成员桌面', '192.0.2.11'), kind: 'rdp', port: 3389, options: { engine: 'freerdp', securityMode: 'legacy', ignoreCertificate: false } }), sharingMode: 'copy' }, f.userToken)).data
  const third = (await f.asAdmin('/admin/shares', 'POST', payload(configuration('保持原值', '192.0.2.12')))).data
  const before = f.storage.database.prepare('SELECT * FROM shares ORDER BY id').all()
  const items = [first.id, second.id].map(id => { const row = before.find(row => row.id === id); return { id, updatedAt: row.updated_at } })
  const changes = { tags: { mode: 'add', values: [' 批量标签 ', 'shared', '批量标签'] }, note: { mode: 'append', value: '维护窗口' }, group: { mode: 'replace', value: '新分组' } }
  assert.equal((await f.api('/admin/shares/batch-metadata', 'POST', { items, changes }, f.userToken)).status, 403)
  assert.deepEqual((await f.asAdmin('/admin/shares/batch-metadata', 'POST', { items, changes })).data, { updated: 2 })
  for (const item of items) {
    const row = f.storage.database.prepare('SELECT * FROM shares WHERE id=?').get(item.id), previous = before.find(row => row.id === item.id)
    assert.equal(row.credential, previous.credential); assert.equal(row.owner_id, previous.owner_id); assert.equal(row.endpoint_key, previous.endpoint_key); assert.equal(row.host_key, previous.host_key)
    const oldConfig = JSON.parse(previous.metadata).configuration, metadata = JSON.parse(row.metadata)
    const expected = { tags: ['shared', '批量标签'], note: '团队配置\n维护窗口', group: '新分组' }
    for (const key of Object.keys(expected)) assert.deepEqual(metadata[key], expected[key])
    assert.deepEqual(metadata.configuration, { ...oldConfig, ...expected }); assert(row.updated_at > previous.updated_at)
    const downloaded = await f.api('/shares/' + item.id + '/configuration', 'GET', undefined, f.userToken)
    assert.deepEqual(downloaded.data.configuration, metadata.configuration); assert.equal(downloaded.data.credential.secret, 'synthetic-server-password')
  }
  assert.deepEqual(f.storage.database.prepare('SELECT * FROM shares WHERE id=?').get(third.id), before.find(row => row.id === third.id))
  assert.equal((await f.asAdmin('/admin/shares?search=' + encodeURIComponent('批量标签'))).data.total, 2)
  assert.equal((await f.api('/shares?search=' + encodeURIComponent('批量标签'), 'GET', undefined, f.userToken)).data.total, 2)
  for (const [changes, expected] of [
    [{ tags: { mode: 'remove', values: ['shared'] }, note: { mode: 'replace', value: '统一备注' } }, { tags: ['批量标签'], note: '统一备注', group: '新分组' }],
    [{ tags: { mode: 'replace', values: ['全新标签'] } }, { tags: ['全新标签'], note: '统一备注', group: '新分组' }],
    [{ tags: { mode: 'clear' }, note: { mode: 'clear' }, group: { mode: 'clear' } }, { tags: [], note: '', group: '' }]
  ]) {
    const current = (await f.asAdmin('/admin/shares/' + first.id)).data
    assert.equal((await f.asAdmin('/admin/shares/batch-metadata', 'POST', { items: [{ id: current.id, updatedAt: current.updatedAt }], changes })).status, 200)
    const result = (await f.asAdmin('/admin/shares/' + first.id)).data.configuration
    for (const key of Object.keys(expected)) assert.deepEqual(result[key], expected[key])
  }
})

test('batch metadata validation and stale revisions roll back the entire batch', async context => {
  const f = await fixture(context)
  const first = (await f.asAdmin('/admin/shares', 'POST', payload())).data
  const second = (await f.asAdmin('/admin/shares', 'POST', payload({ ...configuration('满标签', '192.0.2.11'), tags: Array.from({ length: 100 }, (_, i) => 'tag-' + i) }))).data
  const items = [first, second].map(({ id, updatedAt }) => ({ id, updatedAt }))
  const before = f.storage.database.prepare('SELECT * FROM shares ORDER BY id').all()
  const expectUnchanged = () => assert.deepEqual(f.storage.database.prepare('SELECT * FROM shares ORDER BY id').all(), before)
  const endpoint = '/admin/shares/batch-metadata'
  assert.equal((await f.asAdmin(endpoint, 'POST', { items: [items[0], { ...items[1], updatedAt: 0 }], changes: { note: { mode: 'append', value: '不应写入' } } })).status, 409); expectUnchanged()
  assert.equal((await f.asAdmin(endpoint, 'POST', { items: [items[0], { id: 'missing', updatedAt: 0 }], changes: { note: { mode: 'clear' } } })).status, 404); expectUnchanged()
  for (const changes of [{}, { credential: { secret: 'bad' } }, { tags: { mode: 'add', values: ['超出限制'] } }, { tags: { mode: 'replace', values: [] } }, { tags: { mode: 'remove', values: ['a\nb'] } }, { note: { mode: 'replace', value: '' } }, { note: { mode: 'append', value: 'a'.repeat(16384) } }, { group: { mode: 'replace', value: 'a\nb' } }, { group: { mode: 'bogus' } }]) {
    assert.equal((await f.asAdmin(endpoint, 'POST', { items, changes })).status, 400); expectUnchanged()
  }
  for (const invalid of [[], [items[0], items[0]], [{ ...items[0], updatedAt: '0' }]]) {
    assert.equal((await f.asAdmin(endpoint, 'POST', { items: invalid, changes: { tags: { mode: 'clear' } } })).status, 400); expectUnchanged()
  }
})

test('batch metadata keeps legacy gateway shares private and retains host keys', async context => {
  const f = await fixture(context)
  const created = (await f.asAdmin('/admin/shares', 'POST', payload())).data
  const row = f.storage.database.prepare('SELECT * FROM shares WHERE id=?').get(created.id)
  const metadata = JSON.parse(row.metadata)
  delete metadata.configuration; metadata.sharingMode = 'gateway'; delete metadata.source
  f.storage.database.prepare('UPDATE shares SET metadata=?, host_key=? WHERE id=?').run(JSON.stringify(metadata), 'synthetic-host-key', created.id)
  assert.equal((await f.asAdmin('/admin/shares/batch-metadata', 'POST', { items: [{ id: created.id, updatedAt: created.updatedAt }], changes: { tags: { mode: 'add', values: ['legacy'] } } })).status, 200)
  const after = f.storage.database.prepare('SELECT * FROM shares WHERE id=?').get(created.id)
  assert.equal(after.host_key, 'synthetic-host-key'); assert.equal(after.credential, row.credential); assert.equal(JSON.parse(after.metadata).sharingMode, 'gateway')
  assert.equal((await f.api('/shares/' + created.id + '/configuration', 'GET', undefined, f.userToken)).status, 409)
})
