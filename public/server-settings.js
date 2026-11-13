const serverSettingsState = { generation: 0, loaded: false, busy: false, diagnosticsGeneration: 0 }

function settingsDraft() {
  return { registrationOpen: select('#registration-open').checked, gitlab: { enabled: select('#gitlab-enabled').checked, issuer: select('#gitlab-issuer').value.trim(), clientId: select('#gitlab-client-id').value.trim(), redirectUri: select('#gitlab-redirect').value.trim(), ...(select('#gitlab-secret').value ? { clientSecret: select('#gitlab-secret').value } : {}) } }
}
function settingsDirty() {
  if (!serverSettingsState.loaded || !state.settings) return false
  const draft = settingsDraft(), saved = state.settings
  return draft.registrationOpen !== saved.registrationOpen || ['enabled', 'issuer', 'clientId', 'redirectUri'].some(key => draft.gitlab[key] !== saved.gitlab[key]) || !!draft.gitlab.clientSecret
}
function settingsError(message = '') {
  select('#settings-error').textContent = message
  select('#settings-error').hidden = !message
}
function updateSettingsControls() {
  const dirty = settingsDirty(), { loaded, busy } = serverSettingsState
  select('#settings-fields').disabled = !loaded || busy
  select('#save-settings').disabled = !dirty || busy
  select('#reset-settings').disabled = !dirty || busy
  select('#reload-settings').disabled = busy
  select('#reload-settings').textContent = dirty ? '放弃修改并重新读取' : '重新读取配置'
  select('#settings-save-state').textContent = busy ? '正在处理配置…' : !loaded ? '配置尚未加载，请重新读取后再编辑。' : dirty ? '有未保存的修改，保存后立即生效。' : '已读取服务端配置，保存后立即生效，无需重启。'
  select('#copy-gitlab-callback').disabled = !select('#gitlab-redirect').value.trim() || busy
  const redirect = select('#gitlab-redirect').value.trim()
  let hint = ''
  try {
    const url = new URL(redirect)
    if (url.hostname !== location.hostname) hint = 'Web GitLab 登录需通过回调地址对应的主机访问管理台。'
    else if (url.protocol !== location.protocol) hint = '当前管理页与回调协议不同，可以保留已有回调。'
  } catch { /* The form and server validate the URL on save. */ }
  select('#gitlab-callback-hint').textContent = hint
}
function renderSettings(result) {
  state.settings = result
  serverSettingsState.loaded = true
  select('#registration-open').checked = result.registrationOpen
  select('#gitlab-enabled').checked = result.gitlab.enabled
  select('#gitlab-issuer').value = result.gitlab.issuer
  select('#gitlab-client-id').value = result.gitlab.clientId
  select('#gitlab-redirect').value = result.gitlab.redirectUri
  select('#gitlab-secret').value = ''
  select('#gitlab-secret-state').textContent = result.gitlab.secretConfigured ? '已配置 · 服务端加密保存，不回显；留空保留原密钥。' : '尚未配置 · 开启 GitLab 登录前需填写 Secret。'
  select('#settings-gitlab-status').textContent = result.gitlab.enabled ? '已开启' : '已关闭'
  select('#settings-registration-status').textContent = result.registrationOpen ? '允许注册' : '已关闭'
  settingsError()
  updateSettingsControls()
}
function clearServerSettings() {
  serverSettingsState.generation++
  serverSettingsState.diagnosticsGeneration++
  serverSettingsState.loaded = false
  serverSettingsState.busy = false
  state.settings = null
  select('#settings-form').reset()
  select('#auth-diagnostics').replaceChildren()
  select('#auth-diagnostics-state').textContent = '正在读取…'
  select('#refresh-auth-diagnostics').disabled = false
  select('#settings-gitlab-status').textContent = '正在读取…'
  select('#settings-registration-status').textContent = '正在读取…'
  select('#gitlab-secret-state').textContent = ''
  settingsError()
  updateSettingsControls()
}
async function loadAuthDiagnostics() {
  const generation = ++serverSettingsState.diagnosticsGeneration
  select('#refresh-auth-diagnostics').disabled = true
  select('#auth-diagnostics-state').textContent = '正在读取…'
  try {
    const result = await api('/admin/auth-diagnostics')
    if (generation !== serverSettingsState.diagnosticsGeneration || !state.user) return
    select('#auth-diagnostics').replaceChildren(...result.failures.map(failure => {
      const item = element('li')
      item.append(element('strong', failure.message), element('span', date(failure.at) + ' · ' + failure.code + ' · 排查编号 ' + failure.reference, 'muted'))
      return item
    }))
    select('#auth-diagnostics-state').textContent = result.failures.length ? '最近 ' + result.failures.length + ' 条授权错误；重启服务后记录会清空。' : '暂无授权错误记录。实际登录仍需使用 GitLab 账号完成授权。'
  } catch (error) {
    if (generation === serverSettingsState.diagnosticsGeneration && state.user) select('#auth-diagnostics-state').textContent = '诊断读取失败：' + error.message
  } finally {
    if (generation === serverSettingsState.diagnosticsGeneration) select('#refresh-auth-diagnostics').disabled = false
  }
}
async function loadSettings(force = false) {
  if (serverSettingsState.busy || (serverSettingsState.loaded && !force)) return
  const generation = ++serverSettingsState.generation
  serverSettingsState.busy = true
  settingsError()
  updateSettingsControls()
  void loadAuthDiagnostics()
  try {
    const result = await api('/admin/settings')
    if (generation !== serverSettingsState.generation || !state.user) return
    renderSettings(result)
  } catch (error) {
    if (generation === serverSettingsState.generation && state.user) settingsError('配置读取失败：' + error.message + '。请点击「重新读取配置」重试。')
  } finally {
    if (generation === serverSettingsState.generation) { serverSettingsState.busy = false; updateSettingsControls() }
  }
}
async function saveServerSettings(event) {
  event.preventDefault()
  if (serverSettingsState.busy || !settingsDirty()) return
  const generation = ++serverSettingsState.generation
  const payload = { ...settingsDraft(), revision: state.settings.revision }
  serverSettingsState.busy = true
  settingsError()
  updateSettingsControls()
  try {
    const result = await api('/admin/settings', 'PUT', payload)
    if (generation !== serverSettingsState.generation || !state.user) return
    renderSettings(result)
    notify('设置已保存，立即生效')
    void loadLoginProvider()
  } catch (error) {
    if (generation === serverSettingsState.generation && state.user) settingsError(error.message)
  } finally {
    if (generation === serverSettingsState.generation) { serverSettingsState.busy = false; updateSettingsControls() }
  }
}
function initializeServerSettings() {
  select('#settings-origin').textContent = location.origin
  select('#settings-form').addEventListener('input', updateSettingsControls)
  select('#settings-form').addEventListener('change', updateSettingsControls)
  select('#settings-form').addEventListener('submit', event => void saveServerSettings(event))
  select('#reload-settings').addEventListener('click', () => void loadSettings(true))
  select('#reset-settings').addEventListener('click', () => { if (state.settings && !serverSettingsState.busy) renderSettings(state.settings) })
  select('#refresh-auth-diagnostics').addEventListener('click', () => void loadAuthDiagnostics())
  select('#use-current-callback').addEventListener('click', () => {
    select('#gitlab-redirect').value = location.origin + '/v1/auth/gitlab/callback'
    updateSettingsControls()
    notify('已填入当前站点回调，保存前请在 GitLab 应用中同步修改 Redirect URI。')
  })
  select('#copy-gitlab-callback').addEventListener('click', async () => {
    const input = select('#gitlab-redirect'), value = input.value.trim()
    if (!value) return
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(value)
      else { input.focus(); input.select(); if (!document.execCommand('copy')) throw new Error('copy') }
      notify('回调地址已复制')
    } catch { input.focus(); input.select(); notify('浏览器未允许自动复制，已选中回调地址，请按 Ctrl+C 复制。') }
  })
  updateSettingsControls()
}
