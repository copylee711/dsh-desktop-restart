import type { UserConfig } from 'tsdown'

const host: UserConfig = {
  name: '@copylee/dsh-desktop-restart',
  entry: { index: 'lib/types/index.js' },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  deps: { neverBundle: ['@deepseek-ai/cordis', '@deepseek-ai/schemastery'], onlyBundle: false },
}

const helper: UserConfig = {
  name: '@copylee/dsh-desktop-restart/helper',
  entry: { helper: 'lib/types/helper.js' },
  outDir: 'lib',
  format: ['cjs'],
  platform: 'node',
  target: 'es2022',
  dts: false,
  clean: false,
  deps: { onlyBundle: false },
  outputOptions: {
    entryFileNames: 'helper.cjs',
  },
}

const client: UserConfig = {
  name: '@copylee/dsh-desktop-restart/client',
  entry: { client: 'lib/types/client/index.js' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  dts: false,
  clean: false,
  deps: {
    neverBundle: ['react', 'react/jsx-runtime', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
    onlyBundle: false,
  },
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: 'window.__ModuleLoader__.load({ id: "@copylee/dsh-desktop-restart", factory: (require) => {',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
    footer: 'return module.exports; } });',
  },
}

export default [host, helper, client]
