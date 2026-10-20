import { createInterface } from 'node:readline/promises'
import { Writable } from 'node:stream'
import { resolve } from 'node:path'
import { openStorage } from '../storage.mjs'
import { createAccount } from '../admin-accounts.mjs'

let storage
let reader
try {
  storage = openStorage(resolve(process.env.OFFICIAL_DATA_DIR ?? 'official-data'))
  if (storage.database.prepare('SELECT 1 FROM users LIMIT 1').get()) throw new Error('已有用户，初始化命令不会覆盖现有账号。请登录管理后台管理用户。')
  let input
  if (process.argv.includes('--stdin-json')) {
    let content = ''
    for await (const chunk of process.stdin) {
      content += chunk.toString('utf8')
      if (content.length > 8192) throw new Error('初始化输入过大')
    }
    input = JSON.parse(content)
  } else {
    let muted = false
    const output = new Writable({ write(chunk, _encoding, done) { if (!muted) process.stdout.write(chunk); done() } })
    reader = createInterface({ input: process.stdin, output, terminal: !!process.stdin.isTTY })
    const username = (await reader.question('管理员账号（3–32 位字母、数字或下划线）：')).trim()
    process.stdout.write('管理员密码（至少 10 位，不回显）：')
    muted = true
    const password = await reader.question('')
    muted = false
    process.stdout.write('\n再次输入密码：')
    muted = true
    const confirmation = await reader.question('')
    muted = false
    process.stdout.write('\n')
    if (password !== confirmation) throw new Error('两次密码输入不一致')
    input = { username, password }
  }
  const user = await createAccount(storage, input)
  process.stdout.write(`初始管理员 ${user.username} 已创建。公开注册仍保持关闭，请登录 /admin/ 管理后台。\n`)
} catch (error) {
  process.stderr.write((error instanceof Error ? error.message : '管理员初始化失败') + '\n')
  process.exitCode = 1
} finally { reader?.close(); storage?.close() }
