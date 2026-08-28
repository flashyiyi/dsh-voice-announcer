/**
 * dsh-voice-announcer — 对话轮结束语音播报守护插件（事件驱动）。
 * 监听 turn/end；完成时取摘要，按配置引擎播报（edge-tts 晓晓 / sapi 本地）。
 * 零第三方依赖：edge-tts 协议内置（自研 WebSocket 客户端），播放走 ffplay 流式 stdin。
 */
import type { Context } from 'cordis'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { synthesizeSpeech, synthesizeSpeechStream } from './edge-tts.js'

type AppContext = Context & { sessions: any; sessionProjections?: any; webServer?: any }

export const name = 'dsh-voice-announcer'
export const inject = ['sessions', 'sessionProjections']

export interface Config {
  enabled?: boolean
  /** 播报引擎：edge-tts（晓晓神经网络音质，需联网+ffmpeg）/ sapi（本地离线可靠） */
  engine?: 'edge-tts' | 'sapi'
  voice?: string
  rate?: string
  pitch?: string
  announceCompleted?: boolean
  announceError?: boolean
  /** 子代理（subagent）会话也播报；默认 false（只播主会话） */
  announceSubagent?: boolean
  /** 实时朗读：回复生成过程中边出边念（仅 edge-tts 引擎，逐句合成流式播放）；默认关闭 */
  liveRead?: boolean
  /** 实时朗读只读当前活动会话（前端上报活动会话 id）；默认开启 */
  liveReadActiveOnly?: boolean
  /** 跟读跳跃阈值：待念队列超过此句数时丢弃旧文本跳到最新；默认 3 */
  liveReadMaxQueue?: number
  /** 详细诊断日志（实时朗读/预合成/打断/跳跃等），默认关闭；关键事件（启动/异常/配置变更）始终记录 */
  debugLog?: boolean
}

export type ConfigType = Required<Config>

const DEFAULTS: ConfigType = {
  enabled: true,
  engine: 'edge-tts',
  voice: 'auto',
  rate: '+0%',
  pitch: '+0Hz',
  announceCompleted: true,
  announceError: true,
  announceSubagent: false,
  liveRead: true,
  liveReadActiveOnly: true,
  liveReadMaxQueue: 5,
  debugLog: false,
}

const COMPLETED_KINDS = new Set(['completed', 'error', 'max-tokens', 'aborted', 'interrupted'])

function cleanText(s: string): string { return s.replace(/\s+/g, ' ').trim() }

