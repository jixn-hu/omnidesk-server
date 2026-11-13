import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { once } from 'node:events'
import { mkdtempSync, writeFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, basename } from 'node:path'
import { createHash } from 'node:crypto'
import { registerMonitorInstall } from '../monitor-install.mjs'

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'omnidesk-install-ticket-'))
  writeFileSync(join(directory, 'omnidesk-monitor-agent-windows-amd64.exe'), 'MZsynthetic-never-execute')
  writeFileSync(join(directory, 'install-windows.ps1'), 'fixed-installer __OMNIDESK_BUNDLE__')
  const state = { time: Date.now(), session: true, status: 200, fail: false, pending: undefined }
  const application = express(); application.use(express.json())
  const storage = { database: { prepare: () => ({ get: () => state.session ? { id: 'fixture-account' } : undefined }) } }
  registerMonitorInstall({ application, storage, directory, url: 'http://monitor.invalid', token: 'synthetic-internal-token', now: () => state.time,
    authenticate: (request, response, next) => { if (request.headers.authorization !== 'Bearer synthetic-session') return response.sendStatus(401); request.account = { id: 'fixture-account' }; request.sessionHash = 'synthetic-session-hash'; next() },
    route: handler => (request, response, next) => Promise.resolve(handler(request, response)).catch(next),
    fetcher: async () => { if (state.pending) { const pending = state.pending; state.pending = undefined; pending.entered.resolve(); await pending.release.promise } if (state.fail) throw Error('Synthetic monitor outage'); return new Response('{}', { status: state.status }) }
  })
  const server = application.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(async () => { await new Promise(resolve => server.close(resolve)); const actual = realpathSync(directory); assert.equal(dirname(actual), realpathSync(tmpdir())); assert(basename(actual).startsWith('omnidesk-install-ticket-')); rmSync(actual, { recursive: true, force: true }) })
  const origin = 'http://127.0.0.1:' + server.address().port
  const issue = async (nodeId = 'a'.repeat(24)) => { const response = await fetch(origin + '/v1/monitor/install/windows', { method: 'POST', headers: { Authorization: 'Bearer synthetic-session', 'Content-Type': 'application/json', Connection: 'close' }, body: JSON.stringify({ nodeId, token: 'synthetic-node-token-at-least-24', serverUrl: 'https://cloud.invalid:9020/v1/monitor', intervalSeconds: 60 }) }); return { status: response.status, body: await response.json() } }
  const download = (ticket, method = 'GET') => fetch(origin + '/v1/monitor/install/windows/download', { method, headers: { 'X-OmniDesk-Install': ticket, Connection: 'close' } })
  const delayNextCheck = () => { const pending = { entered: deferred(), release: deferred() }; state.pending = pending; return pending }
  return { state, issue, download, delayNextCheck }
}
const reason = async (response, code, status = 410) => { assert.equal(response.status, status); assert.equal((await response.json()).code, code) }

