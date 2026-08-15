import { defineConfig } from 'tsdown'

/** 平台模块表(与 packages/client/web/src/platform.ts 一致)+ runtime 豁免 */
const CLIENT_EXTERNALS = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-schema-form',
  '@deepseek-ai/dsh-client-runtime/client',
]

/** 复刻官方 clientConfig:闭包工厂产物,由 modules 服务为 /plugins/voice/client.js */
export default defineConfig({
  entry: { client: 'src/client/index.ts' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  dts: false,
  sourcemap: true,
  clean: false,
  deps: {
    // 平台模块外部化(浏览器由模块表提供)
    neverBundle: CLIENT_EXTERNALS,
    // client 半已无 vendored 依赖(原 schemastery/cosmokit 随客户端 Config
    // schema 删除而退出),不再需要 alwaysBundle/onlyBundle。
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
    'import.meta.env.MODE': JSON.stringify('production'),
    'import.meta.env': JSON.stringify({ MODE: 'production' }),
  },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: 'window.__ModuleLoader__.load({ id: "@nn12138/dsh-voice", factory: (require) => {',
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
})
