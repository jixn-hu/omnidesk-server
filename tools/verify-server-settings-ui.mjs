import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { createOfficialServer } from '../server.mjs'
import { createAccount } from '../admin-accounts.mjs'

const { chromium } = createRequire(import.meta.url)('playwright')
const directory = mkdtempSync(join(tmpdir(), 'omnidesk-settings-ui-'))
const password = 'QA-synthetic-settings-password'
const secret = 'QA-synthetic-provider-secret'
const service = createOfficialServer({ directory, gitlab: { issuer: 'https://gitlab.example.com', clientId: 'qa-client', clientSecret: secret, redirectUri: 'https://127.0.0.1/v1/auth/gitlab/callback' } })
let browser
try {
  await createAccount(service.storage, { username: 'qa_admin', password })
  service.server.listen(0, '127.0.0.1')
  await once(service.server, 'listening')
  const origin = 'http://127.0.0.1:' + service.server.address().port
  browser = await chromium.launch({ headless: true, ...(process.env.OMNIDESK_QA_BROWSER ? { executablePath: process.env.OMNIDESK_QA_BROWSER } : {}) })
  const page = await browser.newPage({ viewport: { width: 1440, height: 1080 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(origin + '/admin/', { waitUntil: 'networkidle' })
  await page.locator('#login-username').fill('qa_admin')
  await page.locator('#login-password').fill(password)
  await page.locator('#login-button').click()
  await page.locator('#workspace').waitFor({ state: 'visible' })
  await page.route('**/v1/admin/settings', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'QA 模拟配置暂时不可读' }) }))
  await page.locator('#nav-settings').click()
  await page.locator('#settings-error').waitFor({ state: 'visible' })
  assert.equal(await page.locator('#gitlab-issuer').isDisabled(), true)
  assert.equal(await page.locator('#save-settings').isDisabled(), true)
  await page.unroute('**/v1/admin/settings')
  await page.locator('#reload-settings').click()
  await page.waitForFunction(() => !document.querySelector('#settings-fields').disabled)
  assert.equal(await page.locator('#gitlab-secret').inputValue(), '')
  assert.match(await page.locator('#gitlab-secret-state').textContent(), /已配置/)
  assert.equal(await page.locator('#gitlab-redirect').inputValue(), 'https://127.0.0.1/v1/auth/gitlab/callback')
  assert.match(await page.locator('#gitlab-callback-hint').textContent(), /保留已有回调/)
  assert.equal(await page.locator('#save-settings').isDisabled(), true)
  const encryptedSecret = () => JSON.parse(service.storage.database.prepare('SELECT value FROM settings WHERE key=?').get('gitlab').value).clientSecret
  const previousSecret = encryptedSecret()
  await page.locator('#copy-gitlab-callback').click()
  await page.locator('#use-current-callback').click()
  assert.equal(await page.locator('#gitlab-redirect').inputValue(), origin + '/v1/auth/gitlab/callback')
  await page.locator('#reset-settings').click()
  assert.equal(await page.locator('#gitlab-redirect').inputValue(), 'https://127.0.0.1/v1/auth/gitlab/callback')
  await page.locator('#registration-open').check()
  await page.locator('#nav-users').click()
  await page.locator('#nav-settings').click()
  assert.equal(await page.locator('#registration-open').isChecked(), true)
  await page.locator('#save-settings').click()
  await page.waitForFunction(() => document.querySelector('#save-settings').disabled && !document.querySelector('#settings-fields').disabled)
  assert.equal(encryptedSecret(), previousSecret)
  assert.equal(service.storage.database.prepare('SELECT value FROM settings WHERE key=?').get('registrationOpen').value, 'true')
  await page.locator('#gitlab-client-id').fill('qa-new-application')
  await page.locator('#save-settings').click()
  await page.locator('#settings-error').waitFor({ state: 'visible' })
  assert.match(await page.locator('#settings-error').textContent(), /新 Secret/)
  assert.equal(await page.locator('#gitlab-client-id').inputValue(), 'qa-new-application')
  await page.locator('#gitlab-secret').fill(secret + '-new')
  await page.locator('#save-settings').click()
  await page.waitForFunction(() => document.querySelector('#save-settings').disabled && !document.querySelector('#settings-fields').disabled)
  assert.equal(await page.locator('#gitlab-secret').inputValue(), '')
  assert.equal(service.storage.open(encryptedSecret(), 'gitlab-client-secret'), secret + '-new')
  // A second administrator saves while this browser retains a draft.
  await page.locator('#registration-open').uncheck()
  assert.equal(await page.evaluate(async () => {
    const response = await fetch('/v1/admin/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-OmniDesk-Admin': '1' }, body: JSON.stringify({ registrationOpen: false }) })
    return response.status
  }), 200)
  await page.locator('#save-settings').click()
  await page.locator('#settings-error').waitFor({ state: 'visible' })
  assert.match(await page.locator('#settings-error').textContent(), /其他管理员修改/)
  assert.equal(await page.locator('#registration-open').isChecked(), false)
  assert.equal(await page.locator('#save-settings').isDisabled(), false)
  await page.locator('#reload-settings').click()
  await page.waitForFunction(() => document.querySelector('#save-settings').disabled && !document.querySelector('#settings-fields').disabled)
  // Render real diagnostic data from a rejected expired request, without contacting GitLab.
  await fetch(origin + '/v1/auth/gitlab/callback')
  await page.locator('#refresh-auth-diagnostics').click()
  await page.locator('#auth-diagnostics li').waitFor()
  assert.match(await page.locator('#auth-diagnostics').textContent(), /request_expired/)
  await page.locator('#notice').waitFor({ state: 'hidden' })
  await page.evaluate(() => scrollTo(0, 0))
  await page.screenshot({ path: join(directory, 'server-settings.png'), fullPage: true })
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForFunction(() => !document.querySelector('#settings-fields').disabled)
  assert.equal(await page.locator('#gitlab-client-id').inputValue(), 'qa-new-application')
  assert.equal(await page.locator('#registration-open').isChecked(), false)
  assert.equal(await page.locator('#gitlab-secret').inputValue(), '')
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({ path: join(directory, 'server-settings-mobile.png'), fullPage: true })
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
  await page.locator('#gitlab-secret').fill('QA-unsaved-secret')
  await page.locator('#logout-button').click()
  await page.locator('#login-view').waitFor({ state: 'visible' })
  assert.equal(await page.locator('#gitlab-secret').inputValue(), '')
  assert.equal(await page.locator('#gitlab-issuer').isDisabled(), true)
  const settingsResponse = await page.request.get(origin + '/v1/admin/settings', { headers: { 'X-OmniDesk-Admin': '1' } })
  assert.equal(settingsResponse.status(), 401)
  assert(!(await page.content()).includes(secret))
  assert(!(await page.content()).includes(previousSecret))
  assert.deepEqual(errors, [])
  console.log('PASS: settings recovery, encrypted secret preservation/replacement, callback assistance, draft/reset, conflict, diagnostics, persistence, logout, mobile; screenshots:', directory)
} finally {
  await browser?.close()
  await service.close()
}
