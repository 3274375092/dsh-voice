/**
 * dsh-voice host 半(web profile 的 Node 侧)。
 * 纯语音输入:/voice RPC 通道(connection.rpc,loopback authority)接收浏览器
 * 采麦 PCM → 流式 ASR(sherpa-onnx-node zipformer2 + silero VAD)→ 增量文本回传。
 * 与 agent preset 解耦:任何 preset(code/standard/minimal/whale/…)下都只是
 * "另一种输入法",回复展示由会话本身负责。
 * 模型权重全局一份;识别状态按 sessionId 隔离(识别会话池 + LRU 上限见
 * core/host-asr.ts),并发会话不串音。
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-client-connection'
import { createCapability, resolveEngine } from './core/engine.js'
import { DEFAULTS, ENGINE_VALUES } from './core/config.js'
import { HostAsr } from './core/host-asr.js'
import { OnnxModel } from './core/native-asr.js'
import { rpcError, VOICE_CHANNEL, VOICE_ENDPOINTS } from './core/wire.js'
import type { AsrChunkPayload, VoiceClientConfig, VoiceEngine, VoicePingResponse } from './types.js'

export const name = 'dsh-voice-host'
export const inject = ['connection']

/** host 半配置:引擎开关 + 模型选项。默认值单一来源在 core/config.ts;
 * 字段形状与 AsrModelOptions 同形(new OnnxModel(config) 直接透传)。
 * engine/hotkey 与 client 半共用同一行 config:web shell 不会把行内 config
 * 传给 client apply,由 host 经 /voice.config loopback RPC 同步。
 * host 半的 auto = 有模型就提供 native(引擎决策在 host 半,见 core/engine.ts,
 * 客户端只消费 ping/config 下发的生效引擎)。 */
export interface Config {
  /** 'browser' = 强制关闭原生识别;'native'/'auto' = 有模型就提供原生识别 */
  engine: VoiceEngine
  /** 模型根目录的绝对路径 */
  modelDir: string
  /** VAD 静音阈值(0-1);越低越不容易吞句首/句尾,但更容易把噪声当语音(voxelf 生产值 0.3) */
  vadThreshold: number
  /** 尾音补偿时长(秒);VAD 段后追加的音频时长,补偿渐弱尾音(voxelf 生产值 0.6) */
  tailPadSeconds: number
  /** ASR 模型子目录: asr-zh(纯中文,默认)| asr-zh-en-2025(中英双语) */
  asrDir: string
  /** 全局快捷键(host 只负责镜像给 client;真实消费方在浏览器半) */
  hotkey: string
}

export const Config: z<Config> = z.object({
  engine: z.union(ENGINE_VALUES.map((v) => z.const(v))).default(DEFAULTS.engine),
  modelDir: z.string().default(DEFAULTS.modelDir),
  vadThreshold: z.number().min(0).default(DEFAULTS.vadThreshold),
  tailPadSeconds: z.number().min(0).default(DEFAULTS.tailPadSeconds),
  asrDir: z.string().default(DEFAULTS.asrDir),
  hotkey: z.string().default(DEFAULTS.hotkey),
})

/** 测试/替换 seam(默认即生产实现):模型加载器注入,host 端点可无模型直测。 */
export interface HostDeps {
  /** 加载 ASR 模型(默认:OnnxModel 懒加载;测试注入替身) */
  loadModel?: () => Promise<OnnxModel | null>
}

export function apply(ctx: Context, config: Config, deps: HostDeps = {}): void {
  const logger = ctx.logger
  let model: OnnxModel | null = null
  /** 识别会话池:首次模型加载后创建(会话/驱逐逻辑在 core/host-asr.ts) */
  let hostAsr: HostAsr | null = null

  /** 加载 zipformer2 + VAD;目录未配/加载失败 → null(失败由 capability 锁存)。 */
  const loadModel = deps.loadModel ?? (async (): Promise<OnnxModel | null> => {
    if (config.modelDir.trim() === '') return null
    if (model === null) model = new OnnxModel(config)
    try {
      await model.start()
      return model
    } catch (err) {
      logger.warn('native ASR 初始化失败: %s', String(err))
      return null
    }
  })
  const capability = createCapability(loadModel)
  if (config.engine !== 'browser') capability.kick() // 预载:首击零延迟;失败静默锁存

  ctx.effect(() => ctx.connection.rpc.handle(VOICE_CHANNEL, async (endpoint, payload) => {
    switch (endpoint) {
      case VOICE_ENDPOINTS.ping: {
        // 生效引擎:配置 + 模型加载结果(等待落定,不再虚报)
        const value: VoicePingResponse = { engine: resolveEngine(config.engine, (await capability.ready()) !== null) }
        return { ok: true, value }
      }
      case VOICE_ENDPOINTS.config: {
        // host 是唯一知道能力真相的一方:直接把生效引擎下发(native 不可用时
        // 已兜底降级),客户端只消费;不把 raw engine 原样透传。
        const value: VoiceClientConfig = {
          engine: resolveEngine(config.engine, (await capability.ready()) !== null),
          hotkey: config.hotkey,
        }
        return { ok: true, value }
      }
      case VOICE_ENDPOINTS.asr: {
        const req = payload as AsrChunkPayload
        const m = await capability.ready()
        const engine = resolveEngine(config.engine, m !== null)
        if (engine !== 'native' || m === null) {
          return rpcError('native_unavailable', 'native ASR 不可用')
        }
        if (hostAsr === null) {
          hostAsr = new HostAsr({ log: (msg) => logger.warn('native ASR %s', msg) })
        }
        return hostAsr.handle(m, req)
      }
      default:
        return rpcError('unknown_endpoint', 'unknown endpoint: ' + endpoint)
    }
  }, { authority: 'loopback' }), 'dsh-voice: /voice rpc channel')
}
