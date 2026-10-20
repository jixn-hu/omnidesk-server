const select = selector => document.querySelector(selector)
const state = { user: null, page: 0, search: '', total: 0, users: [], settings: null, loadVersion: 0 }
let noticeTimer
function notify(message, error = false) {
  clearTimeout(noticeTimer)
  const notice = select('#notice')
  notice.textContent = message
  notice.classList.toggle('error', error)
  notice.hidden = false
  noticeTimer = setTimeout(() => { notice.hidden = true }, error ? 12000 : 5000)
}
function report(error) {
  const message = error instanceof Error ? error.message : '操作未完成，请重试'
  const inline = select('#user-dialog[open] .dialog-error')
  if (inline) inline.textContent = message
  else notify(message, true)
}
function showLogin() {
  state.user = null
  state.users = []
  state.loadVersion++
  select('#user-dialog').close()
  select('#user-rows').replaceChildren()
  select('#workspace').hidden = true
  select('#login-view').hidden = false
  select('#gitlab-secret').value = ''
}
async function api(path, method = 'GET', body) {
  const response = await fetch('/v1' + path, { method, credentials: 'same-origin', cache: 'no-store', headers: { 'X-OmniDesk-Admin': '1', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  let result
  try { result = await response.json() } catch { throw new Error('服务响应异常，请检查连接或反向代理') }
  if (!response.ok) {
    if (response.status === 401 && state.user) showLogin()
    throw new Error(result.error || '请求未完成，请重试')
  }
  return result
}
async function perform(button, operation) {
  if (button.disabled) return
  const label = button.textContent
  button.disabled = true
  button.textContent = '正在处理…'
  const inline = select('#user-dialog .dialog-error')
  if (inline) inline.textContent = ''
  try { await operation() } catch (error) { report(error) }
  finally { button.disabled = false; button.textContent = label }
}
function element(tag, text, className) {
  const node = document.createElement(tag)
  if (text !== undefined) node.textContent = text
  if (className) node.className = className
  return node
}
function button(text, handler, className = 'secondary') {
  const node = element('button', text, className)
  node.type = 'button'
  node.addEventListener('click', handler)
  return node
}
function field(form, label, options = {}) {
  const wrapper = element('label', label)
  const control = document.createElement(options.choices ? 'select' : 'input')
  control.name = options.name ?? label
  control.setAttribute('aria-label', label)
  if (options.choices) for (const [value, text] of options.choices) { const item = element('option', text); item.value = value; control.appendChild(item) }
  else { control.type = options.type ?? 'text'; control.autocomplete = options.type === 'password' ? 'new-password' : 'off' }
  for (const property of ['required', 'value', 'minLength', 'maxLength', 'pattern', 'disabled', 'readOnly', 'placeholder']) if (options[property] !== undefined) control[property] = options[property]
  wrapper.appendChild(control)
  form.appendChild(wrapper)
  return control
}
function dialogForm(title) {
  select('#dialog-title').textContent = title
  const form = element('form')
  const error = element('p', '', 'dialog-error')
  error.setAttribute('role', 'alert')
  form.appendChild(error)
  select('#dialog-content').replaceChildren(form)
  select('#user-dialog').showModal()
  return form
}
function submitButton(form, label, operation, className = 'primary') {
  const actions = element('div', undefined, 'dialog-actions')
  actions.appendChild(button('取消', () => select('#user-dialog').close()))
  const submit = element('button', label, className)
  submit.type = 'submit'
  actions.appendChild(submit)
  form.appendChild(actions)
  form.addEventListener('submit', event => { event.preventDefault(); void perform(submit, operation) })
  return submit
}
const date = value => value ? new Date(value).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '尚无记录'

async function loadUsers() {
  const version = ++state.loadVersion
  try {
    const result = await api('/admin/users?search=' + encodeURIComponent(state.search) + '&page=' + state.page)
    if (version !== state.loadVersion || !state.user) return
    if (state.page > 0 && !result.items.length) { state.page--; return loadUsers() }
    state.users = result.items
    state.total = result.total
    for (const [id, key] of [['users', 'users'], ['admins', 'administrators'], ['sync', 'synchronizedUsers'], ['shares', 'sharedServers']]) select('#metric-' + id).textContent = result.summary[key] ?? 0
    select('#user-count').textContent = '共 ' + result.total + ' 个账号'
    const rows = select('#user-rows')
    rows.replaceChildren()
    for (const user of result.items) {
      const row = element('tr')
      const identity = element('td')
      identity.appendChild(element('strong', user.username + (user.id === state.user.id ? ' · 你' : '')))
      identity.appendChild(element('span', (user.role === 'admin' ? '管理员' : '普通用户') + ' · ' + date(user.createdAt), 'account-secondary'))
      row.appendChild(identity)
      const status = element('td')
      status.appendChild(element('span', user.disabled ? '已停用' : '启用中', 'badge' + (user.disabled ? ' off' : '')))
      row.appendChild(status)
      row.appendChild(element('td', date(user.lastLoginAt)))
      const sync = element('td', user.configurationRevision === null ? '未上传' : '版本 ' + user.configurationRevision)
      if (user.configurationUpdatedAt) sync.appendChild(element('small', date(user.configurationUpdatedAt), 'account-secondary'))
      row.appendChild(sync)
      row.appendChild(element('td', user.sharedServers + ' 台 / ' + user.loginSessions + ' 个'))
      const action = element('td', undefined, 'align-right')
      const manage = button('管理', () => editUser(user), 'table-action')
      manage.setAttribute('aria-label', '管理用户 ' + user.username)
      action.appendChild(manage)
      row.appendChild(action)
      rows.appendChild(row)
    }
    select('#users-empty').hidden = result.items.length !== 0
    select('#page-label').textContent = '第 ' + (state.page + 1) + ' / ' + Math.max(1, Math.ceil(result.total / 50)) + ' 页 · 每页 50 条'
    select('#previous-page').disabled = state.page === 0
    select('#next-page').disabled = (state.page + 1) * 50 >= result.total
  } catch (error) { if (version === state.loadVersion) report(error) }
}
function createUser() {
  const form = dialogForm('新建用户')
  const username = field(form, '账号', { name: 'username', required: true, minLength: 3, maxLength: 32, pattern: '[a-zA-Z0-9_]{3,32}', placeholder: '3–32 位字母、数字或下划线' })
  const password = field(form, '初始密码', { name: 'password', type: 'password', required: true, minLength: 10, maxLength: 1024 })
  const role = field(form, '角色', { choices: [['user', '普通用户'], ['admin', '管理员']] })
  form.appendChild(element('p', '即使公开注册关闭，管理员也可以在这里创建账号。', 'muted'))
  submitButton(form, '创建用户', async () => {
    await api('/admin/users', 'POST', { username: username.value, password: password.value, role: role.value })
    password.value = ''
    select('#user-dialog').close()
    notify('用户已创建')
    await loadUsers()
  })
}
function editUser(user) {
  const form = dialogForm('管理 ' + user.username)
  const self = user.id === state.user.id
  const role = field(form, '角色', { choices: [['user', '普通用户'], ['admin', '管理员']], value: user.role, disabled: self })
  const status = field(form, '账号状态', { choices: [['0', '启用中'], ['1', '已停用']], value: String(Number(!!user.disabled)), disabled: self })
  form.appendChild(element('p', self ? '不能停用、降级或删除当前管理员；系统始终保留至少一名启用的管理员。' : '停用账号会立即撤销其登录会话，并同时阻止密码与 GitLab 登录。角色变更后需重新登录。', 'muted'))
  submitButton(form, '保存用户', async () => {
    await api('/admin/users/' + user.id, 'PATCH', { role: role.value, disabled: status.value === '1' })
    select('#user-dialog').close()
    notify('用户权限已更新')
    await loadUsers()
  })
  const actions = element('div', undefined, 'account-actions')
  actions.appendChild(button('重置账号密码', () => resetPassword(user)))
  actions.appendChild(button('撤销全部登录会话', () => revokeSessions(user)))
  const remove = button('删除用户及其云端数据', () => deleteUser(user), 'danger')
  remove.disabled = self
  actions.appendChild(remove)
  form.appendChild(actions)
}
function nextDialog(title) { select('#user-dialog').close(); return dialogForm(title) }
function resetPassword(user) {
  const form = nextDialog('重置 ' + user.username + ' 的密码')
  const password = field(form, '新密码', { type: 'password', required: true, minLength: 10, maxLength: 1024 })
  form.appendChild(element('p', '原密码不可查看。重置会撤销该账号全部会话，不会删除同步配置；已绑定的 GitLab 身份仍可登录。若需阻止所有登录，请停用账号。', 'muted'))
  submitButton(form, '确认重置密码', async () => {
    await api('/admin/users/' + user.id + '/password', 'POST', { password: password.value })
    password.value = ''
    select('#user-dialog').close()
    if (user.id === state.user.id) showLogin()
    else await loadUsers()
    notify('密码已重置，原登录会话已撤销')
  })
}
function revokeSessions(user) {
  const form = nextDialog('撤销 ' + user.username + ' 的会话')
  form.appendChild(element('p', '该账号所有设备和网页管理台都需要重新登录。已下载到本机的配置不受影响。', 'confirm-copy'))
  submitButton(form, '确认撤销全部会话', async () => {
    await api('/admin/users/' + user.id + '/revoke-sessions', 'POST', {})
    select('#user-dialog').close()
    if (user.id === state.user.id) showLogin()
    else await loadUsers()
    notify('该用户全部登录会话已撤销')
  })
}
function deleteUser(user) {
  const form = nextDialog('删除 ' + user.username)
  form.appendChild(element('p', '这会永久删除该用户的账号、云端同步配置、共享服务器与登录会话，不会删除其本机连接，也不能收回其他人已下载的配置。此操作不可撤销。', 'confirm-copy'))
  const confirmation = field(form, '输入账号名 ' + user.username + ' 以确认', { required: true, autocomplete: 'off' })
  submitButton(form, '永久删除用户', async () => {
    await api('/admin/users/' + user.id, 'DELETE', { confirmation: confirmation.value })
    select('#user-dialog').close()
    notify('用户及其云端数据已删除')
    await loadUsers()
  }, 'danger')
}
async function loadSettings() {
  const result = await api('/admin/settings')
  if (!state.user) return
  state.settings = result
  select('#registration-open').checked = result.registrationOpen
  select('#gitlab-enabled').checked = result.gitlab.enabled
  select('#gitlab-issuer').value = result.gitlab.issuer
  select('#gitlab-client-id').value = result.gitlab.clientId
  select('#gitlab-redirect').value = result.gitlab.redirectUri
  select('#gitlab-secret').value = ''
  select('#gitlab-secret-state').textContent = result.gitlab.secretConfigured ? '已保存密钥，服务端加密存储，不会回显。' : '尚未配置密钥。'
}
function showView(view) {
  for (const name of ['users', 'settings']) { select('#' + name + '-view').hidden = name !== view; select('#nav-' + name).classList.toggle('active', name === view) }
  select('#breadcrumb').textContent = view === 'users' ? '用户管理' : '登录与注册'
  if (view === 'settings') void loadSettings().catch(report)
}
async function enter(user) {
  state.user = user
  state.page = 0
  state.search = ''
  select('#user-search').value = ''
  select('#current-username').textContent = user.username
  select('#login-view').hidden = true
  select('#workspace').hidden = false
  showView('users')
  await loadUsers()
}
select('#login-form').addEventListener('submit', event => {
  event.preventDefault()
  void perform(select('#login-button'), async () => {
    try { const result = await api('/admin/login', 'POST', { username: select('#login-username').value.trim(), password: select('#login-password').value }); await enter(result.user) }
    finally { select('#login-password').value = '' }
  })
})
select('#logout-button').addEventListener('click', () => void perform(select('#logout-button'), async () => { await api('/admin/logout', 'POST', {}); showLogin(); notify('已安全退出') }))
select('#create-user').addEventListener('click', createUser)
select('#close-dialog').addEventListener('click', () => select('#user-dialog').close())
select('#refresh-users').addEventListener('click', () => void perform(select('#refresh-users'), loadUsers))
for (const view of ['users', 'settings']) select('#nav-' + view).addEventListener('click', () => showView(view))
select('#previous-page').addEventListener('click', () => { if (state.page > 0) { state.page--; void loadUsers() } })
select('#next-page').addEventListener('click', () => { if ((state.page + 1) * 50 < state.total) { state.page++; void loadUsers() } })
let searchTimer
select('#user-search').addEventListener('input', event => { clearTimeout(searchTimer); state.search = event.target.value; state.page = 0; searchTimer = setTimeout(() => void loadUsers(), 250) })
select('#settings-form').addEventListener('submit', event => {
  event.preventDefault()
  void perform(select('#save-settings'), async () => {
    await api('/admin/settings', 'PUT', { registrationOpen: select('#registration-open').checked, gitlab: { enabled: select('#gitlab-enabled').checked, issuer: select('#gitlab-issuer').value.trim(), clientId: select('#gitlab-client-id').value.trim(), redirectUri: select('#gitlab-redirect').value.trim(), ...(select('#gitlab-secret').value ? { clientSecret: select('#gitlab-secret').value } : {}) } })
    await loadSettings()
    notify('设置已保存，立即生效')
  })
})
void api('/admin/me').then(enter).catch(() => showLogin())