/** 剥离 markdown 符号（实时朗读文本净化：代码块/行内代码/链接/强调/标题/引用符）。 */
function stripMd(s: string): string {
  return s
    .replace(/\`\`\`[\s\S]*?(\`\`\`|$)/g, ' ')
    .replace(/\`([^\`]*)\`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_~#>\`]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 标题优先从 sessionProjections 投影读取（官方全量 fold，不扫事件不卡）；
 * 投影不可用时回退扫日志尾部 200 条找 session/title 事件。
 */
const DIAG_LOG = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'super-injector', 'voice-announcer.log')
function diag(msg: string): void {
  try { appendFileSync(DIAG_LOG, '[' + new Date().toISOString() + '] [diag] ' + msg + '\n') } catch {}
}

function findTitle(session: any, ctx?: AppContext): string {
  try {
    // 投影读取面：snapshot(session).values.title（session-title 注册的 title 投影）
    const proj = ctx?.sessionProjections
    if (proj && typeof proj.snapshot === 'function') {
      const snap = proj.snapshot(session)
      const title = snap?.values?.title
      diag('投影: title=' + JSON.stringify(title) + ' keys=' + JSON.stringify(snap ? Object.keys(snap.values ?? {}) : null) + ' asOfSeq=' + String(snap?.asOfSeq) + ' events=' + String(session?.events?.length ?? '?'))
      if (typeof title === 'string' && title.trim()) return cleanText(title)
    } else {
      diag('无sessionProjections服务: ' + String(!!proj) + ' typeof=' + typeof (ctx as any)?.sessionProjections)
    }
  } catch (e) { diag('投影读取异常: ' + (e instanceof Error ? e.message : String(e))) }
  try {
    const events = session?.events
    if (!Array.isArray(events)) return ''
    const start = Math.max(0, events.length - 200)
    for (let i = events.length - 1; i >= start; i -= 1) {
      const ev = events[i]
      if (ev?.type === 'session/title' && typeof ev.data?.title === 'string' && ev.data.title.trim()) {
        return cleanText(ev.data.title)
      }
    }
  } catch { /* 兜底 */ }
  return ''
}

/** 多语言文案包：key = 音色语言前缀（zh/en/ja/ko/fr/de/ru/es），zh 为默认。 */
const LANG_TEXTS: Record<string, Record<string, string>> = {
  zh: {
    completed: '{round}对话结束了',
    error: '{round}对话出错了',
    aborted: '{round}对话被中止了',
    blocked: '{round}对话被阻塞了',
    'max-tokens': '{round}对话输出太长被截断了',
    interrupted: '{round}对话被打断了',
    roundThis: '这轮',
    roundN: '第 {n} 轮',
    byUser: '{round}对话被你中止了',
    byParent: '{round}对话被父代理中止了',
  },
  en: {
    completed: '{round} of conversation has ended',
    error: '{round} of conversation had an error',
    aborted: '{round} of conversation was aborted',
    blocked: '{round} of conversation was blocked',
    'max-tokens': '{round} was cut off because the output was too long',
    interrupted: '{round} of conversation was interrupted',
    roundThis: 'This round',
    roundN: 'Round {n}',
    byUser: '{round} was aborted by you',
    byParent: '{round} was aborted by the parent agent',
  },
  ja: {
    completed: '{round}の会話は終了しました',
    error: '{round}の会話でエラーが発生しました',
    aborted: '{round}の会話は中止されました',
    blocked: '{round}の会話はブロックされました',
    'max-tokens': '出力が長すぎて{round}の会話は切断されました',
    interrupted: '{round}の会話は中断されました',
    roundThis: 'この回',
    roundN: '第 {n} 回',
    byUser: '{round}の会話はあなたが中止しました',
    byParent: '{round}の会話は親エージェントが中止しました',
  },
  ko: {
    completed: '{round} 대화가 종료되었습니다',
    error: '{round} 대화에서 오류가 발생했습니다',
    aborted: '{round} 대화가 중단되었습니다',
    blocked: '{round} 대화가 차단되었습니다',
    'max-tokens': '출력이 너무 길어 {round} 대화가 잘렸습니다',
    interrupted: '{round} 대화가 중단되었습니다',
    roundThis: '이번',
    roundN: '{n}번째',
    byUser: '{round} 대화를 중단했습니다',
    byParent: '{round} 대화가 상위 에이전트에 의해 중단되었습니다',
  },
  fr: {
    completed: '{round} : Cette conversation est terminée',
    error: '{round} : Cette conversation a rencontré une erreur',
    aborted: '{round} : Cette conversation a été interrompue',
    blocked: '{round} : Cette conversation a été bloquée',
    'max-tokens': '{round} : Cette conversation a été coupée car la sortie était trop longue',
    interrupted: '{round} : Cette conversation a été interrompue',
    roundThis: 'Cette fois',
    roundN: 'Tour {n}',
    byUser: '{round} a été interrompu par vous',
    byParent: '{round} a été interrompu par l\'agent parent',
  },
  de: {
    completed: '{round} : Diese Unterhaltung ist beendet',
    error: '{round} : Bei dieser Unterhaltung ist ein Fehler aufgetreten',
    aborted: '{round} : Diese Unterhaltung wurde abgebrochen',
    blocked: '{round} : Diese Unterhaltung wurde blockiert',
    'max-tokens': '{round} : Diese Unterhaltung wurde abgeschnitten, weil die Ausgabe zu lang war',
    interrupted: '{round} : Diese Unterhaltung wurde unterbrochen',
    roundThis: 'Diese Runde',
    roundN: 'Runde {n}',
    byUser: '{round} wurde von Ihnen abgebrochen',
    byParent: '{round} wurde vom übergeordneten Agenten abgebrochen',
  },
  ru: {
    completed: '{round} : Этот разговор завершён',
    error: '{round} : В этом разговоре произошла ошибка',
    aborted: '{round} : Этот разговор был прерван',
    blocked: '{round} : Этот разговор был заблокирован',
    'max-tokens': '{round} : Этот разговор был обрезан, так как вывод был слишком длинным',
    interrupted: '{round} : Этот разговор был прерван',
    roundThis: 'Этот раунд',
    roundN: 'Раунд {n}',
    byUser: '{round} был прерван вами',
    byParent: '{round} был прерван родительским агентом',
  },
  es: {
    completed: '{round} : Esta conversación ha terminado',
    error: '{round} : Esta conversación tuvo un error',
    aborted: '{round} : Esta conversación fue interrumpida',
    blocked: '{round} : Esta conversación fue bloqueada',
    'max-tokens': '{round} : Esta conversación se cortó porque la salida era demasiado larga',
    interrupted: '{round} : Esta conversación fue interrumpida',
    roundThis: 'Esta ronda',
    roundN: 'Ronda {n}',
    byUser: '{round} fue interrumpido por usted',
    byParent: '{round} fue interrumpido por el agente principal',
  },
}

/**
 * 用户界面语言偏好（settings locale.preference）。
 *
 * 说明：DSH 的界面语言（locale）本身只支持 zh / en 两种（官方
 * LOCALE_IDS = ['zh','en']），因此「auto」跟随界面语言时只能映射到
 * 中文（晓晓）或英文（Aria）两种音色。插件虽然支持 8 种播报语言
 * （zh/en/ja/ko/fr/de/ru/es，见 LANG_TEXTS），但其余 6 种语言没有
 * 对应的界面语言来源——要使用它们需在「音色」下拉中直接选择对应
 * 语言的具体音色（如 ja-JP-NanamiNeural），播报文案会按音色前缀
 * 自动切换。未来若 DSH 扩展界面语言支持，此处只需补充映射即可。
 */
function userLocale(ctx: AppContext): string | undefined {
  try {
    const s = typeof (ctx as any).get === 'function' ? (ctx as any).get('settings') : undefined
    const loc = s?.get?.('locale') as { preference?: string } | undefined
    const pref = loc?.preference
    return pref === 'zh' || pref === 'en' ? pref : undefined
  } catch { return undefined }
}

/** 按界面语言解析默认音色：voice 为 auto/未设置时调用。 */
function resolveVoiceByLocale(ctx: AppContext, fallback: string): string {
  const loc = userLocale(ctx)
  if (loc === 'zh') return 'zh-CN-XiaoxiaoNeural'
  if (loc === 'en') return 'en-US-AriaNeural'
  return fallback
}

/** 按 voice 取语言包（默认 zh）。 */
function langPack(voice: string): Record<string, string> {
  const m = /^([a-z]{2,3})(-|$)/i.exec(voice || '')
  const lang = m ? m[1].toLowerCase() : 'zh'
  return LANG_TEXTS[lang] ?? LANG_TEXTS.zh
}

function summarize(session: any, event: any, ctx?: AppContext, voice?: string): string {
  try {
    const reason = event?.data?.reason
    const kind = String(reason?.kind ?? 'completed')
    const title = findTitle(session, ctx)
    const t = langPack(voice ?? '')
    // 轮数：turn/end 事件自带；有则播报"第 N 轮"
    const turn = typeof event?.data?.turn === 'number' ? event.data.turn : undefined
    const round = turn === undefined ? t.roundThis : String(t.roundN).replace('{n}', String(turn))
    let body = String(t[kind] ?? t.completed).replace('{round}', round)
    // 出错时附一句错误信息（截短，便于知道原因）
    if (kind === 'error' && reason?.error?.message) {
      const msg = cleanText(String(reason.error.message))
      if (msg) body += '：' + msg.slice(0, 60)
    }
    // 中止时说明来源（整句替换）
    if (kind === 'aborted') {
      const cause = String(reason?.reason?.kind ?? '')
      if (cause === 'user') body = String(t.byUser).replace('{round}', round)
      else if (cause === 'parent') body = String(t.byParent).replace('{round}', round)
    }
    const prefix = title ? title + '：' : ''
    return prefix + body || (title ? title : t.completed)
  } catch { /* 兜底 */ }
  return '这轮对话结束了'
}

/** SAPI 本地朗读（最可靠，离线，音质一般）。 */
function speakSapi(text: string, log: (m: string) => void): void {
  const ps = 'Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.Speak($env:DSH_SPEAK_TEXT)'
  const child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'ignore', windowsHide: true, env: { ...process.env, DSH_SPEAK_TEXT: text } })
  child.on('error', (e) => log('SAPI spawn失败: ' + e.message))
}

/** edge-tts 流式合成（内置协议，零依赖）→ ffplay 从 stdin 边收边播。
 * 每块音频到达立即写入 ffplay 的 stdin，合成完成即关闭输入（无临时文件、无转码）。
 * ffplay 不可用时降级 SAPI 播报。
 * 完成通知（onDone）：ffplay close 一律触发（播完/崩溃/合成失败/被打断），
 * finished 防重；句子播放队列靠它恢复，避免合成失败后 livePlaying 卡死。 */
function speakEdgeTts(text: string, cfg: ConfigType, log: (m: string) => void, instId?: string, onDone?: () => void): () => void {
  let aborted = false
  let finished = false
  const finish = (): void => {
    if (finished) return
    finished = true
    onDone?.()
  }
  const player = spawn('ffplay', ['-nodisp', '-autoexit', '-loglevel', 'quiet', '-i', '-'], {
    stdio: ['pipe', 'ignore', 'pipe'],
    windowsHide: true,
  })
  let stderrBuf = ''
  player.stderr?.on('data', (d: Buffer) => { stderrBuf += String(d) })
  player.on('error', (e) => {
    aborted = true
    log('ffplay 启动失败: ' + e.message + '（请安装 ffmpeg/ffplay，或切换引擎为 sapi）')
    speakSapi(text, log)
    finish()
  })
  player.stdin?.on('error', (e) => { log('播放输入流写入失败: ' + e.message) })
  synthesizeSpeechStream(
    { text, voice: cfg.voice, rate: cfg.rate, pitch: cfg.pitch },
    (chunk) => {
      if (aborted) return
      try {
        player.stdin?.write(chunk)
      } catch (e) {
        log('写播放流失败: ' + (e instanceof Error ? e.message : String(e)))
      }
    },
  ).then(() => {
    try { player.stdin?.end() } catch { /* 忽略 */ }
  }).catch((e) => {
    aborted = true
    log('合成失败: ' + (e instanceof Error ? e.message : String(e)))
    try { player.kill() } catch { /* 忽略 */ }
    // kill 触发 close → finish；极端情况 close 未触发时兜底
    setTimeout(finish, 1000)
  })
  player.on('close', (code) => {
    if (code !== 0 && stderrBuf) log('播放异常 code=' + String(code) + ' ' + stderrBuf.trim().slice(0, 120))
    // 任何结束原因都恢复队列（被打断时 stopLiveRead 已清队，pumpLive 无句可播，安全）
    finish()
  })
  return () => {
    aborted = true
    try { player.kill() } catch { /* 忽略 */ }
  }
}

const BOOT_LOG = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'super-injector', 'voice-announcer.log')
try { appendFileSync(BOOT_LOG, '[' + new Date().toISOString() + '] MODULE-LOAD v4\n') } catch {}

/** 设置命名空间 schema（与 Config 同构；schemastery 字段默认值 = DEFAULTS）。 */
const VoiceAnnouncerSettings = z.object({
  enabled: z.boolean().default(DEFAULTS.enabled),
  engine: z.union(['edge-tts', 'sapi']).default(DEFAULTS.engine),
  voice: z.string().default(DEFAULTS.voice),
  rate: z.string().default(DEFAULTS.rate),
  pitch: z.string().default(DEFAULTS.pitch),
  announceCompleted: z.boolean().default(DEFAULTS.announceCompleted),
  announceError: z.boolean().default(DEFAULTS.announceError),
  announceSubagent: z.boolean().default(DEFAULTS.announceSubagent),
  liveRead: z.boolean().default(DEFAULTS.liveRead),
  liveReadActiveOnly: z.boolean().default(DEFAULTS.liveReadActiveOnly),
  liveReadMaxQueue: z.number().min(1).max(20).default(DEFAULTS.liveReadMaxQueue),
  debugLog: z.boolean().default(DEFAULTS.debugLog),
})

/** 接入 settings：有服务则 Web 设置页可改（live 生效），无服务则 entry 配置照常。 */
function installVoiceSettings(ctx: AppContext, cfg: ConfigType, entry: Partial<ConfigType>, log: (m: string) => void): void {
  let source: () => ConfigType = () => ({ ...DEFAULTS, ...entry } as ConfigType)
  installSettingsSection(ctx, settingsNamespace('voice-announcer'), VoiceAnnouncerSettings, { ...DEFAULTS, ...entry }, {
    setSource: (current) => { source = current as () => ConfigType },
    onChange: () => {
      Object.assign(cfg, source())
      // 音色为 auto 时重新解析（用户重置音色后回到界面语言默认）
      if (cfg.voice === 'auto') cfg.voice = resolveVoiceByLocale(ctx, 'zh-CN-XiaoxiaoNeural')
      log('设置已更新（即时生效）: engine=' + cfg.engine + ' voice=' + cfg.voice + ' enabled=' + cfg.enabled)
    },
  })
}

export function apply(ctx: AppContext, config: Partial<ConfigType> = {}): void {
  try { appendFileSync(BOOT_LOG, '[' + new Date().toISOString() + '] APPLY v4\n') } catch {}
  // 用户未显式设置音色时，按界面语言选默认音色（设置了就用用户的，永不覆盖）
  // fallback 必须是具体音色（不能是 auto），否则 locale 未设置时会死循环成 auto
  const RESOLVED_VOICE_DEFAULT = resolveVoiceByLocale(ctx, 'zh-CN-XiaoxiaoNeural')
  const cfg: ConfigType = { ...DEFAULTS, ...config }
  if (cfg.voice === 'auto' || cfg.voice === undefined) {
    cfg.voice = RESOLVED_VOICE_DEFAULT
  }
  const logPath = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'super-injector', 'voice-announcer.log');
  // 诊断类日志只在 debugLog 开启时记录；关键事件（启动/配置变更/路由/播报/ffplay 失败等）始终记录
  const DEBUG_ONLY = /实时朗读|预合成|打断|跳跃|缓冲超时|当前活动会话|跳过子代理|收到 turn\/end|合成失败|播放异常|降级|新回合/;
  const log = (msg: string): void => {
    try {
      if (!cfg.debugLog && DEBUG_ONLY.test(msg)) return
      mkdirSync(join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'super-injector'), { recursive: true })
      appendFileSync(logPath, '[' + new Date().toISOString() + '] ' + msg + '\n')
    } catch {}
  };
  const instId = Math.random().toString(36).slice(2, 8)
  log('插件启动（实例 ' + instId + '），enabled=' + cfg.enabled + ' engine=' + cfg.engine);
  installVoiceSettings(ctx, cfg, config, log);
  // 实时朗读状态（apply 闭包内，每实例独立）。句子按序排队，
  // 念完一句（ffplay close）再念下一句——不被后续句子互相掐断；
  // 只有 turn/start、user/message、结束通知播报才打断清队。
  let activeSessionId: string | undefined
  let activeWarned = false
  let liveBuf = ''
  let lastChunkAt = 0
  const liveQueue: string[] = []
  let livePlaying = false
  let liveStop: (() => void) | null = null
  let summaryPlaying = false
  // 预合成流水线：当前句播放时后台合成队首下一句（Buffer 缓冲队列，最多 2 句），
  // 播完无缝衔接；2 句缓冲抗单次合成慢/失败，偶发网络抖动不露间隔
  let preSynth: Promise<void> | null = null
  const preReadyQueue: Buffer[] = []
  let preFailed = false
  let preSynthDisabled = false
  let preSynthFailCount = 0
  let liveEpoch = 0
  /** 播放已合成的 Buffer（ffplay stdin），播完触发 onDone 驱动流水线。 */
  function playBuffer(buf: Buffer, log2: (m: string) => void, onDone: () => void): () => void {
    let aborted = false
    let finished = false
    const finish = (): void => { if (!finished) { finished = true; onDone() } }
    const player = spawn('ffplay', ['-nodisp', '-autoexit', '-loglevel', 'quiet', '-i', '-'], { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true })
    player.on('error', (e) => { aborted = true; log2('ffplay 启动失败: ' + e.message); finish() })
    player.stdin?.on('error', (e) => { log2('播放输入流写入失败: ' + e.message) })
    try { player.stdin?.write(buf); player.stdin?.end() } catch (e) { log2('写播放流失败: ' + (e instanceof Error ? e.message : String(e))) }
    player.on('close', (code) => {
      if (code !== 0) log2('播放异常 code=' + String(code))
      if (!aborted) finish()
    })
    return () => { aborted = true; try { player.kill() } catch { /* 忽略 */ } }
  }

  /** 预合成流水线：把队列前部未合成的句子预合成进缓冲（最多 2 句）；世代号防过期结果污染。
   * 预合成用短超时（8s）：网络抖动时快速失败，不阻塞实时朗读；
   * 连续失败 2 次自动降级为纯现场流式（每句首块 ~0.6s 出声，不哑）。 */
  function ensurePreSynth(log2: (m: string) => void): void {
    if (preSynth || preFailed || preSynthDisabled || preReadyQueue.length >= 2) return
    const pending = liveQueue.length - preReadyQueue.length
    if (pending <= 0) return
    const s = liveQueue[preReadyQueue.length]
    const epoch = liveEpoch
    let p: Promise<void>
    p = synthesizeSpeech({ text: s, voice: cfg.voice, rate: cfg.rate, pitch: cfg.pitch }, 8000)
      .then((buf) => {
        // 只清自己的引用（跳跃/打断可能已换新 preSynth，不能误清）
        if (preSynth === p) preSynth = null
        if (epoch !== liveEpoch) { ensurePreSynth(log2); return }
        preSynthFailCount = 0
        preReadyQueue.push(buf)
        ensurePreSynth(log2)
      })
      .catch((e) => {
        if (preSynth === p) preSynth = null
        if (epoch !== liveEpoch) { ensurePreSynth(log2); return }
        preFailed = true
        preSynthFailCount += 1
        log2('预合成失败(' + preSynthFailCount + '): ' + (e instanceof Error ? e.message : String(e)))
        if (preSynthFailCount >= 2) {
          preSynthDisabled = true
          log2('网络不佳，实时朗读降级为现场流式（本回合不再预合成）')
        }
      })
    preSynth = p
  }

  /** 队列调度：优先用预合成 Buffer 无缝续播；播放启动后立即预合成下一句。
   * 总结播报（summaryPlaying）期间不播，等总结念完自动续上。 */
  function pumpLive(log2: (m: string) => void): void {
    if (summaryPlaying || livePlaying || liveQueue.length === 0) return
    // 预合成进行中：等待完成再播（避免重复合成同一句）
    if (preSynth) {
      livePlaying = true
      preSynth.then(() => { livePlaying = false; pumpLive(log2) }).catch(() => { livePlaying = false; pumpLive(log2) })
      return
    }
    livePlaying = true
    const s = liveQueue.shift() as string
    const next = (): void => { livePlaying = false; liveStop = null; ensurePreSynth(log2); pumpLive(log2) }
    if (preReadyQueue.length > 0) {
      const buf = preReadyQueue.shift() as Buffer
      log2('实时朗读(预合成): ' + s.slice(0, 40))
      liveStop = playBuffer(buf, log2, next)
    } else if (preFailed) {
      preFailed = false
      log2('实时朗读(预合成失败→现场流式): ' + s.slice(0, 40))
      liveStop = speakEdgeTts(s, cfg, log2, instId, next)
    } else {
      log2('实时朗读(现场合成): ' + s.slice(0, 40))
      liveStop = speakEdgeTts(s, cfg, log2, instId, next)
    }
    // 播放启动后立即预合成下一句（livePlaying 为 true，feedLive 的 ensurePreSynth 也会兜底）
    ensurePreSynth(log2)
  }
  function stopLiveRead(log2: (m: string) => void): void {
    if (liveStop || liveQueue.length || liveBuf) log2('打断实时朗读（队列 ' + liveQueue.length + ' 句，剩余缓冲 ' + liveBuf.length + ' 字）')
    try { liveStop?.() } catch { /* 忽略 */ }
    liveStop = null
    livePlaying = false
    liveQueue.length = 0
    liveBuf = ''
    liveEpoch += 1
    preSynth = null
    preReadyQueue.length = 0
    preFailed = false
    preSynthDisabled = false
    preSynthFailCount = 0
  }
  /** 跟读跳跃：队列积压超过 cfg.liveReadMaxQueue 时丢弃最旧句子，只留最新内容；
   * 不打断正在播放的句子（念完自然切到最新），预合成作废并重新预合成最新句。 */
  function jumpToLatest(log2: (m: string) => void): void {
    const overflow = liveQueue.length - cfg.liveReadMaxQueue
    if (overflow <= 0) return
    liveQueue.splice(0, overflow)
    preReadyQueue.length = 0
    liveEpoch += 1
    preSynth = null
    log2('积压跳跃：丢弃 ' + overflow + ' 句旧文本，跳到最新（剩余队列 ' + liveQueue.length + ' 句）')
    ensurePreSynth(log2)
  }
  /** 新回合开始：清掉未念的积压句子与残余缓冲，但不掐正在播放的句子（输入信息不打断语音）。 */
  function flushLive(log2: (m: string) => void): void {
    if (liveQueue.length || liveBuf) log2('新回合开始，清掉积压实时朗读（队列 ' + liveQueue.length + ' 句，缓冲 ' + liveBuf.length + ' 字）；正在播放的继续念完')
    liveQueue.length = 0
    liveBuf = ''
    liveEpoch += 1
    preSynth = null
    preReadyQueue.length = 0
    preFailed = false
    preSynthDisabled = false
    preSynthFailCount = 0
  }
  function feedLive(text: string, log2: (m: string) => void): void {
    lastChunkAt = Date.now()
    liveBuf += text
    // 强边界（句号/感叹/问号/分号/换行）整句切出；lookbehind 保留边界在句末
    const parts = liveBuf.split(/(?<=[。！？!?；;\n])/)
    const ready: string[] = []
    for (let i = 0; i < parts.length - 1; i += 1) {
      const s = stripMd(parts[i])
      if (s) ready.push(s)
    }
    let rest = parts[parts.length - 1] ?? ''
    // 剩余过长且含弱边界（逗号）：从最后一个弱边界切，避免长句迟迟不念
    if (rest.length >= 40) {
      const weak = rest.match(/.*[，、,]/)
      if (weak) {
        const s = stripMd(weak[0])
        if (s) ready.push(s)
        rest = rest.slice(weak[0].length)
      }
    }
    liveBuf = rest
    for (const s of ready) liveQueue.push(s)
    jumpToLatest(log2)
    ensurePreSynth(log2)
    pumpLive(log2)
  }
  // 缓冲超时强制切句：模型输出停顿（>2s 无新 chunk）时，把未到边界的缓冲也念掉，
  // 避免工具执行/思考期间残留文本长时间不念（表现为「实时朗读没有了」）
  const flushTimer = setInterval(() => {
    if (!cfg.liveRead || !liveBuf) return
    if (Date.now() - lastChunkAt < 2000) return
    const s = stripMd(liveBuf)
    liveBuf = ''
    if (s) {
      log('缓冲超时切句: ' + s.slice(0, 40))
      liveQueue.push(s)
      ensurePreSynth(log)
      pumpLive(log)
    }
  }, 1000)
  ;(ctx.on as any)('dispose', () => clearInterval(flushTimer))

  // 试听路由：POST /voice-announcer/preview {voice, text?} → 合成 mp3 返回（client 浏览器播放）
  // handler 是 async 函数；effect 回调保持同步，返回 disposer
  /** 各语言试听文本。 */
  const PREVIEW_TEXTS: Record<string, string> = {
    zh: '你好，欢迎使用语音播报，这是我的声音。',
    en: 'Hello, welcome to voice announcement. This is my voice.',
    ja: 'こんにちは、音声アナウンスへようこそ。これが私の声です。',
    ko: '안녕하세요, 음성 알림에 오신 것을 환영합니다. 이것이 제 목소리입니다.',
    fr: "Bonjour, bienvenue dans l'annonce vocale. C'est ma voix.",
    de: 'Hallo, willkommen zur Sprachansage. Das ist meine Stimme.',
    ru: 'Привет, добро пожаловать в голосовое оповещение. Это мой голос.',
    es: 'Hola, bienvenido al anuncio de voz. Esta es mi voz.',
  }
  const previewHandler = async (req: any, res: any): Promise<void> => {
    try {
      let raw = ''
      for await (const chunk of req) raw += String(chunk)
      let voice = '', text = '', rate = '+0%', pitch = '+0Hz'
      try {
        const body = JSON.parse(raw || '{}')
        voice = String(body.voice ?? '')
        text = String(body.text ?? '')
        rate = String(body.rate ?? '+0%')
        pitch = String(body.pitch ?? '+0Hz')
      } catch {}
      if (!voice) { res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }); res.end('voice 缺失'); return }
      if (!text) {
        const m2 = /^([a-z]{2,3})(-|$)/i.exec(voice || '')
        const lang = m2 ? m2[1].toLowerCase() : 'zh'
        text = PREVIEW_TEXTS[lang] ?? PREVIEW_TEXTS.zh
      }
      const buf: Buffer = await synthesizeSpeech({ text, voice, rate, pitch })
      res.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': String(buf.length), 'cache-control': 'no-store' })
      res.end(buf)
    } catch (e) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('合成失败: ' + (e instanceof Error ? e.message : String(e)))
    }
  }
  try {
    const ws = typeof (ctx as any).get === 'function' ? (ctx as any).get('webServer') : undefined
    if (ws && typeof ws.register === 'function') {
      (ctx as any).effect(() => ws.register({
        kind: 'prefix',
        path: '/voice-announcer/preview',
        handler: previewHandler,
      }), 'voice-announcer: preview api')
      const activeHandler = async (req: any, res: any): Promise<void> => {
        try {
          let raw = ''
          for await (const chunk of req) raw += String(chunk)
          let sessionId: string | undefined
          try {
            const body = JSON.parse(raw || '{}')
            const v = body.sessionId
            sessionId = typeof v === 'string' && v ? v : undefined
          } catch {}
          activeSessionId = sessionId
          // 仅「仅当前活动会话」开启时需要上报（用于 chunk 比对）；关闭时静默存值
          if (cfg.liveReadActiveOnly) log('当前活动会话更新: ' + (activeSessionId ?? '(无)'))
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end('{"ok":true}')
        } catch (e) {
          res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
          res.end('失败: ' + (e instanceof Error ? e.message : String(e)))
        }
      }
      (ctx as any).effect(() => ws.register({
        kind: 'prefix',
        path: '/voice-announcer/active',
        handler: activeHandler,
      }), 'voice-announcer: active api')
      log('试听路由已注册')
    } else {
      log('webServer 不可用，试听路由跳过')
    }
  } catch (e) {
    log('试听路由注册失败: ' + (e instanceof Error ? e.message : String(e)))
  }

  (ctx.on as any)('session/event', (session: any, event: any) => {
    try {
      const type = event?.type
      // 实时朗读：assistant/chunk 的 text-delta 增量 → 句子缓冲 → 流式播放（仅 edge-tts）
      if (type === 'assistant/chunk' && cfg.enabled && cfg.liveRead && cfg.engine === 'edge-tts') {
        const chunk = event?.data?.chunk
        if (chunk?.type === 'text-delta' && typeof chunk.text === 'string' && chunk.text) {
          // 子代理会话：遵循 announceSubagent
          if (session?.header?.origin === 'subagent' && !cfg.announceSubagent) return
          // 只读当前活动会话：前端经 POST /voice-announcer/active 上报
          if (cfg.liveReadActiveOnly) {
            const sid = String(session?.id ?? '')
            if (!sid) return
            // activeSessionId 未上报时宽松放行（避免上报缺失导致完全不念）；有值时精确限制
            if (activeSessionId && sid !== activeSessionId) return
            if (!activeSessionId && !activeWarned) {
              activeWarned = true
              log('仅当前活动会话开启，但尚未收到前端活动会话上报——暂不限制，收到上报后精确生效')
            }
          }
          feedLive(chunk.text, log)
        }
        return
      }
      // 新轮开始：清积压旧句但不掐正在播放的句子（输入信息不打断语音）。
      // 子会话（subagent）的 turn/start 会随工具调用触发，必须过滤——否则子代理
      // 回合开始会清掉主会话的实时朗读队列/缓冲，造成「某些工具调用中断朗读」。
      if (type === 'turn/start') {
        if (session?.header?.origin === 'subagent') return
        if (cfg.liveReadActiveOnly && activeSessionId && String(session?.id ?? '') !== activeSessionId) return
        flushLive(log)
        return
      }
      // 用户发消息：完全不打断实时朗读（只有结束通知语音才打断）
      if (type === 'user/message') return
      if (type !== 'turn/end') return;
      log('实例 ' + instId + ' 收到 turn/end turn=' + String(event?.data?.turn ?? '?'))
      if (!cfg.enabled) return;
      // 子代理会话：默认不播报（可配置 announceSubagent 开启）
      if (session?.header?.origin === 'subagent' && !cfg.announceSubagent) {
        log('跳过子代理会话（未开启子任务播报） turn=' + String(event?.data?.turn ?? '?'))
        return
      }
      const kind = event?.data?.reason?.kind ?? 'completed';
      if (!COMPLETED_KINDS.has(kind)) return;
      if (kind === 'completed' && !cfg.announceCompleted) return;
      if (kind !== 'completed' && !cfg.announceError) return;
      const text = summarize(session, event, ctx, cfg.voice);
      stopLiveRead(log)
      log('播报 turn=' + String(event?.data?.turn ?? '?') + ' 引擎=' + cfg.engine + ' 文本=' + text.slice(0, 40));
      if (cfg.engine === 'sapi') {
        speakSapi(text, log)
      } else {
        summaryPlaying = true
        speakEdgeTts(text, cfg, log, instId, () => {
          summaryPlaying = false
          pumpLive(log)
        })
      }
    } catch (e) {
      log('监听器异常: ' + (e instanceof Error ? e.message : String(e)))
    }
  });

  ctx.logger?.info?.('[' + name + '] 语音播报守护已启动 v4')
}