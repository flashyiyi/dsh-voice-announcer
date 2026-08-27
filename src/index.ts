/**
 * @dsh-external/dsh-voice-announcer — 对话轮结束语音播报守护插件（事件驱动）。
 * 监听 turn/end；完成时取摘要，按配置引擎播报（edge-tts 晓晓 / sapi 本地）。
 * 稳定版：只依赖 node 内置模块 + 运行时动态加载 dsh-voice，模块加载永不被依赖缺失卡死。
 */
import type { Context } from 'cordis'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import { createRequire } from 'node:module'
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

type AppContext = Context & { sessions: any; sessionProjections?: any; webServer?: any }

export const name = '@dsh-external/dsh-voice-announcer'
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
}

const COMPLETED_KINDS = new Set(['completed', 'error', 'max-tokens', 'aborted', 'interrupted'])

function cleanText(s: string): string { return s.replace(/\s+/g, ' ').trim() }

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

/** 用户界面语言偏好（settings locale.preference；zh/en，未设置时 undefined）。 */
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

const Q = String.fromCharCode(39)

/** SAPI 本地朗读（最可靠，离线，音质一般）。 */
function speakSapi(text: string, log: (m: string) => void): void {
  const ps = 'Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.Speak($env:DSH_SPEAK_TEXT)'
  const child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'ignore', windowsHide: true, env: { ...process.env, DSH_SPEAK_TEXT: text } })
  child.on('error', (e) => log('SAPI spawn失败: ' + e.message))
}

/** edge-tts 合成（晓晓神经网络音质）→ ffmpeg 转 WAV → SoundPlayer 播放。
 * 每次播报用唯一临时文件，并发播报互不干扰；播放结束立刻删除自己的文件。 */
function speakEdgeTts(text: string, cfg: ConfigType, log: (m: string) => void, instId?: string): void {
  log('实例 ' + (instId ?? '?') + ' 开始合成 voice=' + cfg.voice + ' rate=' + cfg.rate + ' pitch=' + cfg.pitch)
  const tag = Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
  const mp3 = 'C:/Users/Admin/AppData/Local/Temp/dsh-announce-' + tag + '.mp3'
  const wav = 'C:/Users/Admin/AppData/Local/Temp/dsh-announce-' + tag + '.wav'
  const cleanup = (): void => { try { rmSync(mp3, { force: true }); rmSync(wav, { force: true }) } catch {} }
  // 动态检查 dsh-voice 是否可解析（与合成子进程同解析规则）
  // import.meta.resolve 在宿主 ESM 上下文解析裸包会误判；createRequire 用 CJS 解析规则可正确找到
  let voiceReady = true
  try {
    createRequire(import.meta.url).resolve('dsh-voice')
  } catch {
    voiceReady = false
  }
  if (!voiceReady) {
    log('dsh-voice 未安装（peer 依赖），降级 SAPI。请先安装：pnpm add dsh-voice')
    speakSapi(text, log)
    return
  }
  const js = [
    "const fs = await import('node:fs');",
    "import('dsh-voice').then(async (m) => {",
    "  const buf = await m.synthesizeSpeech({ text: " + JSON.stringify(text) + ", voice: " + JSON.stringify(cfg.voice) + ", rate: " + JSON.stringify(cfg.rate) + ", pitch: " + JSON.stringify(cfg.pitch) + " });",
    "  fs.writeFileSync('" + mp3 + "', buf);",
    "  fs.writeFileSync('" + mp3 + ".done', 'ok');",
    "  console.log('SPOKE-OK');",
    "}).catch((e) => { fs.writeFileSync('" + mp3 + ".err', (e && e.message) ? e.message : String(e)); process.exit(1) })",
  ].join('\n')
  const syn = spawn(process.execPath, ['--input-type=module', '-e', js], { stdio: 'ignore', detached: true, windowsHide: true, cwd: join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'profiles', 'web') })
  syn.on('error', (e) => log('合成进程启动失败: ' + e.message))
  // 轮询等待合成完成（mp3 出现），最多 15s；合成失败则放弃
  let waited = 0
  const waitForMp3 = setInterval(() => {
    waited += 250
    if (existsSync(mp3)) {
      clearInterval(waitForMp3)
      runFfmpeg()
      return
    }
    // 合成失败：读错误文件
    if (existsSync(mp3 + '.err')) {
      clearInterval(waitForMp3)
      let errMsg = '未知错误'
      try { errMsg = readFileSync(mp3 + '.err', 'utf8') } catch {}
      log('合成失败: ' + errMsg)
      cleanup()
      return
    }
    if (waited >= 15000) {
      clearInterval(waitForMp3)
      log('合成超时（15s 无 mp3），放弃播报')
      cleanup()
    }
  }, 250)
  function runFfmpeg(): void {
    const ff = spawn('ffmpeg', ['-y', '-i', mp3, '-ar', '24000', '-ac', '1', wav], { stdio: 'ignore', windowsHide: true })
    ff.on('error', (e) => { log('ffmpeg失败: ' + e.message); cleanup() })
    ff.on('close', (code) => {
      if (code !== 0) { log('ffmpeg退出 code=' + String(code)); cleanup(); return }
      const ps = 'Add-Type -AssemblyName System.Media; $p = New-Object System.Media.SoundPlayer(' + Q + wav + Q + '); $p.PlaySync()'
      const player = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'ignore', windowsHide: true })
      player.on('error', (e) => { log('播放进程启动失败: ' + e.message); cleanup() })
      // PlaySync 同步阻塞：进程退出 = 播完，立刻删自己的文件
      player.on('close', () => { log('播放完成: ' + wav); cleanup() })
    })
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
  const log = (msg: string): void => { try { mkdirSync(join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'super-injector'), { recursive: true }); appendFileSync(logPath, '[' + new Date().toISOString() + '] ' + msg + '\n') } catch {} };
  const instId = Math.random().toString(36).slice(2, 8)
  log('插件启动（实例 ' + instId + '），enabled=' + cfg.enabled + ' engine=' + cfg.engine);
  installVoiceSettings(ctx, cfg, config, log);

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
      const m: any = await import('dsh-voice')
      const buf: Buffer = await m.synthesizeSpeech({ text, voice, rate, pitch })
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
      log('试听路由已注册')
    } else {
      log('webServer 不可用，试听路由跳过')
    }
  } catch (e) {
    log('试听路由注册失败: ' + (e instanceof Error ? e.message : String(e)))
  }

  (ctx.on as any)('session/event', (session: any, event: any) => {
    try {
      if (event?.type !== 'turn/end') return;
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
      log('播报 turn=' + String(event?.data?.turn ?? '?') + ' 引擎=' + cfg.engine + ' 文本=' + text.slice(0, 40));
      if (cfg.engine === 'sapi') speakSapi(text, log)
      else speakEdgeTts(text, cfg, log, instId)
    } catch (e) {
      log('监听器异常: ' + (e instanceof Error ? e.message : String(e)))
    }
  });

  ctx.logger?.info?.('[' + name + '] 语音播报守护已启动 v4')
}