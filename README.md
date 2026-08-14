# dsh-voice 🎤

DeepSeek Harness 的语音输入插件:网页里点 🎤(或按快捷键)说话,识别文本作为普通消息提交进会话。**纯输入**,与 agent preset/人设完全解耦,任何模式下都只是"另一种输入法"。

[![npm](https://img.shields.io/npm/v/dsh-voice)](https://www.npmjs.com/package/dsh-voice)
[![License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

## 特性

- 🎤 **语音输入**:麦克风按钮(平台设计系统 UI)+ 全局快捷键(默认 Ctrl+Space,可配)
- ⚡ **边说边识别**:live-stream 部分识别实时回显,停麦 VAD 定稿提交(句首句尾完整,尾音补偿 0.6s)
- 🧠 **双引擎自适应**:host 原生(sherpa-onnx-node zipformer2 + silero VAD,离线、隐私)与浏览器在线(Web Speech,零依赖)自动探测降级
- 🔌 **与 preset 解耦**:不碰 persona/系统提示词,code/standard/minimal/自定义 preset 全通用
- 📦 **可选模型**:零配置开箱即用;想要原生一条 `dsh-voice-models` 下载

## 安装

```sh
# 插件本体
dsh plugin --profile web add dsh-voice

# 可选: 离线原生识别
dsh plugin --profile web add sherpa-onnx-node
dsh-voice-models            # 一键下载模型(~100MB)→ ./dsh-voice-models

# 可选: 配置(编辑 ~/.dsh/profiles/web/cordis.patch.yml)
```

```yaml
- id: voice
  config:
    modelDir: './dsh-voice-models'   # 原生识别模型目录
    hotkey: 'ctrl+space'             # 全局快捷键
    vadThreshold: 0.3                # 越低越不吞句首尾
    tailPadSeconds: 0.6              # 尾音补偿时长
```

```sh
dsh web   # 输入框左侧 🎤 或 Ctrl+Space
```

详见 [USAGE.md](USAGE.md) 与 [INSTALL.md](INSTALL.md)。

## 工作原理

```
浏览器采麦(自动重采样 16k)
   → PCM base64 分块(256ms)→ /voice RPC 通道(loopback)
   → host: silero VAD + zipformer2 流式解码
   → partial 逐块回传(边说边看)/ final 定稿(精确句首 + 0.6s 尾音补偿)
   → conversation 服务提交(与打字同路)
```

双引擎:客户端 ping `/voice` 探测 host 原生能力;不可用自动降级浏览器 Web Speech。

## 开发

```sh
pnpm install --ignore-workspace   # 独立依赖(不依赖 DSH monorepo)
pnpm test                         # 单测(含真实模型冒烟)
pnpm typecheck && pnpm build      # 构建(tsc host 半 + tsdown client 半)
```

结构:`src/index.ts`(host 半)/ `src/client/`(浏览器半)/ `src/core/`(识别核心)/ `tools/`(线协议冒烟 + 模型下载)。

## License

MIT
