import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openStorage } from '../storage.mjs'
import { createOfficialServer } from '../server.mjs'

test('original account schema upgrades without changing passwords, sync contents or master key', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'omnidesk-original-schema-'))
  const key = randomBytes(32)
  writeFileSync(join(directory, 'server-master.key'), key)
  const legacy = new DatabaseSync(join(directory, 'official.sqlite'))
  legacy.exec('CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, salt TEXT NOT NULL, password_hash TEXT NOT NULL, sync_key TEXT NOT NULL, created_at INTEGER NOT NULL)')
  const insert = legacy.prepare('INSERT INTO users VALUES (?, ?, ?, ?, ?, ?)')
  insert.run('qa_first', 'qa_first', 'QA-salt', 'QA-existing-password-hash', 'QA-encrypted-sync-key', 100)
  insert.run('qa_second', 'qa_second', 'QA-salt', 'QA-existing-password-hash', 'QA-encrypted-sync-key', 200)
  legacy.close()
  for (let attempt = 0; attempt < 2; attempt++) {
    const storage = openStorage(directory)
    try {
      const users = storage.database.prepare('SELECT * FROM users ORDER BY created_at').all()
      assert.deepEqual(users.map(user => user.role), ['admin', 'user'])
      assert.deepEqual(users.map(user => user.disabled), [0, 0])
      for (const user of users) {
        assert.equal(user.password_hash, 'QA-existing-password-hash')
        assert.equal(user.sync_key, 'QA-encrypted-sync-key')
      }
      assert.deepEqual(readFileSync(join(directory, 'server-master.key')), key)
      if (attempt === 0) storage.database.prepare('INSERT INTO settings VALUES (?, ?)').run('registrationOpen', 'true')
    } finally { storage.close() }
  }
  const service = createOfficialServer({ directory, registration: false })
  try { assert.equal(service.storage.database.prepare('SELECT value FROM settings WHERE key=?').get('registrationOpen').value, 'true') }
  finally { await service.close() }
})
