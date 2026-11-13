import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { createServer as createHttpsServer } from 'node:https'
import { request as httpRequest } from 'node:http'
import { createOfficialServer } from '../server.mjs'
import { createAccount } from '../admin-accounts.mjs'
import { createGitlabFixture, syntheticClientId, syntheticClientSecret } from '../test/gitlab-fixture.mjs'

const { chromium } = createRequire(import.meta.url)('playwright')
const directory = mkdtempSync(join(tmpdir(), 'omnidesk-admin-gitlab-ui-'))
const provider = await createGitlabFixture()
const options = { directory }
const service = createOfficialServer(options)
let browser, tls
try {
  const admin = await createAccount(service.storage, { username: 'qa_admin', password: 'QA-synthetic-admin-password' })
  const member = await createAccount(service.storage, { username: 'qa_member', role: 'user', password: 'QA-synthetic-member-password' }, admin.id)
  const db = service.storage.database
  db.prepare('INSERT INTO gitlab_identities VALUES (?, ?, ?, ?)').run(provider.origin, '101', admin.id, 'qa_gitlab')
  db.prepare('INSERT INTO gitlab_identities VALUES (?, ?, ?, ?)').run(provider.origin, '102', member.id, 'qa_member')
  service.server.listen(0, '127.0.0.1'); await once(service.server, 'listening')
  const origin = 'http://127.0.0.1:' + service.server.address().port
  execFileSync(process.env.OMNIDESK_QA_OPENSSL ?? 'openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(directory, 'test.key'), '-out', join(directory, 'test.crt'), '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' })
  tls = createHttpsServer({ key: readFileSync(join(directory, 'test.key')), cert: readFileSync(join(directory, 'test.crt')) }, (request, response) => {
    const upstream = httpRequest(origin + request.url, { method: request.method, headers: { ...request.headers, 'x-forwarded-proto': 'https' } }, result => { response.writeHead(result.statusCode, result.headers); result.pipe(response) })
    upstream.on('error', () => { response.writeHead(502); response.end() }); request.pipe(upstream)
  })
  tls.listen(0, '127.0.0.1'); await once(tls, 'listening')
  const httpsOrigin = 'https://127.0.0.1:' + tls.address().port
  options.publicUrl = origin + ',' + httpsOrigin
  db.prepare('UPDATE settings SET value=? WHERE key=?').run(JSON.stringify({ enabled: true, issuer: provider.origin, clientId: syntheticClientId, clientSecret: service.storage.seal(syntheticClientSecret, 'gitlab-client-secret'), redirectUri: httpsOrigin + '/v1/auth/gitlab/callback' }), 'gitlab')
  browser = await chromium.launch({ headless: true, ...(process.env.OMNIDESK_QA_BROWSER ? { executablePath: process.env.OMNIDESK_QA_BROWSER } : {}) })
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 1000 } })
  const page = await context.newPage()
  const errors = [], urls = [], bodies = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('request', request => urls.push(request.url()))
  page.on('response', response => {
    if (/\/v1\/admin\/auth\/gitlab\/(start|complete)$/.test(response.url())) bodies.push(response.json().catch(() => ({})))
  })
  await page.goto(origin + '/admin/#shares', { waitUntil: 'networkidle' })
  await page.locator('#gitlab-login-button').waitFor({ state: 'visible' })
  assert.match(await page.locator('#gitlab-login-hint').textContent(), /已绑定且启用/)
  await page.screenshot({ path: join(directory, 'gitlab-login-desktop.png'), fullPage: true })
  await page.locator('#gitlab-login-button').click()
  await page.locator('#workspace').waitFor({ state: 'visible' })
  assert.equal(page.url(), origin + '/admin/#shares')
  assert.equal(await page.locator('#current-username').textContent(), 'qa_admin')
  await page.locator('#shares-view').waitFor({ state: 'visible' })
  assert(urls.some(url => url.startsWith(httpsOrigin + '/v1/auth/gitlab/callback?')))
  const cookie = (await context.cookies()).find(item => item.name === 'omnidesk_admin_http')
  assert(cookie?.httpOnly && !cookie.secure && cookie.sameSite === 'Strict')
  assert.equal(await page.evaluate(() => sessionStorage.length + localStorage.length), 0)
  assert(!await page.evaluate(() => document.cookie.includes('omnidesk_admin')))
  await page.reload({ waitUntil: 'networkidle' })
  await page.locator('#workspace').waitFor({ state: 'visible' })
  await page.locator('#logout-button').click()
  await page.locator('#login-view').waitFor({ state: 'visible' })

  provider.setProfile({ sub: '102', preferred_username: 'qa_member' })
  await page.locator('#gitlab-login-button').click()
  await page.locator('#gitlab-login-progress.error').waitFor({ state: 'visible' })
  assert.match(await page.locator('#gitlab-login-status').textContent(), /未绑定启用的管理员/)
  assert.equal(await page.locator('#workspace').isVisible(), false)
  assert.equal(await page.evaluate(() => sessionStorage.length), 0)
  await page.screenshot({ path: join(directory, 'gitlab-member-denied.png'), fullPage: true })

  provider.setProfile({ sub: '101', preferred_username: 'qa_gitlab' })
  provider.setFailure({ path: '/oauth/token', status: 400, body: { error: 'invalid_grant' } })
  await page.locator('#gitlab-login-button').click()
  await page.locator('#gitlab-login-progress.error').waitFor({ state: 'visible' })
  assert.match(await page.locator('#gitlab-login-status').textContent(), /token_invalid_grant/)
  provider.setFailure(null)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({ path: join(directory, 'gitlab-login-mobile.png'), fullPage: true })
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
  await page.locator('#gitlab-login-button').click()
  await page.locator('#workspace').waitFor({ state: 'visible' })
  await page.locator('#logout-button').click()
  await page.locator('#login-view').waitFor({ state: 'visible' })

  // Pause before authorization to exercise refresh/resume and user cancellation.
  let held = false
  await page.route('**/v1/auth/gitlab/authorize?*', route => { held = true; return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>QA paused authorization</title>' }) })
  await page.locator('#gitlab-login-button').click()
  await page.waitForURL(url => url.pathname === '/v1/auth/gitlab/authorize', { waitUntil: 'load' })
  assert(held)
  await page.goto(origin + '/admin/#shares', { waitUntil: 'networkidle' })
  await page.locator('#gitlab-login-cancel').waitFor({ state: 'visible' })
  await page.locator('#gitlab-login-cancel').click()
  await page.locator('#gitlab-login-progress').waitFor({ state: 'hidden' })
  assert.equal(await page.evaluate(() => sessionStorage.length), 0)
  await page.unroute('**/v1/auth/gitlab/authorize?*')
  await page.locator('#login-username').fill('qa_admin')
  await page.locator('#login-password').fill('QA-synthetic-admin-password')
  await page.locator('#login-button').click()
  await page.locator('#workspace').waitFor({ state: 'visible' })
  assert.equal(await page.locator('#login-password').inputValue(), '')

  // The HTTPS console uses its own Secure session cookie and returns to HTTPS.
  const secureContext = await browser.newContext({ ignoreHTTPSErrors: true })
  const securePage = await secureContext.newPage()
  await securePage.goto(httpsOrigin + '/admin/#settings', { waitUntil: 'networkidle' })
  await securePage.locator('#gitlab-login-button').click()
  await securePage.locator('#workspace').waitFor({ state: 'visible' })
  assert.equal(securePage.url(), httpsOrigin + '/admin/#settings')
  assert((await secureContext.cookies()).some(item => item.name === 'omnidesk_admin' && item.secure && item.httpOnly))
  const results = await Promise.all(bodies)
  assert(results.every(result => !('token' in result) && !('syncKey' in result) && !('secret' in result)))
  assert(urls.every(url => !/[?&](token|syncKey|secret|access_token|password)=/.test(url)))
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ ok: true, directory, checks: ['HTTP to HTTPS OAuth to HTTP', 'HTTPS login', 'administrator cookie and reload', 'ordinary user rejected', 'provider failure and retry', 'refresh and cancellation', 'password login', 'mobile layout', 'no client credentials in browser storage or response'] }))
} finally {
  await browser?.close()
  if (tls) { tls.closeAllConnections(); await new Promise(done => tls.close(done)) }
  await service.close(); await provider.close()
}
