import { applyMetadataChanges } from './shared/server-metadata.mjs'
import { randomUUID } from 'node:crypto'
import { requireAdministrator } from './admin-accounts.mjs'
import { connectionKey, formatConnectionAddress } from './shared/connection-identity.mjs'
import { normalizeSharedServer, readSharedServerDocument, sharedServerCredential } from './shared-server-import.mjs'

export function registerSharedServerManagement({ application, storage, route, fail, active, tickets }) {
  const { database, seal } = storage
  const authorize = request => requireAdministrator(database, request.account.id)
  const find = id => {
    const row = database.prepare('SELECT shares.*, users.username AS owner FROM shares JOIN users ON users.id=shares.owner_id WHERE shares.id=?').get(id)
    if (!row) fail(404, '共享服务器不存在或已被删除')
    return row
  }
  const describe = row => {
    const metadata = JSON.parse(row.metadata)
    return { id: row.id, address: formatConnectionAddress(metadata.host, metadata.port), configuration: metadata.configuration ?? metadata, owner: row.owner, source: metadata.source === 'managed' ? 'managed' : 'user', createdAt: row.created_at, updatedAt: row.updated_at, downloadable: metadata.sharingMode === 'copy', hasCredential: true }
  }
  const prepare = (body, previous) => {
    if (body?.credentialDisclosure !== true) fail(400, '请确认已登录用户下载配置时会获得服务器凭据')
    let configuration, credential
    try {
      ;({ configuration, credential } = normalizeSharedServer(body))
      credential = body.credential === undefined && previous ? null : sharedServerCredential(credential)
    } catch (error) { fail(400, error.message) }
    if (previous) {
      const before = JSON.parse(previous.metadata).configuration ?? JSON.parse(previous.metadata)
      if (!credential && (before.kind !== configuration.kind || (before.authMethod ?? 'password') !== configuration.authMethod)) fail(400, '更换协议或认证方式时需要提供新凭据')
    }
    const source = previous ? JSON.parse(previous.metadata).source : 'managed'
    return { configuration, credential, metadata: { ...configuration, configuration, source: source === 'managed' ? 'managed' : 'user', sharingMode: 'copy', ignoreCertificate: configuration.options?.ignoreCertificate !== false } }
  }
  const retire = ids => {
    const selected = new Set(ids)
    for (const [token, ticket] of tickets) if (selected.has(ticket.shareId)) tickets.delete(token)
    for (const connection of [...active.values()]) if (selected.has(connection.shareId)) connection.close()
  }
  const transaction = operation => {
    database.exec('BEGIN IMMEDIATE')
    try { const result = operation(); database.exec('COMMIT'); return result }
    catch (error) { database.exec('ROLLBACK'); if ((error.errcode & 255) === 19) fail(409, '相同协议和连接入口已存在，请刷新后重试'); throw error }
  }
  const assertRevision = (body, record) => {
    if (!Number.isSafeInteger(body?.updatedAt) || body.updatedAt !== record.updated_at) fail(409, '配置已被其他管理员更新，请刷新后重试')
  }
  application.get('/v1/admin/shares', route((request, response) => {
    authorize(request)
    const search = typeof request.query.search === 'string' ? request.query.search.trim().slice(0, 200) : ''
    const page = Number(request.query.page ?? 0)
    if (!Number.isSafeInteger(page) || page < 0 || page > 100000) fail(400, '页码无效')
    const clauses = [], parameters = []
    if (search) {
      const pattern = '%' + search.replace(/[\\%_]/g, value => '\\' + value) + '%'
      clauses.push("(json_extract(metadata,'$.name') LIKE ? ESCAPE char(92) OR json_extract(metadata,'$.host') LIKE ? ESCAPE char(92) OR json_extract(metadata,'$.username') LIKE ? ESCAPE char(92) OR json_extract(metadata,'$.group') LIKE ? ESCAPE char(92) OR json_extract(metadata,'$.note') LIKE ? ESCAPE char(92) OR users.username LIKE ? ESCAPE char(92) OR EXISTS (SELECT 1 FROM json_each(metadata,'$.tags') WHERE value LIKE ? ESCAPE char(92)))")
      parameters.push(...Array(7).fill(pattern))
    }
    if (request.query.kind) {
      if (!['ssh', 'rdp'].includes(request.query.kind)) fail(400, '协议筛选无效')
      clauses.push("json_extract(metadata,'$.kind')=?"); parameters.push(request.query.kind)
    }
    if (request.query.source) {
      if (!['managed', 'user'].includes(request.query.source)) fail(400, '来源筛选无效')
      clauses.push("coalesce(json_extract(metadata,'$.source'),'user')=?"); parameters.push(request.query.source)
    }
    const from = ' FROM shares JOIN users ON users.id=shares.owner_id' + (clauses.length ? ' WHERE ' + clauses.join(' AND ') : '')
    const total = database.prepare('SELECT count(*) AS total' + from).get(...parameters).total
    const rows = database.prepare('SELECT shares.*, users.username AS owner' + from + ' ORDER BY shares.updated_at DESC, shares.id LIMIT 50 OFFSET ?').all(...parameters, page * 50)
    const summary = database.prepare("SELECT count(*) AS total, coalesce(sum(json_extract(metadata,'$.kind')='ssh'),0) AS ssh, coalesce(sum(json_extract(metadata,'$.kind')='rdp'),0) AS rdp, coalesce(sum(json_extract(metadata,'$.source')='managed'),0) AS managed FROM shares").get()
    response.json({ total, summary, items: rows.map(describe) })
  }))
  const preview = body => {
    let document
    try { document = readSharedServerDocument(body?.contents, body?.format) } catch (error) { fail(400, error.message) }
    const seen = new Set()
    const items = document.entries.map((entry, index) => {
      let normalized
      try {
        normalized = normalizeSharedServer(entry)
        const credential = sharedServerCredential(normalized.credential)
        const key = connectionKey(normalized.configuration)
        const duplicate = seen.has(key) || !!database.prepare('SELECT id FROM shares WHERE endpoint_key=?').get(key)
        seen.add(key)
        return { index: index + 1, state: duplicate ? 'duplicate' : 'ready', ...normalized, credential, requiresReview: entry.requiresReview === true, reviewReason: entry.reviewReason }
      } catch (error) { return { index: index + 1, state: 'error', ...(normalized ? { configuration: normalized.configuration } : {}), error: error.message.replace('；编辑时留空可保留原凭据', '') } }
    })
    return { items, warnings: document.warnings }
  }
  application.post('/v1/admin/shares/import/preview', route((request, response) => {
    authorize(request)
    const { items, warnings } = preview(request.body)
    response.json({ items: items.map(({ credential, ...entry }) => entry), warnings, total: items.length, ready: items.filter(entry => entry.state === 'ready').length, skipped: items.filter(entry => entry.state === 'duplicate').length, errors: items.filter(entry => entry.state === 'error').length })
  }))
  application.post('/v1/admin/shares/import', route((request, response) => {
    authorize(request)
    if (request.body?.credentialDisclosure !== true) fail(400, '请确认共享配置包含服务器凭据')
    const result = transaction(() => {
      const all = preview(request.body).items
      const indices = request.body?.selectedIndices
      if (indices !== undefined && (!Array.isArray(indices) || !indices.length || indices.length > 1000 || new Set(indices).size !== indices.length || indices.some(index => !Number.isSafeInteger(index) || index < 1 || index > all.length))) fail(400, '请选择有效的导入条目后重新预览')
      const entries = indices === undefined ? all : all.filter(entry => indices.includes(entry.index))
      if (entries.some(entry => entry.state === 'error')) fail(400, '所选配置中仍有错误，请修正或取消勾选后重新导入；未导入任何服务器')
      if (indices === undefined && entries.some(entry => entry.requiresReview)) fail(400, '部分地址或连接路径需要核对，请在预览中明确勾选后导入')
      let imported = 0
      for (const entry of entries.filter(entry => entry.state === 'ready')) {
        const id = randomUUID(), now = Date.now()
        const { metadata, credential } = prepare({ ...entry, credentialDisclosure: true })
        database.prepare('INSERT INTO shares VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(id, request.account.id, connectionKey(entry.configuration), JSON.stringify(metadata), seal(credential, 'share:' + id), null, now, now)
        imported++
      }
      return { imported, skipped: all.length - imported }
    })
    response.status(201).json(result)
  }))
  application.post('/v1/admin/shares/batch-metadata', route((request, response) => {
    authorize(request)
    const entries = request.body?.items
    if (!Array.isArray(entries) || !entries.length || entries.length > 1000 || entries.some(item => !item || typeof item.id !== 'string' || !item.id || !Number.isSafeInteger(item.updatedAt)) || new Set(entries.map(item => item.id)).size !== entries.length) fail(400, '请选择 1–1000 台服务器，且不能重复')
    transaction(() => {
      for (const item of entries) {
        const record = find(item.id)
        assertRevision(item, record)
        const metadata = JSON.parse(record.metadata)
        let changes
        try { changes = applyMetadataChanges(metadata.configuration ?? metadata, request.body.changes) } catch (error) { fail(400, error.message) }
        Object.assign(metadata, changes)
        if (metadata.configuration) Object.assign(metadata.configuration, changes)
        database.prepare('UPDATE shares SET metadata=?, updated_at=? WHERE id=?').run(JSON.stringify(metadata), Math.max(Date.now(), record.updated_at + 1), record.id)
      }
    })
    response.json({ updated: entries.length })
  }))
  application.post('/v1/admin/shares/batch-delete', route((request, response) => {
    authorize(request)
    const entries = request.body?.items
    if (!Array.isArray(entries) || !entries.length || entries.length > 1000 || entries.some(entry => !entry || typeof entry.id !== 'string' || !entry.id || !Number.isSafeInteger(entry.updatedAt)) || request.body.confirmation !== 'DELETE') fail(400, '请确认要删除的共享服务器')
    const ids = transaction(() => {
      const ids = [...new Set(entries.map(entry => entry.id))]
      if (ids.length !== entries.length) fail(400, '删除列表中有重复记录')
      for (const entry of entries) assertRevision(entry, find(entry.id))
      for (const id of ids) database.prepare('DELETE FROM shares WHERE id=?').run(id)
      return ids
    })
    retire(ids)
    response.json({ deleted: ids.length })
  }))
  application.post('/v1/admin/shares', route((request, response) => {
    authorize(request)
    const { configuration, metadata, credential } = prepare(request.body)
    const id = randomUUID(), now = Date.now()
    transaction(() => database.prepare('INSERT INTO shares VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(id, request.account.id, connectionKey(configuration), JSON.stringify(metadata), seal(credential, 'share:' + id), null, now, now))
    response.status(201).json(describe(find(id)))
  }))
  application.get('/v1/admin/shares/:id', route((request, response) => { authorize(request); response.json(describe(find(request.params.id))) }))
  application.patch('/v1/admin/shares/:id', route((request, response) => {
    authorize(request)
    transaction(() => {
      const record = find(request.params.id)
      assertRevision(request.body, record)
      const { configuration, metadata, credential } = prepare(request.body, record)
      database.prepare('UPDATE shares SET endpoint_key=?, metadata=?, credential=?, host_key=NULL, updated_at=? WHERE id=?').run(connectionKey(configuration), JSON.stringify(metadata), credential ? seal(credential, 'share:' + record.id) : record.credential, Math.max(Date.now(), record.updated_at + 1), record.id)
    })
    retire([request.params.id])
    response.json(describe(find(request.params.id)))
  }))
  application.delete('/v1/admin/shares/:id', route((request, response) => {
    authorize(request)
    transaction(() => { const record = find(request.params.id); assertRevision(request.body, record); database.prepare('DELETE FROM shares WHERE id=?').run(record.id) })
    retire([request.params.id])
    response.json({ ok: true })
  }))
}
