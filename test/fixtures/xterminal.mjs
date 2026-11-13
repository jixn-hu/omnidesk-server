import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
export function xterminalFixture(directory) {
  const path = join(directory, 'local-store.db'), db = new DatabaseSync(path)
  db.exec('CREATE TABLE local_store (store_key TEXT PRIMARY KEY, payload TEXT)')
  const add = (kind, id, value) => db.prepare('INSERT INTO local_store VALUES (?,?)').run(kind + ':' + id, JSON.stringify(value))
  add('GroupDatabaseServerImp', 'root', { _id: 'root', name: 'QA 公司' })
  add('GroupDatabaseServerImp', 'child', { _id: 'child', name: 'QA 应用', parentId: 'root' })
  add('IdentityDatabaseServerImp', 'identity', { _id: 'identity', authType: 'privateKey', isReady: true, privateKey: { username: 'qa-key', privateKey: 'QA-synthetic-private-key', passphrase: 'QA-key-passphrase' } })
  add('ServerDatabaseServerImp', 'ssh', { title: 'QA XTerminal SSH', host: '192.0.2.21', port: 2222, authType: 'identity', identityId: 'identity', groupId: 'child', note: 'QA SSH 备注' })
  add('RdpDatabaseServerImp', 'rdp', { title: 'QA XTerminal RDP', authDecrypted: { address: '192.0.2.22', port: 3389, username: 'qa-windows', password: 'QA-xterminal-password', domain: 'QA' }, groupId: 'root', note: 'QA RDP 备注' })
  add('ServerDatabaseServerImp', 'locked', { title: 'QA 未解锁连接', host: '192.0.2.23', username: 'qa', password: 'QA-cipher-not-a-password', isReady: false })
  add('ServerDatabaseServerImp', 'inferred', { title: '192.0.2.24', username: 'qa', password: 'QA-inferred-password', isReady: true })
  db.close()
  return path
}
