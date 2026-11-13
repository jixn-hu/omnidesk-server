import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { createOfficialServer } from '../server.mjs'
import { createAccount } from '../admin-accounts.mjs'
import rdo from '../test/fixtures/rdo.cjs'
import { xterminalFixture } from '../test/fixtures/xterminal.mjs'
const { chromium } = createRequire(import.meta.url)('playwright')
const directory = mkdtempSync(join(tmpdir(), 'omnidesk-desktop-import-ui-'))
const service = createOfficialServer({ directory })
let browser, page
try {
  await createAccount(service.storage, { username: 'qa_import_admin', password: 'QA-synthetic-import-password' })
  service.server.listen(0, '127.0.0.1'); await once(service.server, 'listening')
  browser = await chromium.launch({ headless: true, ...(process.env.OMNIDESK_QA_BROWSER ? { executablePath: process.env.OMNIDESK_QA_BROWSER } : {}) })
  page = await browser.newPage({ viewport: { width: 1360, height: 1000 } })
  const errors = []; page.on('pageerror', error => errors.push(error.message))
  await page.goto('http://127.0.0.1:' + service.server.address().port + '/admin/#shares', { waitUntil: 'networkidle' })
  await page.getByLabel('管理员账号', { exact: true }).fill('qa_import_admin')
  await page.getByLabel('密码', { exact: true }).fill('QA-synthetic-import-password')
  await page.locator('#login-button').click(); await page.locator('#shares-view').waitFor({ state: 'visible' })
  const dialog = page.locator('#user-dialog'), format = dialog.getByLabel('文件格式', { exact: true })
  const open = async () => { await page.getByRole('button', { name: '导入配置', exact: true }).click(); assert.equal(await format.inputValue(), 'rdo') }
  const inspect = async () => { const done = page.waitForResponse(response => response.url().endsWith('/admin/shares/import/preview') && response.request().method() === 'POST'); await dialog.getByRole('button', { name: '预览并校验', exact: true }).click(); return (await done).json() }
  const confirm = async () => { await dialog.locator('.credential-consent input').check(); await dialog.getByRole('button', { name: '确认导入', exact: true }).click(); await dialog.waitFor({ state: 'hidden' }) }
  await open()
  assert.equal(await dialog.getByLabel('或粘贴配置内容', { exact: true }).isVisible(), false)
  const rdoBytes = rdo.encodeNrbf(rdo.fixture())
  await dialog.getByLabel('选择配置文件', { exact: true }).setInputFiles({ name: 'QA 远程桌面.RDO', mimeType: 'application/octet-stream', buffer: rdoBytes })
  const first = await inspect(); assert.equal(first.ready, 2)
  await dialog.getByText('可导入 2 台 · 重复跳过 1 台 · 错误 0 台', { exact: true }).waitFor()
  assert.equal(await dialog.getByLabel('导入 QA shared', { exact: true }).isChecked(), true)
  assert.equal(await dialog.getByLabel('导入 QA duplicate', { exact: true }).isDisabled(), true)
  const visible = await dialog.locator('.import-preview').innerText()
  for (const secret of [rdo.PASSWORD, rdo.UNICODE_PASSWORD, rdo.CIPHER]) assert(!visible.includes(secret))
  assert(visible.includes('QA 生产 / QA Windows') && visible.includes('QA note'))
  await page.screenshot({ path: join(directory, 'rdo-preview.png'), fullPage: true })
  await confirm(); await page.getByRole('button', { name: '编辑服务器 QA shared', exact: true }).waitFor()
  assert.equal(service.storage.database.prepare('SELECT count(*) AS n FROM shares').get().n, 2)
  await open()
  await format.selectOption('xterminal')
  const xtPath = xterminalFixture(directory)
  await dialog.getByLabel('选择配置文件', { exact: true }).setInputFiles(xtPath)
  const xt = await inspect(); assert.equal(xt.ready, 3); assert.equal(xt.errors, 1)
  await dialog.getByLabel('导入 QA XTerminal SSH', { exact: true }).waitFor()
  assert.equal(await dialog.getByLabel('导入 QA 未解锁连接', { exact: true }).isDisabled(), true)
  assert.equal(await dialog.getByLabel('导入 192.0.2.24', { exact: true }).isChecked(), false)
  assert.equal(await dialog.getByRole('button', { name: '确认导入', exact: true }).isDisabled(), false)
  for (const secret of ['QA-synthetic-private-key','QA-key-passphrase','QA-xterminal-password','QA-cipher-not-a-password']) assert(!(await dialog.locator('.import-preview').innerText()).includes(secret))
  await page.screenshot({ path: join(directory, 'xterminal-preview.png'), fullPage: true })
  await page.setViewportSize({ width: 430, height: 900 }); await page.screenshot({ path: join(directory, 'xterminal-mobile.png'), fullPage: true })
  assert.equal(await dialog.evaluate(element => element.scrollWidth > element.clientWidth), false)
  await page.setViewportSize({ width: 1360, height: 1000 })
  await confirm(); await page.getByRole('button', { name: '编辑服务器 QA XTerminal SSH', exact: true }).waitFor()
  assert.equal(service.storage.database.prepare('SELECT count(*) AS n FROM shares').get().n, 4)
  await open()
  await dialog.getByLabel('选择配置文件', { exact: true }).setInputFiles({ name: 'needs-review.rdo', mimeType: 'application/octet-stream', buffer: rdo.encodeNrbf(rdo.fixture({ entries: [rdo.remote({ Host: '192.0.2.99', Text: 'QA 网关配置', GatewayUsage: 1 })] })) })
  await inspect(); await dialog.getByText('需核对后手动勾选', { exact: false }).waitFor()
  assert.equal(await dialog.getByRole('button', { name: '确认导入', exact: true }).isDisabled(), true)
  await dialog.getByLabel('导入 QA 网关配置', { exact: true }).check()
  assert.equal(await dialog.getByRole('button', { name: '确认导入', exact: true }).isDisabled(), false)
  await format.selectOption('json')
  assert.equal(await dialog.getByRole('button', { name: '确认导入', exact: true }).isDisabled(), true)
  assert.equal(await dialog.locator('.import-preview li').count(), 0)
  assert.equal(await dialog.getByLabel('选择配置文件', { exact: true }).inputValue(), '')
  await dialog.getByRole('button', { name: '取消', exact: true }).click()
  assert.equal(service.storage.database.prepare('SELECT count(*) AS n FROM shares').get().n, 4)
  assert.deepEqual(errors, [])
  console.log('PASS browser RDO/XTerminal uploads, binary preview, default and manual selection, encrypted credential handling, mixed invalid rows, source changes, cancellation and mobile layout:', directory)
} catch (error) {
  if (page) await page.screenshot({ path: join(directory, 'failure.png'), fullPage: true })
  throw error
} finally { await browser?.close(); await service.close() }
