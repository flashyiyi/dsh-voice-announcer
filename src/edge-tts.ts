/**
 * dsh-voice-announcer 内置 edge-tts 合成（微软 Edge 朗读 WebSocket 协议）。
 * 零依赖：自研 RFC 6455 WebSocket 客户端（./websocket.ts，可携带自定义
 * 握手头）；协议实现参考生态 dsh-voice / 开源 edge-tts（MIT）。相比上游
 * 额外提供流式 API —— 每个音频块到达即回调（onChunk），播放端可边收边播。
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createWebSocket, type WsSocket } from './websocket.js'

const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4'
const WS_BASE = 'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1'
const OUTPUT_FORMAT = 'audio-24khz-48kbitrate-mono-mp3'
const SEC_MS_GEC_VERSION = '1-143.0.3650.75'
const WIN_EPOCH_SECONDS = 11644473600
const MAX_TEXT_LENGTH = 5000

/** edge-tts 握手头（对齐开源 edge-tts / dsh-voice）。 */
const WSS_HEADERS: Record<string, string> = {
  Pragma: 'no-cache',
  'Cache-Control': 'no-cache',
  Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
  'Accept-Encoding': 'gzip, deflate, br, zstd',
  'Accept-Language': 'en-US,en;q=0.9',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0',
}

/** 合成相关错误（便于上层区分）。 */
export class SynthesizeError extends Error {}

/**
 * 连接池：edge-tts 服务接受同一 WebSocket 连接多次合成（实测确认），
 * 串行合成复用最近一条连接，避免每句一次 TLS 握手；并发时只有一方
 * 拿到池连接，另一方新建。30s 未用自动作废。
 */
interface PooledConnection { socket: WsSocket; lastUsed: number }
let pooledConn: PooledConnection | null = null
const POOL_TTL_MS = 30000
function takePooled(): WsSocket | null {
  const p = pooledConn
  pooledConn = null
  if (!p) return null
  if (Date.now() - p.lastUsed > POOL_TTL_MS) {
    try { p.socket.close() } catch { /* 忽略 */ }
    return null
  }
  return p.socket
}
function releasePooled(socket: WsSocket): void {
  const old = pooledConn
  pooledConn = { socket, lastUsed: Date.now() }
  if (old && old.socket !== socket) { try { old.socket.close() } catch { /* 忽略 */ } }
}
function dropPooled(socket: WsSocket): void {
  if (pooledConn && pooledConn.socket === socket) pooledConn = null
}
/** 关闭并清空连接池（插件卸载/热重载时调用，避免残留 socket）。 */
export function closeConnectionPool(): void {
  const p = pooledConn
  pooledConn = null
  if (p) { try { p.socket.close() } catch { /* 忽略 */ } }
}

/**
 * 本地生成 Sec-MS-GEC 令牌（对齐 edge-tts DRM 算法，5 分钟窗口）。
 */
export function generateSecMsGec(nowSeconds = Date.now() / 1000): string {
  let ticks = Math.floor(nowSeconds) + WIN_EPOCH_SECONDS
  ticks -= ticks % 300
  const windowsTicks = ticks * 10000000
  const raw = String(windowsTicks) + TRUSTED_CLIENT_TOKEN
  return createHash('sha256').update(raw, 'ascii').digest('hex').toUpperCase()
}

function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export interface SynthesizeOptions {
  text: string
  voice: string
  rate?: string
  pitch?: string
}

/** 生成 SSML。 */
export function buildSsml(options: SynthesizeOptions): string {
  const lang = /^[a-z]{2,3}(-[A-Z]{2})?/.exec(options.voice)?.[0] ?? 'zh-CN'
  const rate = options.rate ?? '+0%'
  const pitch = options.pitch ?? '+0Hz'
  return "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='" + lang + "'><voice name='" + options.voice + "'><prosody pitch='" + pitch + "' rate='" + rate + "' volume='+0%'>" + escapeXml(options.text) + '</prosody></voice></speak>'
}

/** 生成带时间戳与路径的协议消息头。 */
function protocolHeader(path: string, extra: Record<string, string>): string {
  const lines = ['X-Timestamp:' + new Date().toISOString()]
  for (const [key, value] of Object.entries(extra)) {
    lines.push(key + ':' + value)
  }
  lines.push('Path:' + path)
  return lines.join('\r\n') + '\r\n\r\n'
}

/**
 * 流式合成：每收到一块音频立即调用 onChunk（Buffer 为一段 MP3）。
 * 合成结束（turn.end 或连接关闭）时 resolve；出错时 reject。
 * @throws 文本为空/超长 / 无全局 WebSocket / 连接失败 / 超时 / 无音频数据。
 */
