/**
 * 引擎决策器(host 侧,deep module)。
 *
 * 「本轮用哪个引擎」唯一回答者:配置(engine)+ 原生能力(模型加载结果)
 * → 生效引擎。客户端只消费 host 经 ping/config 下发的结果,不再自行解析;
 * host 的 ping / config / asr 三个端点都从这里取同一个答案。
 *
 * 能力真相:capability 只在模型真正加载成功后才报 native 可用,
 * 不再出现"目录配了但模型没加载过也报 true"的虚报窗口;
 * 失败永久锁存(与旧 asrFailed 同语义,装好模型需重启插件生效)。
 */
import type { ResolvedEngine, VoiceEngine } from '../types.js'

/** 配置引擎 + 原生能力 → 生效引擎(纯函数,两侧唯一决策点)。 */
export function resolveEngine(configured: VoiceEngine, capable: boolean): ResolvedEngine {
  if (configured === 'browser') return 'browser'
  if (configured === 'native') return capable ? 'native' : 'browser'
  return capable ? 'native' : 'browser'
}

export type CapabilityState = 'idle' | 'loading' | 'ready' | 'failed'

export interface ResourceCapability<T> {
  /** 首个调用触发加载;返回已加载资源,失败/未配置为 null(幂等) */
  ready(): Promise<T | null>
  /** 预载点火(apply 时调用;加载失败静默锁存) */
  kick(): void
  state(): CapabilityState
}

/**
 * 懒加载 + 单飞 + 失败锁存:加载只触发一次,后续 ready() 复用已落定结果。
 * 加载函数约定返回资源或 null;抛错视为 null(锁存 failed)。
 */
export function createCapability<T>(load: () => Promise<T | null>): ResourceCapability<T> {
  let state: CapabilityState = 'idle'
  let promise: Promise<T | null> | null = null
  const loadOnce = (): Promise<T | null> => {
    if (promise === null) {
      state = 'loading'
      promise = Promise.resolve().then(load).then(
        (res) => {
          state = res === null ? 'failed' : 'ready'
          return res
        },
        () => {
          state = 'failed'
          return null
        },
      )
    }
    return promise
  }
  return {
    ready: () => promise ?? loadOnce(),
    kick: () => {
      void loadOnce()
    },
    state: () => state,
  }
}
