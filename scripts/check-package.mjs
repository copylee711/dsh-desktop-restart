import { readFileSync, existsSync } from 'node:fs'

const packed = JSON.parse(readFileSync(process.argv[2] || 'package-manifest.json', 'utf8'))
const manifest = Array.isArray(packed) ? packed[0] : Object.values(packed)[0]
const paths = new Set(manifest.files.map(file => file.path))

for (const required of [
  'lib/index.js',
  'lib/helper.cjs',
  'lib/client.js',
  'lib/types/index.d.ts',
  'cordis.patch.yml',
  'README.md',
  'assets/footer-idle.png',
  'assets/market-pending.png',
  'LICENSE',
]) {
  if (!paths.has(required)) throw new Error(`Missing package file: ${required}`)
}

for (const path of paths) {
  if (/^assets\//.test(path) && !['assets/footer-idle.png', 'assets/market-pending.png'].includes(path)) {
    throw new Error(`Unapproved screenshot packaged: ${path}`)
  }
  if (/^(\.qa|scripts|tests|node_modules)\//.test(path) || /\.npmrc$/.test(path)) {
    throw new Error(`Private or development file packaged: ${path}`)
  }
}

const clientCode = readFileSync('lib/client.js', 'utf8')
if (!/window\.__ModuleLoader__\.load\(\{\s*id:\s*"@copylee\/dsh-desktop-restart"/.test(clientCode)) {
  throw new Error('lib/client.js is missing the expected ModuleLoader banner')
}
// Ensure client.js parses cleanly as a function body
new Function(clientCode)

const expected = JSON.parse(readFileSync('package.json', 'utf8'))
if (manifest.name !== expected.name || manifest.version !== expected.version) {
  throw new Error('Unexpected package identity')
}

if (!existsSync('lib/helper.cjs')) {
  throw new Error('lib/helper.cjs not found on disk')
}

console.log(`Package verified: ${manifest.filename}; ${paths.size} files; private files excluded`)
