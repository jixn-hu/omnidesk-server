const PASSWORD = 'QA-rdo-password'
const CIPHER = '8bcb29d41d5729640961173d06f19b91353dd3b3017121879df1348cfc16cecd'
const UNICODE_PASSWORD = 'QA-rdo-密码-🖥️'
const UNICODE_CIPHER = '8d396120c5bb35e7790bd8f09fafc00fb84fb6ac159af648e2590270cc81faf7'
const object = (type, members, primitives = {}) => ({ type, members, primitives })
const list = entries => object('System.Collections.ArrayList', { _items: [...entries, null, null], _size: entries.length, _version: 1 })
const guid = seed => object('System.Guid', { _a: seed, _b: -1, _c: -2, _d: 128, _e: 1, _f: 2, _g: 3, _h: 4, _i: 5, _j: 6, _k: 7 },
  { _a: 8, _b: 7, _c: 7, _d: 2, _e: 2, _f: 2, _g: 2, _h: 2, _i: 2, _j: 2, _k: 2 })
const remote = fields => object('RDO.Data.Types.RemoteDesktop', {
  Text: 'QA RDO server', Description: 'QA note\nsecond line', Host: '192.0.2.1', Port: 3389, Domain: 'QA', User: 'qa-direct',
  Password: CIPHER, UseIdCard: false, IdCardGuid: guid(0), SmartSize: true, ColorDepth: 16, AudioSetting: 2,
  AuthenticationLevel: 2, AllowWallpaper: false, AllowContents: false, AllowAnimation: false, AllowThemes: true,
  GatewayUsage: 0, EnableCredSspSupport: true, ...fields
})
const folder = (name, entries) => object('RDO.Data.Types.Folder', { Text: name, Description: '', Nodes: list(entries) })
function fixture({ entries, identities } = {}) {
  const identity = object('RDO.Data.Types.IdCard', { Text: 'QA shared identity', Description: '', User: 'QA\\qa-shared', Password: UNICODE_CIPHER, ID: guid(-12345) })
  const connections = entries || [folder('QA 生产', [folder('QA Windows', [
    remote({ Text: 'QA shared', UseIdCard: true, IdCardGuid: guid(-12345) }),
    remote({ Text: 'QA duplicate', User: 'qa-another' }),
    remote({ Text: 'QA tunnel', Host: '198.51.100.10:9101' })
  ])])]
  return object('RDO.Data.Types.Root', { Nodes: list([
    object('RDO.Data.Types.IdCards', { Nodes: list(identities || [identity]) }),
    object('RDO.Data.Types.Connections', { Nodes: list(connections) })
  ]) })
}

function encodeNrbf(root) {
  const chunks = []
  const ids = new Map()
  const metadata = new Map()
  let nextId = 1
  const byte = value => chunks.push(Buffer.from([value]))
  const int = value => { const bytes = Buffer.alloc(4); bytes.writeInt32LE(value); chunks.push(bytes) }
  const text = value => {
    const bytes = Buffer.from(value, 'utf8')
    let length = bytes.length
    while (length >= 128) { byte((length & 127) | 128); length >>>= 7 }
    byte(length); chunks.push(bytes)
  }
  const primitive = (value, type) => {
    if (type === 1 || type === 2) byte(Number(value))
    else if (type === 7) { const bytes = Buffer.alloc(2); bytes.writeInt16LE(value); chunks.push(bytes) }
    else if (type === 8) int(value)
    else throw new Error('Unsupported synthetic primitive')
  }
  const write = value => {
    if (value === null) { byte(10); return }
    if (ids.has(value)) { byte(9); int(ids.get(value)); return }
    if (typeof value === 'boolean' || typeof value === 'number') { byte(8); byte(typeof value === 'boolean' ? 1 : 8); primitive(value, typeof value === 'boolean' ? 1 : 8); return }
    const id = nextId++
    ids.set(value, id)
    if (typeof value === 'string') { byte(6); int(id); text(value); return }
    if (Buffer.isBuffer(value)) { byte(15); int(id); int(value.length); byte(2); chunks.push(value); return }
    if (Array.isArray(value)) {
      byte(16); int(id); int(value.length)
      for (let index = 0; index < value.length; index++) {
        let nulls = 0
        while (index + nulls < value.length && value[index + nulls] === null) nulls++
        if (nulls > 1) { byte(14); int(nulls); index += nulls - 1 }
        else write(value[index])
      }
      return
    }
    const names = Object.keys(value.members)
    const types = names.map(name => value.primitives[name] || (typeof value.members[name] === 'boolean' ? 1 : typeof value.members[name] === 'number' ? 8 : 0))
    const signature = JSON.stringify([value.type, names, types])
    if (metadata.has(signature)) { byte(1); int(id); int(metadata.get(signature)) }
    else {
      metadata.set(signature, id)
      const system = value.type.startsWith('System.')
      byte(system ? 4 : 5); int(id); text(value.type); int(names.length)
      names.forEach(text)
      types.forEach(type => byte(type ? 0 : 2))
      types.filter(Boolean).forEach(byte)
      if (!system) int(1)
    }
    names.forEach((name, index) => types[index] ? primitive(value.members[name], types[index]) : write(value.members[name]))
  }
  byte(0); int(1); int(-1); int(1); int(0)
  byte(12); int(1); text('RDO, Version=1.7.6.0, Culture=neutral, PublicKeyToken=null')
  write(root)
  byte(11)
  return Buffer.concat(chunks)
}

module.exports = { PASSWORD, CIPHER, UNICODE_PASSWORD, UNICODE_CIPHER, object, list, guid, remote, folder, fixture, encodeNrbf }
