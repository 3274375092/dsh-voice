# dsh-voice 使用手册(纯语音输入)

> 形态:DeepSeek Harness 的 web UI 输入框左侧出现 🎤 按钮 —— 点击说话,
> 识别文本作为普通消息提交(与打字完全同路)。**没有语音朗读输出**,
> 与 agent preset/人设完全解耦,任何模式(code/standard/minimal/自定义)下通用。

## 一、安装(一次性)

```sh
# 1. 把插件装进 web profile(包声明 dsh.bundle,会自动进 bundles 层)
dsh plugin --profile web add @nn12138/dsh-voice
#    本地开发调试可改用源码路径: dsh plugin --profile web add D:/.../dsh-voice

# 2. 装原生识别运行时(插件不自动安装;想要离线识别才需要,浏览器在线识别可跳过)
dsh plugin --profile web add sherpa-onnx-node

# 3. 模型文件(native 识别需要):复用 voxelf 的 assets/models
#    (asr-zh: encoder.int8.onnx / decoder.onnx / joiner.int8.onnx / tokens.txt;
#     vad: silero_vad.onnx),把路径填进下面的 modelDir。
```

## 二、配置(可选,进 profile 的 cordis.patch.yml)

```yaml
- id: voice
  config:
    engine: auto        # auto(默认,ping 探测) | native(仅离线;模型缺失时回退) | browser(强制 Web Speech)
    # 行内 config 由 host 半接收;engine 经 /voice.config 同步到浏览器半
    modelDir: 'D:/code/voxelf/assets/models'   # native 识别模型目录
    asrDir: 'asr-zh-en-2025'   # ASR 模型子目录: asr-zh(纯中文,默认)| asr-zh-en-2025(中英双语)
```

## 三、日常使用与快捷键

**全局快捷键(默认 Ctrl+Space)**:页面任意位置(输入框外)按一下 = 开关当前会话的麦克风,再按一次停止并提交。按钮悬浮提示会显示当前快捷键。

配置(可改,避免与系统/输入法冲突):

```yaml
- id: voice
  config:
    hotkey: 'ctrl+space'   # 或 alt+m / ctrl+shift+p 等;输入框聚焦时自动不触发
```

> `hotkey` 写在行内 config 即可:host 半启动后经 `/voice.config` 把它同步给浏览器半;插件在 RPC 到达前先用默认 `ctrl+space` 兜底。**修改配置后需要重启 `dsh web` 才生效。**

> ⚠️ Ctrl+Space 是 Windows 中文输入法的经典切换键。若你的输入法占用:在输入框里打字时插件**不会**拦截(输入框聚焦自动豁免);输入框外若被系统级输入法抢走按键,请换一个组合(如 alt+m)。

## 四、日常使用

1. `dsh web` 启动。
2. 输入框**左侧 🎤 按钮**。
3. 点击 🎤(浏览器弹麦克风授权,允许)。
4. 说话 → 再点一次(或自动停)停止 → 识别文本作为普通消息提交。
5. 回复照常流式渲染 —— 朗读与否与插件无关,由会话/系统自行决定。

按钮状态:🎤 空闲 / 红底 ■ 正在听。

## 五、ASR 模型选择

| 模型(asrDir) | 语言 | 特点 |
|---|---|---|
| `asr-zh`(默认) | 纯中文 | 中文最准;英文词/短语弱 |
| `asr-zh-en-2025` | 中英双语 | zipformer2 双语(2025-02);实测英文效果仍差,已弃用,默认回纯中文 |
| 备选(需另下模型) | 多语 | SenseVoice-Small(阿里,中英日韩粤 + 自动标点,非流式,需插件加 Offline 后端) |

## 六、引擎选择对照

| 维度 | auto(默认) | native(host) | browser(Web Speech) |
|---|---|---|---|
| 选择方式 | `/voice.ping` 探测:有模型 → native,否则 → browser | 仅离线识别;模型缺失时同样回退 browser | 强制浏览器在线识别 |
| 识别 | 视探测结果 | sherpa-onnx zipformer2 + VAD,离线 | 浏览器在线识别,需联网 |
| 依赖 | 同探测结果 | sherpa-onnx-node + 模型(~100MB) | 无 |
| 适用 | 零配置、开箱即用 | 隐私/离线优先 | 快速体验 |

## 七、常见问题

- **没看到 🎤**:确认 profile 的 bundles 包含 dsh-voice,并重启了 `dsh web`。
- **点击没反应**:检查浏览器麦克风权限;控制台看 `[dsh-voice]` 前缀日志。
- **native 不生效**:`/voice.ping` 返回 `native:false` → 检查 modelDir 路径与 sherpa-onnx-node 是否装进同一 profile。
- **说话出不来字**:确保说完后再点一次停止(final 冲刷);浏览器实际采样率 ≠ 16k 时插件会自动重采样。
- **首次识别慢**:Defender 首次扫 onnxruntime.dll,后续正常。

## 八、开发备忘(插件作者)

- 构建顺序:先 `tsc`(host 半 lib/index.js)再 `tsdown --config tsdown.config.ts`(client 半 lib/client.js);tsc 重发会抹掉 client.js,务必按序。`pnpm --ignore-workspace build` 已封装该顺序。
- 独立测试:`pnpm --ignore-workspace test`(含 native ASR 冒烟:真实 wav 出中文)。
- 线协议冒烟(可选):`node tools/asr-smoke.cjs`(对运行中的实例走 /voice.asr 通道)。
