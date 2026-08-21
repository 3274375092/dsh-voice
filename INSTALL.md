# dsh-voice 安装指南(面向最终用户)

> 仓库: https://github.com/3274375092/dsh-voice

## 一键安装(从 npm 安装)

```sh
# 0. 前置: 已安装 DeepSeek Harness CLI(npm i -g @deepseek-ai/dsh 或官方安装方式)
# 1. 安装插件(自动进入 web profile 的 bundles)
dsh plugin --profile web add @nn12138/dsh-voice

# 2. (可选,想要离线原生识别)安装识别运行时(不随插件自动安装)
dsh plugin --profile web add sherpa-onnx-node

# 2b. (可选)一键下载识别模型(~100MB,zipformer2 中文 + VAD,hf-mirror 源)
dsh-voice-models                     # 下载到 ./dsh-voice-models
dsh-voice-models D:/models/voice     # 或指定目录

# 3. (可选)配置: 编辑 ~/.dsh/profiles/web/cordis.patch.yml
```

```yaml
# 离线识别的模型目录(voxelf 用户直接复用;否则下载 sherpa-onnx 的
# zipformer2 中文模型 + silero_vad 放到任意目录再指过来)
- id: voice
  config:
    modelDir: './dsh-voice-models'     # 或 voxelf 用户的 'D:/code/voxelf/assets/models'
    hotkey: 'ctrl+space'
    engine: auto                       # auto(默认) | native | browser
```

> `hotkey` / `engine` 写在这里即可生效:host 半会把它们经 `/voice.config` 同步给浏览器半。`engine: auto` 时无模型会自动回退 Web Speech;修改配置后重启 `dsh web`。

```sh
# 4. 重启并打开 web UI
dsh web
```

使用:输入框左侧 🎤 按钮,或快捷键 Ctrl+Space。识别文本作为普通消息提交。

## 模型获取(未安装 voxelf 的用户)

纯中文识别需要两个模型,均可从 sherpa-onnx 官方 release 下载:

- zipformer2 中文流式模型(encoder.int8.onnx / decoder.onnx / joiner.int8.onnx / tokens.txt)
  参考: https://github.com/k2-fsa/sherpa-onnx/releases/tag/asr-models
- VAD: https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx

目录结构(把 modelDir 指到包含以下内容的目录):

```
<modelDir>/
├── asr-zh/
│   ├── encoder.int8.onnx
│   ├── decoder.onnx
│   ├── joiner.int8.onnx
│   └── tokens.txt
└── vad/
    └── silero_vad.onnx
```

不装模型也可以:插件自动降级为浏览器在线识别(Web Speech),零依赖开箱即用。

## 故障排查

| 现象 | 处理 |
|---|---|
| 启动报 `Failed to load plugins ... without registering "@nn12138/dsh-voice" via __ModuleLoader__.load` | 客户端 bundle 注册 id 与包名不一致:重新 `npm run build`,把 `lib/client.js`(及 `.map`)同步到 profile 安装目录后重启;升级到修复版本后无需手工处理 |
| 没看到 🎤 | 确认 `dsh plugin --profile web list` 含 @nn12138/dsh-voice,并重启 dsh web |
| /voice.ping 下发 engine: browser | modelDir 未配置/模型缺失或加载失败、sherpa-onnx-node 没装,或 engine: browser 显式关闭 |
| 点击没反应 | 检查浏览器麦克风权限;F12 看 [dsh-voice] 日志 |
| 中文输入法吃掉 Ctrl+Space | 换 hotkey(如 alt+m)并重启 dsh web |

## 开发者发布(插件作者)

```sh
cd scratch-plugin/dsh-voice
npm login --registry=https://registry.npmjs.org      # 首次
npm run build                                          # 构建(自动 clean;本地发布前建议先跑)
node scripts/verify-package.cjs                       # 发布包校验:无安装期脚本 + 产物完整
npm publish --registry=https://registry.npmjs.org      # 发布(prepack 自动构建;消费者安装不跑任何脚本)
```

> 注意:本机 npm 默认源是 npmmirror(只读镜像),发布必须显式指到 registry.npmjs.org。

推荐走 CI 发布:推送 `v<版本号>` 标签(如 `v0.2.6`)触发 `.github/workflows/release.yml`,在 CI 内完成
构建 → 校验(`scripts/verify-package.cjs`)→ `npm publish --ignore-scripts --provenance`,
发布的是 CI 构建产物且带供应链签名;需先在仓库 secrets 配置 `NPM_TOKEN`。
发布包不再包含任何安装期生命周期脚本(`prepare` 已于 0.2.6 移除,构建只在发布方侧 `prepack` 执行),
`--ignore-scripts` 安装后插件可正常加载(issue #2)。