export async function synthesizeSpeechStream(
  options: SynthesizeOptions,
  onChunk: (chunk: Buffer) => void,
  timeoutMs = 30000,
): Promise<void> {
  const text = options.text.trim()
  if (text === '') throw new SynthesizeError('要合成的文本为空。')
  if (options.text.length > MAX_TEXT_LENGTH) throw new SynthesizeError('文本过长（超过 5000 字符），请分段合成。')
  const token = generateSecMsGec()
  // 对齐 edge-tts 当前协议：Sec-MS-GEC 走 URL 查询参数，MUID 走 header
  const url = WS_BASE
    + '?TrustedClientToken=' + TRUSTED_CLIENT_TOKEN
    + '&ConnectionId=' + randomUUID().replace(/-/g, '')
    + '&Sec-MS-GEC=' + token
    + '&Sec-MS-GEC-Version=' + SEC_MS_GEC_VERSION
  // 复用池中连接（同连接多次合成，免握手）；拿不到则新建
  const pooled = takePooled()
  const socket = pooled ?? createWebSocket(new URL(url), { ...WSS_HEADERS, MUID: randomBytes(16).toString('hex').toUpperCase() })
  let done = false
  let receivedAudio = false
  let chainError: Error | undefined
  await new Promise<void>((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      try { socket.close() } catch { /* 忽略 */ }
      dropPooled(socket)
      reject(new SynthesizeError('语音合成超时（' + timeoutMs + ' 毫秒无完整音频），请重试或检查网络。'))
    }, timeoutMs)
    const finish = (): void => { clearTimeout(timer); releasePooled(socket); resolvePromise() }
    const fail = (err: Error): void => { clearTimeout(timer); dropPooled(socket); try { socket.close() } catch { /* 忽略 */ }; reject(err) }
    const sendRequest = (): void => {
      const config = protocolHeader('speech.config', { 'Content-Type': 'application/json; charset=utf-8' })
        + JSON.stringify({
          context: {
            synthesis: {
              audio: { metadataoptions: { sentenceBoundaryEnabled: 'false', wordBoundaryEnabled: 'false' }, outputFormat: OUTPUT_FORMAT },
            },
          },
        })
      const ssml = protocolHeader('ssml', { 'Content-Type': 'application/ssml+xml', 'X-RequestId': randomUUID() }) + buildSsml({ ...options, text })
      try {
        socket.send(config)
        socket.send(ssml)
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)))
      }
    }
    if (pooled) {
      // 复用连接：已 open，立即发送请求（open 事件不会再触发）
      sendRequest()
    } else {
      socket.addEventListener('open', sendRequest)
    }
    socket.addEventListener('message', (event) => {
      const data = event.data
      if (typeof data === 'string') {
        // 文本消息：turn.end = 合成结束
        if (data.includes('Path:turn.end') && !done) {
          done = true
          finish()
        }
        return
      }
      // 二进制帧：2 字节大端头长 + 头文本 + 音频数据
      if (data.length > 2) {
        const headerLength = data.readUInt16BE(0)
        if (data.length > 2 + headerLength) {
          receivedAudio = true
          try {
            if (!chainError) onChunk(data.subarray(2 + headerLength))
          } catch (err) {
            if (!chainError) chainError = err instanceof Error ? err : new Error(String(err))
          }
        }
      }
    })
    socket.addEventListener('error', () => {
      dropPooled(socket)
      fail(new SynthesizeError('edge-tts WebSocket 连接失败。若网络需要代理（梯子），请直连重试或切换引擎为 sapi。'))
    })
    socket.addEventListener('close', () => {
      dropPooled(socket)
      if (done) return
      if (chainError) { fail(chainError); return }
      if (receivedAudio) {
        // 已收到音频但未等 turn.end 就关闭：视为流结束
        done = true
        finish()
      } else {
        fail(new SynthesizeError('edge-tts 连接在收到音频前关闭。'))
      }
    })
  })
  if (chainError) throw chainError
}

/** 整段合成：收集全部音频块后一次性返回 MP3 字节（预览/文件用途）。 */
export async function synthesizeSpeech(options: SynthesizeOptions, timeoutMs = 30000): Promise<Buffer> {
  const chunks: Buffer[] = []
  await synthesizeSpeechStream(options, (chunk) => chunks.push(chunk), timeoutMs)
  if (chunks.length === 0) throw new SynthesizeError('合成结果为空。')
  return Buffer.concat(chunks)
}
