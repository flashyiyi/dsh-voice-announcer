/**
 * SAPI（Windows 本地语音）常驻朗读进程：一次冷启动，之后逐句经 stdin 喂入，
 * 免去每句 ~0.5s 的 PowerShell 冷启动。支持音色/语速/音量配置与打断。
 *
 * 完成信号：PowerShell 阻塞在 stdin 读取时无法派发 SpeakCompleted 事件，
 * 故用文本长度估算时长驱动 onDone（SAPI 侧 SpeakAsync 自动顺次排队，
 * 估算偏短只是提前喂下一句，不会叠音）。
 */
import { spawn, type ChildProcess } from 'node:child_process'

export interface SapiOptions {
  text: string
  /** 系统音色名（如 'Microsoft Huihui'）；空 = 系统默认。 */
  voice?: string
  /** 语速档 -10..10（SAPI SpeechRate）。 */
  rate?: number
  /** 音量 0..100。 */
  volume?: number
}

/** 常驻脚本：循环读 stdin 的 JSON 行；__CANCEL__ 打断、__EXIT__ 退出。 */
const SCRIPT = [
  "$ErrorActionPreference = 'Continue'",
  'Add-Type -AssemblyName System.Speech',
  'try { [Console]::InputEncoding = [System.Text.Encoding]::UTF8 } catch {}',
  '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
  'while ($true) {',
  '  $line = [Console]::In.ReadLine()',
  '  if ($null -eq $line) { break }',
  "  if ($line -eq '__CANCEL__') { try { $s.SpeakAsyncCancelAll() } catch {} ; continue }",
  "  if ($line -eq '__EXIT__') { break }",
  '  try { $o = $line | ConvertFrom-Json } catch { continue }',
  '  if ($o.voice) { try { $s.SelectVoice([string]$o.voice) } catch {} }',
  '  if ($null -ne $o.rate) { try { $s.Rate = [int]$o.rate } catch {} }',
  '  if ($null -ne $o.volume) { try { $s.Volume = [int]$o.volume } catch {} }',
  '  try { $s.SpeakAsync([string]$o.text) | Out-Null } catch {}',
  '}',
].join('\n')

let child: ChildProcess | null = null

/** 估算朗读耗时（毫秒）：中文默认语速约 5 字/秒，rate 每档约 ±10%。 */
export function estimateSapiMs(text: string, rate = 0): number {
  const speed = 1 + rate * 0.1
  return Math.max(300, Math.round((text.length * 200) / Math.max(0.3, speed)))
}

function ensure(log: (m: string) => void): ChildProcess | null {
  if (child && child.exitCode === null && !child.killed) return child
  const encoded = Buffer.from(SCRIPT, 'utf16le').toString('base64')
  try {
    child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
      stdio: ['pipe', 'ignore', 'ignore'],
      windowsHide: true,
    })
  } catch (e) {
    log('SAPI spawn 异常: ' + (e instanceof Error ? e.message : String(e)))
    child = null
    return null
  }
  child.on('error', (e) => { log('SAPI 进程错误: ' + e.message); child = null })
  child.on('exit', () => { child = null })
  return child
}

/**
 * 朗读一句并返回 kill 句柄。异步排队：SAPI 自动顺次播放，
 * onDone 由估算时长触发（kill 时取消）。
 */
export function speakSapi(opts: SapiOptions, log: (m: string) => void, onDone?: () => void): () => void {
  const proc = ensure(log)
  const rate = typeof opts.rate === 'number' ? opts.rate : 0
  let timer: ReturnType<typeof setTimeout> | null = null
  let done = false
  const finish = (): void => {
    if (done) return
    done = true
    if (timer) clearTimeout(timer)
    onDone?.()
  }
  if (!proc?.stdin || proc.stdin.destroyed) {
    log('SAPI 进程不可用，跳过本次播报')
    finish()
    return () => { finish() }
  }
  try {
    proc.stdin.write(JSON.stringify({
      text: opts.text,
      voice: opts.voice || undefined,
      rate,
      volume: typeof opts.volume === 'number' ? opts.volume : undefined,
    }) + '\n')
    timer = setTimeout(finish, estimateSapiMs(opts.text, rate))
  } catch (e) {
    log('SAPI 写入失败: ' + (e instanceof Error ? e.message : String(e)))
    finish()
    return () => { finish() }
  }
  return () => {
    if (timer) { clearTimeout(timer); timer = null }
    done = true
    try { proc.stdin?.write('__CANCEL__\n') } catch { /* 忽略 */ }
  }
}

/** 关闭常驻进程（插件卸载/热重载时调用）。 */
export function closeSapi(): void {
  const p = child
  child = null
  if (!p) return
  try { p.stdin?.write('__EXIT__\n') } catch { /* 忽略 */ }
  try { p.kill() } catch { /* 忽略 */ }
}
