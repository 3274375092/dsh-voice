# dsh-voice

DeepSeek Harness 的语音输入插件:按下麦克风按钮或全局快捷键,把一段语音识别成文本,作为普通消息提交到当前会话。识别可在浏览器本地(Web Speech)或宿主离线模型(sherpa-onnx)完成。

## Language

**引擎 (engine)**:
执行语音识别的技术后端:浏览器(Web Speech)或原生(宿主侧离线模型);auto 表示按宿主能力自动选择。
_Avoid_: 后端、provider

**生效引擎 (effective engine)**:
由宿主从(配置引擎、原生能力)解析出的本轮实际引擎(browser 或 native);能力以模型真实加载结果为准,客户端只消费宿主下发的结果,不自行决策。
_Avoid_: resolved engine、探测结果

**识别器 (recognizer)**:
一个引擎在客户端侧的适配器;自持采声,独自完成一轮识别的识别与定稿,对调用方呈现统一的开始/停止/文本回调契约。
_Avoid_: service、handler

**识别会话 (recognition session)**:
宿主侧按会话隔离的识别状态(VAD、live partial 流、尾音缓冲),并发会话互不串音;受 LRU 上限约束,满时最久未用的会话被驱逐——被驱逐的会话若仍在说话,一句话会被拆断(有意的容量取舍)。
_Avoid_: 连接、上下文

**轮次 (round)**:
从开麦到停麦提交的一次完整识别。全局同时只有一轮;别的会话点停会停掉当前轮,但文本仍提交给开启本轮的那个会话。
_Avoid_: 会话、请求

**替换式定稿 (replace-final)**:
定稿文本的交付形式:final 事件携带本轮累计定稿全文,接收方整体覆盖而非拼接。
_Avoid_: 增量定稿、append

**部分识别 (partial)**:
未定稿的中间文本,仅供实时回显;停麦时若没有定稿则作为兜底提交。
_Avoid_: interim、临时文本

**自然结束 (natural end)**:
识别器自行判定语音结束而结束轮次(仅浏览器引擎存在);原生引擎只能由用户点停。
_Avoid_: auto-stop

## DSH 兼容性

插件跟随 DSH 0.1.5-rc.1 的 API。以下三条是**有意的结构决策**,改动前请先读:

**连接面显式声明 (explicit connection face)**:
`connection` 的 host/client 两面在 0.1.5 被拆开:只有 host 入口(root)augment
`Context.connection`,而 `/client` 子路径导出 `ClientConnectionRpc` / `ConnectionHandle`
却**不** augment Context。因此客户端插件不能从共享 `Context` 类型上读到 `.rpc.call`,
也**不应**自己 augment(会把 host 面的 `HostConnectionRpc` 撞进来)。
插件按自己真正需要的形状声明 `ClientConnectionFace`(唯一成员 `rpc`),见 `src/client/runtime.ts`。
_Avoid_: 全局 augment Context.connection、`as any` 绕过

**结构桩不是兼容性证据 (stubs are not evidence)**:
`src/ambient.d.ts` 是 out-of-tree 独立 typecheck 用的手写结构桩,结构上就不可能发现
DSH 漂移 —— 桩描述的是源码当前的假设。真正的兼容性证据来自 `verify:runtime`
(按线上模块表加载产物并驱动两半 `apply()`)与 `verify:types`(排除桩、对真实 DSH 编译)。
_Avoid_: 以 `typecheck` 通过作为"适配最新 DSH"的结论

**会话服务名 (session service names)**:
浏览器半的会话服务接口是 `IConversation`(0.1.5 前叫 `ConversationService`),
`send()` 返回 `Promise<void>` 且业务失败会 reject —— 调用方必须 await,
否则失败变成 unhandled rejection。会话列表来自 `ctx.sessions`
(由 `dsh-api-session-controller/client` 提供),当前选中项是 `list.getSnapshot().current`。
_Avoid_: ConversationService、fire-and-forget 的 send()

**平台模块表 (platform module table)**:
浏览器半的 bundle 只能 require 平台 seed 表中的模块(当前 9 项:react 四件套、
cordis、client-store、ui-slots、ui-primitives、ui-dockkit)。其余 `@deepseek-ai/*`
引用必须写成 `import type`(构建期擦除),否则运行时 `require()` 会 miss 模块表。
`package.json` 的 `dsh.client.inject` 仅是信息性字段,不建图边;`external` 才建边。
_Avoid_: 在 client 半 import 平台表外的**值**(非 type)

