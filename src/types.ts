/**
 * dsh-voice 线协议:host 半注册 /voice RPC 通道(connection.rpc,loopback authority),
 * client 半经 connection.rpc.call('/voice', endpoint, payload) 调用。
 * 纯语音输入:ping(引擎探测)+ asr(PCM → 识别文本)。
 */

/** 解析后的生效引擎(排除 'auto' 配置值)。 */
export type ResolvedEngine = Exclude<VoiceEngine, 'auto'>

/** /voice.ping: 客户端探测 host 引擎能力(决定用 browser 还是 native 识别)。
 * 引擎决策由 host 侧完成:host 持有配置与原生能力(模型加载结果),
 * 把"生效引擎"直接下发;客户端只消费,不再自行解析。
 * (传输状态由外层 RpcResult 承载,这里不再重复 ok 字段。) */
export interface VoicePingResponse {
  /** 本轮的生效引擎(host 从配置 + 模型加载结果解析) */
  engine: ResolvedEngine
}

/**
 * /voice.config: host 行内 config 同步到 client 半。
 * client 插件由 web shell 以 loader.create({ name }) 创建,行内 config 不会
 * 直接传给 client apply;host 半是唯一能读到该 config 的一方,因此由它经
 * loopback RPC 把 client 关心的键同步过去。
 */
export interface VoiceClientConfig {
  engine: VoiceEngine
  hotkey: string
}

/** /voice.asr: 一段麦克风 PCM(Int16 16kHz 单声道,base64)。 */
export interface AsrChunkPayload {
  /** 归属会话(host 按它隔离识别状态,并发会话不串音) */
  sessionId: string
  audio: string
  /** 最后一段(触发定稿冲刷) */
  final: boolean
}

/** /voice.asr 响应: 增量识别文本;final=true 表示本句定稿。 */
export interface AsrChunkResponse {
  delta: string
  final: boolean
}

/** 引擎选择(仅识别) */
export type VoiceEngine = 'browser' | 'native' | 'auto'
