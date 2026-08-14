# dsh-voice 安装指南(面向最终用户)

> 仓库: https://github.com/3274375092/dsh-voice

## 一键安装(已发布到 npm 后)

```sh
# 0. 前置: 已安装 DeepSeek Harness CLI(npm i -g @deepseek-ai/dsh 或官方安装方式)
# 1. 安装插件(自动进入 web profile 的 bundles)
dsh plugin --profile web add dsh-voice

# 2. (可选,想要离线原生识别)安装识别运行时
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
```

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
| 没看到 🎤 | 确认 `dsh plugin --profile web list` 含 dsh-voice,并重启 dsh web |
| /voice.ping 返回 native:false | modelDir 未配置/模型文件缺失,或 sherpa-onnx-node 没装进该 profile |
| 点击没反应 | 检查浏览器麦克风权限;F12 看 [dsh-voice] 日志 |
| 中文输入法吃掉 Ctrl+Space | 换 hotkey,如 alt+m |

## 开发者发布(插件作者)

```sh
cd scratch-plugin/dsh-voice
npm login --registry=https://registry.npmjs.org      # 首次
npm run build                                          # 构建(自动 clean)
npm publish --registry=https://registry.npmjs.org      # 发布
```

> 注意:本机 npm 默认源是 npmmirror(只读镜像),发布必须显式指到 registry.npmjs.org。
