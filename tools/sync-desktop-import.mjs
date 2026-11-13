import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const desktop = fileURLToPath(new URL('../../omnidesk/', import.meta.url))
const { buildSync } = createRequire(resolve(desktop, 'package.json'))('esbuild')
const result = buildSync({
  absWorkingDir: desktop,
  stdin: { contents: "export { parseRdo } from './src/main/services/rdo-import.ts'; export { parseXTerminalRecords, candidateToConnection } from './src/main/services/xt-import.ts'", resolveDir: desktop, sourcefile: 'web-import-exports.ts', loader: 'ts' },
  bundle: true, platform: 'node', format: 'esm', target: 'node22', packages: 'external',
  alias: { '@shared': resolve(desktop, 'src/shared') }, write: false, legalComments: 'none'
})
const contents = '// Generated from the PC import parsers; update with node tools/sync-desktop-import.mjs.\n' + result.outputFiles[0].text
if (/\brequire\(|from ["'](?:electron|node:fs|node:os)/.test(contents)) throw new Error('The shared import bundle must only contain data parsers')
const target = new URL('../shared/desktop-import.mjs', import.meta.url)
if (process.argv.includes('--check')) {
  if (readFileSync(target, 'utf8') !== contents) throw new Error('Desktop import parsers changed; run node tools/sync-desktop-import.mjs')
} else writeFileSync(target, contents)
console.log('PASS Web import uses the same RDO / XTerminal parsing rules as PC')