test('valid downloads are repeatable and concurrent, with fixed bytes and a fixed deadline', async t => {
  const f = await fixture(t), issued = await f.issue(); assert.equal(issued.status, 201)
  const command = issued.body
  for (const response of await Promise.all([f.download(command.ticket), f.download(command.ticket), f.download(command.ticket)])) {
    assert.equal(response.status, 200)
    assert.equal(createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex'), command.sha256)
    assert.equal(response.headers.get('cache-control'), 'no-store')
  }
  f.state.time = command.expiresAt - 1; assert.equal((await f.download(command.ticket)).status, 200)
  f.state.time++; await reason(await f.download(command.ticket), 'INSTALL_TICKET_EXPIRED')
  await reason(await f.download(command.ticket), 'INSTALL_TICKET_EXPIRED')
})

test('regeneration identifies replaced commands, including commands previously downloaded', async t => {
  const f = await fixture(t), first = (await f.issue()).body
  assert.equal((await f.download(first.ticket)).status, 200)
  const replacement = (await f.issue()).body
  await reason(await f.download(first.ticket), 'INSTALL_TICKET_REPLACED')
  assert.equal((await f.download(replacement.ticket)).status, 200)
  const other = (await f.issue('b'.repeat(24))).body
  assert.equal((await f.download(replacement.ticket)).status, 200, 'another node must not revoke this command')
  assert.equal((await f.download(other.ticket)).status, 200)
})

test('temporary failure during regeneration preserves the previous valid command', async t => {
  const f = await fixture(t), original = (await f.issue()).body
  f.state.status = 503
  const unavailable = await f.issue()
  assert.equal(unavailable.status, 503)
  assert.equal(unavailable.body.code, 'MONITOR_UNAVAILABLE')
  f.state.status = 200
  assert.equal((await f.download(original.ticket)).status, 200)
  const replacement = await f.issue()
  assert.equal(replacement.status, 201)
  await reason(await f.download(original.ticket), 'INSTALL_TICKET_REPLACED')
})

test('temporary monitor exceptions and non-auth errors preserve the same command for retry', async t => {
  const f = await fixture(t), command = (await f.issue()).body
  f.state.fail = true; await reason(await f.download(command.ticket), 'MONITOR_UNAVAILABLE', 503)
  f.state.fail = false
  for (const status of [429, 500, 502, 503]) { f.state.status = status; await reason(await f.download(command.ticket), 'MONITOR_UNAVAILABLE', 503) }
  f.state.status = 200
  const response = await f.download(command.ticket); assert.equal(response.status, 200)
  assert.equal(createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex'), command.sha256)
})

test('revoked account sessions and changed node credentials have distinct persistent reasons', async t => {
  const f = await fixture(t), command = (await f.issue()).body
  f.state.session = false; await reason(await f.download(command.ticket), 'ACCOUNT_SESSION_INVALID')
  f.state.session = true; await reason(await f.download(command.ticket), 'ACCOUNT_SESSION_INVALID')
  for (const status of [403, 404]) {
    const next = (await f.issue()).body; f.state.status = status
    await reason(await f.download(next.ticket), 'INSTALL_NODE_CHANGED')
    f.state.status = 200; await reason(await f.download(next.ticket), 'INSTALL_NODE_CHANGED')
  }
})

test('regeneration during validation cannot return a stale installer', async t => {
  const f = await fixture(t), command = (await f.issue()).body, pending = f.delayNextCheck()
  const downloading = f.download(command.ticket); await pending.entered.promise
  const replacement = (await f.issue()).body; pending.release.resolve()
  await reason(await downloading, 'INSTALL_TICKET_REPLACED')
  assert.equal((await f.download(replacement.ticket)).status, 200)
})

for (const change of ['expiry', 'logout']) test(change + ' while monitor validation is pending prevents download', async t => {
  const f = await fixture(t), command = (await f.issue()).body, pending = f.delayNextCheck()
  const downloading = f.download(command.ticket); await pending.entered.promise
  if (change === 'expiry') f.state.time = command.expiresAt; else f.state.session = false
  pending.release.resolve()
  await reason(await downloading, change === 'expiry' ? 'INSTALL_TICKET_EXPIRED' : 'ACCOUNT_SESSION_INVALID')
})

test('unknown commands are distinguished from expiry, and HEAD does not invalidate a ticket', async t => {
  const f = await fixture(t), command = (await f.issue()).body
  await reason(await f.download('malformed'), 'INSTALL_TICKET_INVALID')
  await reason(await f.download('z'.repeat(43)), 'INSTALL_TICKET_INVALID')
  assert.equal((await f.download(command.ticket, 'HEAD')).status, 405)
  assert.equal((await f.download(command.ticket)).status, 200)
})

test('remembered reasons do not consume active-ticket quota or prevent replacement at capacity', async t => {
  const f = await fixture(t)
  for (let i = 0; i < 16; i++) assert.equal((await f.issue(i.toString(16).padStart(24, '0'))).status, 201)
  assert.equal((await f.issue('f'.repeat(24))).status, 429)
  for (let i = 0; i < 20; i++) assert.equal((await f.issue('0'.repeat(24))).status, 201)
  f.state.time += 15 * 60 * 1000
  assert.equal((await f.issue('f'.repeat(24))).status, 201)
})
