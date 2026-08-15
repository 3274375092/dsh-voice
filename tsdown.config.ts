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
    // vendored 库必须内联(模块表无此条目)。alwaysBundle 必须显式声明:
    // tsdown 会默认外部化 package.json dependencies 中的包,仅 onlyBundle
    // 只做审计,不会改变外部化决策。
    alwaysBundle: ['@deepseek-ai/schemastery', '@deepseek-ai/cosmokit'],
    onlyBundle: ['@deepseek-ai/schemastery', '@deepseek-ai/cosmokit'],
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
