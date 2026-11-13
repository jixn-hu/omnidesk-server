import test from 'node:test'
import assert from 'node:assert/strict'
import { sharedConfiguration } from '../shared/shared-configuration.mjs'

test('shared copies retain explicit RDP engine and security choices', () => {
  const configuration = { name: 'QA FreeRDP', kind: 'rdp', host: '192.0.2.1', port: 3389, username: 'qa', options: { engine: 'freerdp', securityMode: 'legacy', ignoreCertificate: false, performanceMode: 'balanced' } }
  assert.deepEqual(sharedConfiguration(configuration).options, configuration.options)
  assert.throws(() => sharedConfiguration({ ...configuration, options: { engine: 'invalid' } }), /引擎/)
  assert.throws(() => sharedConfiguration({ ...configuration, options: { securityMode: 'invalid' } }), /安全模式/)
  const compatible = sharedConfiguration({ ...configuration, options: { ignoreCertificate: false } })
  assert.deepEqual(compatible.options, { ignoreCertificate: false })
})
