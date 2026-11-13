// Metadata-only edits: keep credentials, connection options and ownership intact.
export function applyMetadataChanges(current, changes) {
  const invalid = message => { throw new Error(message) }
  if (!changes || typeof changes !== 'object' || Array.isArray(changes) || !Object.keys(changes).length || Object.keys(changes).some(key => !['tags', 'note', 'group'].includes(key))) invalid('请选择要修改的标签、备注或分组')
  const result = {}
  for (const [key, operation] of Object.entries(changes)) {
    if (!operation || typeof operation !== 'object' || Array.isArray(operation)) invalid('批量编辑操作格式不正确')
    const { mode } = operation
    if (key === 'tags') {
      if (!['add', 'remove', 'replace', 'clear'].includes(mode)) invalid('标签操作无效')
      const values = mode === 'clear' ? [] : operation.values
      if (!Array.isArray(values) || values.length > 100 || values.some(value => typeof value !== 'string' || !value.trim() || value.trim().length > 128 || /[\0\r\n]/.test(value))) invalid('标签不能为空，每个最多 128 字，最多 100 个')
      const tags = [...new Set(values.map(value => value.trim()))]
      if (mode !== 'clear' && !tags.length) invalid('请至少输入一个标签；清空标签请使用清空操作')
      const before = current.tags ?? []
      result.tags = mode === 'add' ? [...new Set([...before, ...tags])] : mode === 'remove' ? before.filter(value => !tags.includes(value)) : tags
      if (result.tags.length > 100) invalid('修改后标签超过 100 个，请减少标签')
    } else {
      if (!(key === 'note' ? ['append', 'replace', 'clear'] : ['replace', 'clear']).includes(mode)) invalid('备注或分组操作无效')
      const value = mode === 'clear' ? '' : operation.value
      if (typeof value !== 'string' || value.includes('\0') || (key === 'group' && /[\r\n]/.test(value)) || (mode !== 'clear' && !value.trim())) invalid('请输入内容；清空内容请使用清空操作')
      const text = value.trim()
      result[key] = mode === 'append' && current[key] ? current[key] + '\n' + text : text
      if (result[key].length > (key === 'note' ? 16384 : 256)) invalid(key === 'note' ? '修改后备注超过 16384 字' : '分组最多 256 字')
    }
  }
  return result
}
