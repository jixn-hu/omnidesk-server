import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { xterminalFixture } from './fixtures/xterminal.mjs'
import fixtures from './fixtures/rdo.cjs'
import { createOfficialServer } from '../server.mjs'
import { createAccount } from '../admin-accounts.mjs'
import { readSharedServerDocument } from '../shared-server-import.mjs'


async function fixture(context) {
  const service = createOfficialServer({ directory: mkdtempSync(join(tmpdir(), 'omnidesk-desktop-import-test-')) })
  await createAccount(service.storage, { username: 'qa_import_admin', password: 'QA-synthetic-import-password' })
  service.server.listen(0, '127.0.0.1'); await once(service.server, 'listening')
  context.after(() => service.close())
  const origin = 'http://127.0.0.1:' + service.server.address().port
  let token
  const api = async (path, body, method = 'POST') => {
    const response = await fetch(origin + '/v1' + path, { method, headers: { 'Content-Type': 'application/json', 'X-OmniDesk-Admin': '1', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
    return { status: response.status, data: await response.json() }
  }
  token = (await api('/auth/login', { username: 'qa_import_admin', password: 'QA-synthetic-import-password' })).data.token
  return { ...service, api }
}

test('Web RDO upload uses PC rules, omits secrets from preview, preserves identity/group/options and skips duplicate endpoints', async context => {
  const f = await fixture(context)
  const bytes = fixtures.encodeNrbf(fixtures.fixture())
  const body = { format: 'rdo', contents: bytes.toString('base64'), credentialDisclosure: true }
  const preview = await f.api('/admin/shares/import/preview', body)
  assert.equal(preview.status, 200); assert.equal(preview.data.ready, 2); assert.equal(preview.data.skipped, 1); assert.equal(preview.data.errors, 0)
  const first = preview.data.items[0].configuration
  assert.equal(first.group, 'QA 生产 / QA Windows'); assert.equal(first.note, 'QA note\nsecond line'); assert.equal(first.username, 'QA\\qa-shared'); assert.equal(first.options.colorDepth, 16); assert.equal(first.options.ignoreCertificate, false)
  const visible = JSON.stringify(preview.data)
  for (const secret of [fixtures.PASSWORD, fixtures.UNICODE_PASSWORD, fixtures.CIPHER, fixtures.UNICODE_CIPHER]) assert(!visible.includes(secret))
  assert.equal(f.storage.database.prepare('SELECT count(*) AS n FROM shares').get().n, 0)
  const imported = await f.api('/admin/shares/import', { ...body, selectedIndices: [1, 3] })
  assert.equal(imported.status, 201); assert.deepEqual(imported.data, { imported: 2, skipped: 1 })
  const rows = f.storage.database.prepare('SELECT * FROM shares').all()
  const shared = rows.find(row => JSON.parse(row.metadata).name === 'QA shared')
  const config = await f.api('/shares/' + shared.id + '/configuration', undefined, 'GET')
  assert.equal(config.data.credential.secret, fixtures.UNICODE_PASSWORD)
  for (const row of rows) { assert(!row.metadata.includes(fixtures.PASSWORD)); assert(!row.credential.includes(fixtures.UNICODE_PASSWORD)) }
  assert.deepEqual((await f.api('/admin/shares/import', { ...body, selectedIndices: [1,3] })).data, { imported: 0, skipped: 3 })
})

test('Web XTerminal upload preserves both protocols, identities, keys and notes; locked credentials remain excluded; inferred addresses need explicit selection', async context => {
  const f = await fixture(context), directory = mkdtempSync(join(tmpdir(), 'omnidesk-xt-fixture-'))
  const path = xterminalFixture(directory), bytes = readFileSync(path)
  const before = readdirSync(tmpdir()).filter(name => name.startsWith('omnidesk-import-')).sort()
  const body = { format: 'xterminal', contents: bytes.toString('base64'), credentialDisclosure: true }
  const preview = await f.api('/admin/shares/import/preview', body)
  assert.equal(preview.status, 200); assert.equal(preview.data.ready, 3); assert.equal(preview.data.errors, 1)
  assert.equal(preview.data.items[0].configuration.group, 'QA 公司 / QA 应用'); assert.equal(preview.data.items[0].configuration.authMethod, 'privateKey')
  assert.equal(preview.data.items[2].requiresReview, true); assert.equal(preview.data.items[3].configuration.domain, 'QA')
  assert(preview.data.warnings.length >= 2)
  for (const secret of ['QA-synthetic-private-key','QA-key-passphrase','QA-xterminal-password','QA-cipher-not-a-password']) assert(!JSON.stringify(preview.data).includes(secret))
  assert.equal((await f.api('/admin/shares/import', body)).status, 400)
  assert.equal((await f.api('/admin/shares/import', { ...body, selectedIndices: [1, 2] })).status, 400)
  assert.equal(f.storage.database.prepare('SELECT count(*) AS n FROM shares').get().n, 0)
  const selected = await f.api('/admin/shares/import', { ...body, selectedIndices: [1, 4] })
  assert.equal(selected.status, 201); assert.deepEqual(selected.data, { imported: 2, skipped: 2 })
  const rows = (await f.api('/admin/shares', undefined, 'GET')).data.items
  const ssh = rows.find(row => row.configuration.kind === 'ssh')
  const downloaded = await f.api('/shares/' + ssh.id + '/configuration', undefined, 'GET')
  assert.equal(downloaded.data.credential.secret, 'QA-synthetic-private-key'); assert.equal(downloaded.data.credential.passphrase, 'QA-key-passphrase')
  assert.equal(downloaded.data.configuration.username, 'qa-key')
  assert.equal((await f.api('/admin/shares/import', { ...body, selectedIndices: [3] })).data.imported, 1)
  assert.deepEqual(readFileSync(path), bytes)
  assert.deepEqual(readdirSync(tmpdir()).filter(name => name.startsWith('omnidesk-import-')).sort(), before)
})

test('bad binary files, limits, selection tampering and unknown sources cannot write shared records', async context => {
  const f = await fixture(context)
  for (const [format, contents] of [['rdo', 'not base64!'], ['rdo', Buffer.from('not RDO').toString('base64')], ['xterminal', Buffer.from('not SQLite').toString('base64')], ['xterminal', Buffer.from('SQLite format 3\0garbage').toString('base64')]]) {
    assert.equal((await f.api('/admin/shares/import/preview', { format, contents })).status, 400)
  }
  assert.throws(() => readSharedServerDocument('A'.repeat(Math.ceil(8 * 1024 * 1024 / 3) * 4 + 4), 'rdo'), /8 MB/)
  const body = { format: 'rdo', contents: fixtures.encodeNrbf(fixtures.fixture()).toString('base64'), credentialDisclosure: true }
  for (const selectedIndices of [[], [0], [4], [1,1], ['1'], [1.5], null]) assert.equal((await f.api('/admin/shares/import', { ...body, selectedIndices })).status, 400)
  assert.equal((await f.api('/admin/shares/import', { ...body, credentialDisclosure: false, selectedIndices: [1] })).status, 400)
  assert.equal(f.storage.database.prepare('SELECT count(*) AS n FROM shares').get().n, 0)
  const gateway = { ...body, contents: fixtures.encodeNrbf(fixtures.fixture({ entries: [fixtures.remote({ GatewayUsage: 1 })] })).toString('base64') }
  assert.equal((await f.api('/admin/shares/import', gateway)).status, 400)
  assert.equal((await f.api('/admin/shares/import', { ...gateway, selectedIndices: [1] })).status, 201)
})
