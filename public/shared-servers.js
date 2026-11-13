let serverTagInputId = 0
const sharedState = { items: [], selected: new Set(), page: 0, total: 0, version: 0 }
function clearSharedServers() {
  sharedState.version++
  sharedState.items = []
  sharedState.selected.clear()
  select('#server-rows').replaceChildren()
}
function updateServerSelection() {
  select('#server-selection-count').textContent = '已选 ' + sharedState.selected.size + ' 台'
  select('#edit-selected-servers').disabled = !sharedState.selected.size
  select('#delete-selected-servers').disabled = !sharedState.selected.size
  const all = select('#select-all-servers')
  all.checked = sharedState.items.length > 0 && sharedState.selected.size === sharedState.items.length
  all.indeterminate = sharedState.selected.size > 0 && !all.checked
  all.disabled = !sharedState.items.length
}
async function loadSharedServers() {
  const version = ++sharedState.version
  const parameters = new URLSearchParams({ search: select('#server-search').value, kind: select('#server-kind').value, source: select('#server-source').value, page: sharedState.page })
  select('#server-load-error').hidden = true
  select('#server-rows').setAttribute('aria-busy', 'true')
  try {
    const result = await api('/admin/shares?' + parameters)
    if (version !== sharedState.version || !state.user) return
    if (sharedState.page && !result.items.length) { sharedState.page--; return loadSharedServers() }
    sharedState.items = result.items; sharedState.total = result.total; sharedState.selected.clear()
    for (const key of ['total', 'managed', 'ssh', 'rdp']) select('#server-metric-' + key).textContent = result.summary[key]
    select('#server-count').textContent = '共 ' + result.total + ' 台 · 每页 50 台'
    const rows = select('#server-rows'); rows.replaceChildren()
    for (const server of result.items) {
      const config = server.configuration
      const row = element('tr')
      const checkCell = element('td'), check = element('input')
      check.type = 'checkbox'; check.setAttribute('aria-label', '选择服务器 ' + config.name)
      check.addEventListener('change', () => { if (check.checked) sharedState.selected.add(server.id); else sharedState.selected.delete(server.id); updateServerSelection() })
      checkCell.appendChild(check); row.appendChild(checkCell)
      const identity = element('td'); identity.appendChild(element('strong', config.name)); identity.appendChild(element('span', server.address, 'account-secondary mono'))
      if (config.note) { const note = element('small', config.note, 'server-note'); note.title = config.note; identity.appendChild(note) }
      row.appendChild(identity)
      const protocol = element('td'); protocol.appendChild(element('span', config.kind.toUpperCase(), 'badge protocol-' + config.kind)); protocol.appendChild(element('small', (config.domain ? config.domain + '/' : '') + config.username, 'account-secondary')); row.appendChild(protocol)
      const grouping = element('td', config.group || '未分组')
      const tags = element('div', undefined, 'server-tags')
      for (const tag of config.tags || []) tags.appendChild(serverTagPill(tag))
      grouping.appendChild(tags); row.appendChild(grouping)
      const source = element('td'); source.appendChild(element('span', server.source === 'managed' ? '管理员维护' : '用户共享', 'source-label')); source.appendChild(element('small', server.owner, 'account-secondary')); row.appendChild(source)
      row.appendChild(element('td', date(server.updatedAt), 'date-cell'))
      const actions = element('td', undefined, 'align-right server-row-actions')
      const edit = button('编辑', () => editSharedServer(server), 'table-action'); edit.setAttribute('aria-label', '编辑服务器 ' + config.name)
      const remove = button('删除', () => deleteSharedServers([server]), 'table-action danger-text'); remove.setAttribute('aria-label', '删除服务器 ' + config.name)
      actions.append(edit, remove); row.appendChild(actions); rows.appendChild(row)
    }
    select('#servers-empty').hidden = !!result.items.length
    select('#servers-empty').textContent = parameters.get('search') || parameters.get('kind') || parameters.get('source') ? '没有匹配的服务器，试试其他筛选条件。' : '暂无共享服务器。点击「新建服务器」或「导入配置」开始维护。'
    select('#server-page-label').textContent = '第 ' + (sharedState.page + 1) + ' / ' + Math.max(1, Math.ceil(result.total / 50)) + ' 页'
    select('#server-previous-page').disabled = !sharedState.page
    select('#server-next-page').disabled = (sharedState.page + 1) * 50 >= result.total
    updateServerSelection()
  } catch (error) {
    if (version === sharedState.version) { select('#server-load-error').textContent = error.message; select('#server-load-error').hidden = false }
  } finally { if (version === sharedState.version) select('#server-rows').setAttribute('aria-busy', 'false') }
}
function serverField(form, label, options = {}) {
  if (options.type !== 'textarea') return field(form, label, options)
  const wrapper = element('label', label), input = element('textarea')
  input.rows = options.rows || 3; input.value = options.value || ''; input.required = !!options.required
  if (options.placeholder) input.placeholder = options.placeholder
  wrapper.appendChild(input); form.appendChild(wrapper)
  return input
}
function serverTagPill(tag) {
  const chip = element('span', tag, 'tag-pill')
  chip.dataset.tone = Array.from(tag).reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) >>> 0, 0) % 5
  chip.title = tag
  return chip
}
function serverTagInput(parent, initial = [], suggestions = []) {
  let values = [...new Set(initial)]
  const wrapper = element('div', undefined, 'tag-field'), label = element('label', '标签')
  const editor = element('div', undefined, 'tag-editor'), chips = element('div', undefined, 'tag-editor-chips'), input = element('input')
  input.id = 'tags-' + ++serverTagInputId; label.htmlFor = input.id
  input.placeholder = '输入标签，按 Enter 添加'; input.autocomplete = 'off'
  const hint = element('small', 'Enter 添加 · × 移除 · 支持粘贴多个标签', 'muted')
  hint.id = input.id + '-hint'; input.setAttribute('aria-describedby', hint.id)
  const candidates = element('div', undefined, 'tag-suggestions')
  const read = (text = input.value) => {
    const next = [...new Set([...values, ...text.split(/[,，;；\r\n]+/).map(value => value.trim()).filter(Boolean)])]
    if (next.length > 100 || next.some(value => value.length > 128 || value.includes('\0'))) throw new Error('最多 100 个标签，每个最多 128 字')
    return next
  }
  const commit = (text = input.value) => {
    try { values = read(text); input.value = ''; input.setCustomValidity(''); render(); return true }
    catch (error) { input.setCustomValidity(error.message); input.reportValidity(); return false }
  }
  const render = () => {
    chips.replaceChildren(); candidates.replaceChildren()
    for (const tag of values) {
      const chip = serverTagPill(tag), remove = button('×', () => { values = values.filter(value => value !== tag); render() }, 'tag-remove')
      remove.setAttribute('aria-label', '移除标签 ' + tag); chip.appendChild(remove); chips.appendChild(chip)
    }
    const matches = [...new Set(suggestions)].filter(tag => !values.includes(tag) && (!input.value || tag.toLowerCase().includes(input.value.toLowerCase()))).slice(0, 8)
    if (matches.length) candidates.appendChild(element('span', '已有标签'))
    for (const tag of matches) { const suggestion = button(tag, () => { commit(tag); input.focus() }, 'tag-suggestion'); suggestion.addEventListener('mousedown', event => event.preventDefault()); candidates.appendChild(suggestion) }
  }
  const add = button('＋', () => { if (commit()) input.focus() }, 'tag-add'); add.setAttribute('aria-label', '添加标签')
  editor.addEventListener('click', event => { if (event.target === editor) input.focus() })
  input.addEventListener('keydown', event => {
    if (event.isComposing || event.keyCode === 229) return
    if (event.key === 'Enter') { event.preventDefault(); commit() }
    if (event.key === 'Backspace' && !input.value) { values = values.slice(0, -1); render() }
  })
  input.addEventListener('input', () => { input.setCustomValidity(''); render() })
  input.addEventListener('blur', () => { if (input.value.trim()) commit() })
  input.addEventListener('paste', event => { const text = event.clipboardData.getData('text'); if (/[,，;；\r\n]/.test(text)) { event.preventDefault(); commit(input.value + text) } })
  editor.append(chips, input, add); wrapper.append(label, editor, hint, candidates); parent.appendChild(wrapper); render()
  return { read, wrapper }
}
function batchEditSharedServers(servers) {
  if (!servers.length) return
  const form = dialogForm('批量编辑服务器')
  form.classList.add('server-form', 'batch-metadata')
  const summary = element('div', undefined, 'batch-summary'), count = element('strong', String(servers.length))
  count.appendChild(element('small', '台服务器')); summary.append(count, element('p', '统一整理标签、备注和分组。每项默认保持原值；追加备注会另起一行。')); form.appendChild(summary)
  const targets = element('div', undefined, 'batch-targets')
  for (const server of servers.slice(0, 5)) targets.appendChild(element('span', server.configuration.name))
  if (servers.length > 5) targets.appendChild(element('span', '另 ' + (servers.length - 5) + ' 台'))
  form.appendChild(targets)
  const operations = element('fieldset'); form.appendChild(operations)
  const tagMode = field(operations, '标签操作', { choices: [['keep', '保持原标签'], ['add', '添加标签'], ['remove', '移除指定标签'], ['replace', '替换全部标签'], ['clear', '清空全部标签']] })
  const tags = serverTagInput(operations, [], sharedState.items.flatMap(item => item.configuration.tags || []))
  const tagWarning = element('p', '将移除所选服务器的全部标签。', 'danger-text'); operations.appendChild(tagWarning)
  const noteMode = field(operations, '备注操作', { choices: [['keep', '保持原备注'], ['append', '追加备注（另起一行）'], ['replace', '替换全部备注'], ['clear', '清空备注']] })
  const note = serverField(operations, '备注内容', { type: 'textarea', placeholder: '用途、负责人、维护事项…' }); note.maxLength = 16384
  const noteWarning = element('p', '将清空所选服务器的备注。', 'danger-text'); operations.appendChild(noteWarning)
  const groupMode = field(operations, '分组操作', { choices: [['keep', '保持原分组'], ['replace', '移入指定分组'], ['clear', '移出分组']] })
  const group = field(operations, '分组名称', { maxLength: 256, placeholder: '输入分组名称' })
  const submit = submitButton(form, '应用到 ' + servers.length + ' 台服务器', async () => {
    const changes = {}
    if (tagMode.value !== 'keep') changes.tags = { mode: tagMode.value, values: tagMode.value === 'clear' ? [] : tags.read() }
    if (noteMode.value !== 'keep') changes.note = { mode: noteMode.value, value: note.value }
    if (groupMode.value !== 'keep') changes.group = { mode: groupMode.value, value: group.value }
    operations.disabled = true
    try {
      const result = await api('/admin/shares/batch-metadata', 'POST', { items: servers.map(({ id, updatedAt }) => ({ id, updatedAt })), changes })
      select('#user-dialog').close(); notify('已更新 ' + result.updated + ' 台共享服务器'); await loadSharedServers()
    } finally { operations.disabled = false }
  })
  const refresh = () => {
    tags.wrapper.hidden = ['keep', 'clear'].includes(tagMode.value)
    tags.wrapper.querySelector('input').disabled = tags.wrapper.hidden
    tagWarning.hidden = tagMode.value !== 'clear'; noteWarning.hidden = noteMode.value !== 'clear'
    note.parentElement.hidden = ['keep', 'clear'].includes(noteMode.value); note.disabled = note.parentElement.hidden; note.required = !note.disabled
    group.parentElement.hidden = groupMode.value !== 'replace'; group.disabled = group.parentElement.hidden; group.required = !group.disabled
    submit.disabled = [tagMode, noteMode, groupMode].every(input => input.value === 'keep')
  }
  for (const input of [tagMode, noteMode, groupMode]) input.addEventListener('change', refresh)
  refresh()
}
function credentialConsent(form) {
  const wrapper = element('label', undefined, 'credential-consent'), control = element('input')
  control.type = 'checkbox'; control.required = true
  wrapper.append(control, element('span', '我确认此配置及密码 / 私钥允许本服务已登录用户下载到本机。'))
  form.appendChild(wrapper)
  return control
}
function editSharedServer(server) {
  const config = server?.configuration ?? { kind: 'ssh', port: 22, authMethod: 'password' }
  const form = dialogForm(server ? '编辑服务器 · ' + config.name : '新建共享服务器')
  form.classList.add('server-form')
  const grid = element('div', undefined, 'form-grid'); form.appendChild(grid)
  const name = serverField(grid, '服务器名称', { required: true, maxLength: 256, value: config.name || '', placeholder: '例如：生产环境 · 应用节点' })
  const kind = serverField(grid, '连接协议', { choices: [['ssh', 'SSH · 终端'], ['rdp', 'RDP · 远程桌面']], value: config.kind })
  const host = serverField(grid, '主机地址', { required: true, maxLength: 1024, value: config.host || '', placeholder: 'IP 或域名，可附带入口端口' })
  const port = serverField(grid, '服务端口', { type: 'number', required: true, value: config.port }); port.min = 1; port.max = 65535
  const username = serverField(grid, '用户名', { required: true, maxLength: 256, value: config.username || '' })
  const domain = serverField(grid, 'Windows 域', { value: config.domain || '', maxLength: 256 })
  const group = serverField(grid, '分组', { value: config.group || '', maxLength: 256, placeholder: '生产环境 / 测试环境' })
  const tags = serverTagInput(grid, config.tags || [], sharedState.items.flatMap(item => item.configuration.tags || []))
  const authentication = serverField(grid, 'SSH 认证方式', { choices: [['password', '密码'], ['privateKey', '私钥']], value: config.authMethod || 'password' })
  const secret = serverField(grid, '服务器密码', { type: 'password', required: !server, placeholder: server ? '已保存；留空保留原凭据' : '填写服务器密码' })
  const key = serverField(grid, 'SSH 私钥', { type: 'textarea', rows: 4, placeholder: server ? '已保存；留空保留原私钥' : '粘贴完整私钥内容' })
  const passphrase = serverField(grid, '私钥口令', { type: 'password', placeholder: '新私钥的口令，可选' })
  const note = serverField(form, '备注', { type: 'textarea', value: config.note || '' })
  const consent = credentialConsent(form)
  const refresh = () => {
    const ssh = kind.value === 'ssh', privateKey = ssh && authentication.value === 'privateKey'
    domain.parentElement.hidden = ssh; authentication.parentElement.hidden = !ssh
    key.parentElement.hidden = !privateKey; passphrase.parentElement.hidden = !privateKey; secret.parentElement.hidden = privateKey
    secret.required = !server && !privateKey; key.required = !server && privateKey
  }
  kind.addEventListener('change', () => { if (!server && [22, 3389].includes(Number(port.value))) port.value = kind.value === 'ssh' ? '22' : '3389'; refresh() })
  authentication.addEventListener('change', refresh); refresh()
  submitButton(form, server ? '保存服务器' : '创建服务器', async () => {
    const privateKey = kind.value === 'ssh' && authentication.value === 'privateKey'
    const value = privateKey ? key.value : secret.value
    const configuration = { ...config, kind: kind.value, name: name.value.trim(), host: host.value.trim(), port: Number(port.value), username: username.value.trim(), domain: domain.value.trim(), group: group.value.trim(), tags: tags.read(), note: note.value, authMethod: kind.value === 'ssh' ? authentication.value : 'password' }
    await api('/admin/shares' + (server ? '/' + encodeURIComponent(server.id) : ''), server ? 'PATCH' : 'POST', { configuration, credentialDisclosure: consent.checked, ...(server ? { updatedAt: server.updatedAt } : {}), ...(value ? { credential: { secret: value, ...(privateKey && passphrase.value ? { passphrase: passphrase.value } : {}) } } : {}) })
    secret.value = ''; key.value = ''; passphrase.value = ''
    select('#user-dialog').close(); notify(server ? '共享服务器已更新' : '共享服务器已创建'); await loadSharedServers()
  })
}
function deleteSharedServers(servers) {
  const form = dialogForm(servers.length === 1 ? '删除共享服务器' : '批量删除共享服务器')
  form.appendChild(element('p', '将从共享目录删除 ' + servers.length + ' 台服务器。已下载到本机的配置不受影响。此操作不可撤销。', 'confirm-copy'))
  const list = element('ul', undefined, 'delete-server-list'); for (const server of servers) list.appendChild(element('li', server.configuration.name)); form.appendChild(list)
  submitButton(form, '确认删除 ' + servers.length + ' 台', async () => {
    await api('/admin/shares/batch-delete', 'POST', { items: servers.map(server => ({ id: server.id, updatedAt: server.updatedAt })), confirmation: 'DELETE' })
    select('#user-dialog').close(); notify('已删除 ' + servers.length + ' 台共享服务器'); await loadSharedServers()
  }, 'danger')
}
function importSharedServers() {
  const form = dialogForm('导入共享服务器配置')
  let preview = null, snapshot = null, binaryContents = '', version = 0
  const selectedIndices = new Set()
  form.appendChild(element('p', '与 PC 端相同，支持 Remote Desktop Organizer 和 XTerminal；也可使用 JSON / CSV。先预览、勾选，再导入，相同协议与连接入口自动跳过。', 'muted'))
  const format = field(form, '文件格式', { choices: [['rdo', 'Remote Desktop Organizer（.rdo）'], ['xterminal', 'XTerminal（local-store.db）'], ['json', 'JSON'], ['csv', 'CSV']] })
  const hint = element('p', undefined, 'muted'); form.appendChild(hint)
  const file = field(form, '选择配置文件', { type: 'file' })
  const input = serverField(form, '或粘贴配置内容', { type: 'textarea', rows: 7, placeholder: '[{"kind":"ssh","name":"应用服务器","host":"192.0.2.10","port":22,"username":"ops","password":"服务器密码","group":"生产环境"}]' })
  const template = button('填入 JSON 示例', () => { format.value = 'json'; resetFile(); input.value = JSON.stringify([{ kind: 'ssh', name: '应用服务器', host: '192.0.2.10', port: 22, username: 'ops', password: '请替换为真实密码', group: '生产环境', note: '通过 Web 管理端导入' }], null, 2); updateFormat() }, 'table-action')
  form.appendChild(template)
  const previewArea = element('div', undefined, 'import-preview'); form.appendChild(previewArea)
  const consent = credentialConsent(form)
  const inspect = button('预览并校验', async () => { await perform(inspect, async () => {
    const requestVersion = ++version
    const payload = { contents: isBinary() ? binaryContents : input.value, format: format.value }
    if (!payload.contents) throw new Error(isBinary() ? '请先选择配置文件' : '请选择文件或粘贴配置内容')
    const result = await api('/admin/shares/import/preview', 'POST', payload)
    if (requestVersion !== version) return
    preview = result; snapshot = payload; selectedIndices.clear()
    previewArea.replaceChildren(element('strong', '可导入 ' + preview.ready + ' 台 · 重复跳过 ' + preview.skipped + ' 台 · 错误 ' + preview.errors + ' 台'))
    for (const warning of preview.warnings || []) previewArea.appendChild(element('p', warning, 'import-warning'))
    const selection = element('p', undefined, 'muted')
    const updateSelection = () => { selection.textContent = '已选 ' + selectedIndices.size + ' 台；仅导入勾选的条目。缺少账号或凭据的条目需补全后重新上传。'; submit.disabled = !selectedIndices.size }
    const list = element('ul', undefined, 'import-server-list')
    for (const item of preview.items) {
      const row = element('li', undefined, item.state === 'error' ? 'danger-text' : '')
      const label = element('label', undefined, 'import-server-option')
      const check = document.createElement('input'); check.type = 'checkbox'; check.disabled = item.state !== 'ready'
      const config = item.configuration
      check.setAttribute('aria-label', '导入 ' + (config?.name || '条目 ' + item.index))
      check.checked = item.state === 'ready' && !item.requiresReview
      if (check.checked) selectedIndices.add(item.index)
      check.addEventListener('change', () => { if (check.checked) selectedIndices.add(item.index); else selectedIndices.delete(item.index); updateSelection() })
      const details = element('span')
      const status = item.state === 'error' ? item.error : item.state === 'duplicate' ? '重复，跳过' : item.requiresReview ? '需核对后手动勾选' : '可导入'
      details.appendChild(element('strong', '#' + item.index + ' · ' + (config?.name || '无效配置') + ' · ' + status))
      if (config) details.appendChild(element('small', config.kind.toUpperCase() + ' · ' + config.host + ':' + config.port + ' · ' + config.username + (config.group ? ' · ' + config.group : '')))
      if (config?.note) details.appendChild(element('small', config.note))
      if (item.requiresReview) details.appendChild(element('small', item.reviewReason || '请核对连接信息', 'import-warning'))
      label.append(check, details); row.appendChild(label); list.appendChild(row)
    }
    previewArea.append(list, selection); updateSelection()
  }) }, 'secondary')
  form.appendChild(inspect)
  const submit = submitButton(form, '确认导入', async () => {
    if (!preview || !snapshot || !selectedIndices.size || snapshot.contents !== (isBinary() ? binaryContents : input.value) || snapshot.format !== format.value) throw new Error('请先预览并勾选需要导入的条目')
    const result = await api('/admin/shares/import', 'POST', { ...snapshot, selectedIndices: [...selectedIndices], credentialDisclosure: consent.checked })
    input.value = ''; binaryContents = ''; snapshot = null; file.value = ''
    select('#user-dialog').close(); notify('已导入 ' + result.imported + ' 台，跳过 ' + result.skipped + ' 台'); sharedState.page = 0; await loadSharedServers()
  })
  submit.disabled = true
  function isBinary() { return format.value === 'rdo' || format.value === 'xterminal' }
  function invalidate() { version++; preview = null; snapshot = null; selectedIndices.clear(); submit.disabled = true; previewArea.replaceChildren() }
  function resetFile() { invalidate(); binaryContents = ''; file.value = ''; input.value = '' }
  function updateFormat() {
    invalidate(); input.parentElement.hidden = isBinary(); template.hidden = isBinary()
    file.accept = format.value === 'rdo' ? '.rdo' : format.value === 'xterminal' ? '.db,.sqlite,.sqlite3' : '.json,.csv,application/json,text/csv'
    hint.textContent = format.value === 'rdo' ? '直接上传 PC 端支持的 .rdo 文件，读取目录、备注和身份卡关联密码。文件不超过 8 MB。' : format.value === 'xterminal' ? '先在 XTerminal 解锁并保存，再退出程序，上传配置目录 sqlite 下的 local-store.db。浏览器无法自动扫描本机配置库；未解锁的凭据不会当作密码导入。文件不超过 8 MB。' : '支持 UTF-8 JSON / CSV，文件不超过 8 MB，每批最多 1000 台。'
  }
  input.addEventListener('input', invalidate)
  format.addEventListener('change', () => { resetFile(); updateFormat() })
  file.addEventListener('change', () => { void perform(inspect, async () => {
    invalidate(); binaryContents = ''; input.value = ''
    const requestVersion = version, selected = file.files[0]; if (!selected) return
    if (selected.size > 8 * 1024 * 1024) throw new Error('配置文件不能超过 8 MB')
    const extension = selected.name.toLowerCase().split('.').at(-1)
    const source = ({ rdo: 'rdo', db: 'xterminal', sqlite: 'xterminal', sqlite3: 'xterminal', json: 'json', csv: 'csv' })[extension]
    if (!source) throw new Error('请选择 RDO、XTerminal 配置库、JSON 或 CSV 文件')
    const value = source === 'rdo' || source === 'xterminal' ? await new Promise((resolve, reject) => {
      const reader = new FileReader(); reader.onerror = () => reject(new Error('读取配置文件失败'))
      reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.readAsDataURL(selected)
    }) : await selected.text()
    if (requestVersion !== version) return
    format.value = source
    if (source === 'rdo' || source === 'xterminal') binaryContents = value
    else input.value = value
    updateFormat()
  }) })
  updateFormat()
}
function initializeSharedServers() {
  select('#create-server').addEventListener('click', () => editSharedServer())
  select('#import-servers').addEventListener('click', importSharedServers)
  select('#refresh-servers').addEventListener('click', () => void loadSharedServers())
  for (const key of ['kind', 'source']) select('#server-' + key).addEventListener('change', () => { sharedState.page = 0; void loadSharedServers() })
  let timer
  select('#server-search').addEventListener('input', () => { sharedState.page = 0; clearTimeout(timer); timer = setTimeout(() => void loadSharedServers(), 250) })
  select('#server-previous-page').addEventListener('click', () => { if (sharedState.page > 0) { sharedState.page--; void loadSharedServers() } })
  select('#server-next-page').addEventListener('click', () => { if ((sharedState.page + 1) * 50 < sharedState.total) { sharedState.page++; void loadSharedServers() } })
  select('#select-all-servers').addEventListener('change', event => { sharedState.selected = new Set(event.target.checked ? sharedState.items.map(server => server.id) : []); for (const input of select('#server-rows').querySelectorAll('input[type=checkbox]')) input.checked = event.target.checked; updateServerSelection() })
  select('#edit-selected-servers').addEventListener('click', () => batchEditSharedServers(sharedState.items.filter(server => sharedState.selected.has(server.id))))
  select('#delete-selected-servers').addEventListener('click', () => deleteSharedServers(sharedState.items.filter(server => sharedState.selected.has(server.id))))
  select('#user-dialog').addEventListener('close', () => { if (!select('#user-dialog').open) select('#dialog-content').replaceChildren() })
}
