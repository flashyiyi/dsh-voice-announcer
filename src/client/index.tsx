/**
 * dsh-voice-announcer — client 配置卡片。
 * 注册 settings.plugin.item（key=voice-announcer）。样式复刻官方
 * ui-settings-plugins 的 PluginCard + fields（CSS 变量一致）。
 */
import { useEffect, useRef, useState } from 'react'
import type { SlotsService } from '@deepseek-ai/dsh-client-ui-slots'
import type { SettingsScope } from '@deepseek-ai/dsh-client-runtime/client'
import type { SettingsScopeBinder } from '@deepseek-ai/dsh-client-ui-settings'

type ClientContext = {
  slots: SlotsService
  settingsScope: SettingsScopeBinder
}

export const inject = ['slots', 'settingsScope']

export const name = 'dsh-voice-announcer'

const NS = 'voice-announcer'

interface VoiceAnnouncerSettings {
  enabled?: boolean
  engine?: 'edge-tts' | 'sapi'
  voice?: string
  rate?: string
  pitch?: string
  announceCompleted?: boolean
  announceError?: boolean
  announceSubagent?: boolean
}

/** dsh-voice 支持的音色（VOICES 全集）。 */
const VOICES = [
  'zh-CN-XiaoxiaoNeural', 'zh-CN-XiaoyiNeural', 'zh-CN-YunxiNeural', 'zh-CN-YunyangNeural', 'zh-CN-YunjianNeural',
  'zh-CN-liaoning-XiaobeiNeural', 'zh-CN-shaanxi-XiaoniNeural',
  'zh-TW-HsiaoChenNeural', 'zh-HK-HiuMaanNeural',
  'en-US-AriaNeural', 'en-US-JennyNeural', 'en-US-GuyNeural', 'en-US-DavisNeural',
  'en-GB-SoniaNeural', 'en-GB-RyanNeural',
  'ja-JP-NanamiNeural', 'ja-JP-KeitaNeural',
  'ko-KR-SunHiNeural', 'fr-FR-DeniseNeural', 'de-DE-KatjaNeural', 'ru-RU-SvetlanaNeural', 'es-ES-ElviraNeural',
]

type FieldType = 'bool' | 'select' | 'slider'
interface FieldDef {
  key: keyof VoiceAnnouncerSettings
  label: string
  hint: string
  type: FieldType
  options?: string[]
  min?: number
  max?: number
  step?: number
  suffix?: string
}
const FIELDS: FieldDef[] = [
  { key: 'enabled', label: '启用播报', hint: '关闭后不再播报任何对话结束通知', type: 'bool' },
  { key: 'engine', label: '播报引擎', hint: 'edge-tts：神经网络音质，需联网与 ffmpeg；sapi：Windows 本地语音，离线可用', type: 'select', options: ['edge-tts', 'sapi'] },
  { key: 'voice', label: '音色', hint: '「自动」跟随界面语言；其余为 edge-tts 音色，可试听', type: 'select', options: ['auto', ...VOICES] },
  { key: 'rate', label: '语速', hint: '相对正常语速的偏移（-50% ~ +50%）', type: 'slider', min: -50, max: 50, step: 5, suffix: '%' },
  { key: 'pitch', label: '音调', hint: '相对正常音调的偏移（-50Hz ~ +50Hz）', type: 'slider', min: -50, max: 50, step: 5, suffix: 'Hz' },
  { key: 'announceCompleted', label: '完成时播报', hint: '对话正常结束时播报', type: 'bool' },
  { key: 'announceError', label: '出错时播报', hint: '出错、中止、截断等异常结束时播报', type: 'bool' },
  { key: 'announceSubagent', label: '子任务也播报', hint: '子代理（subagent）会话默认不播报，开启后一并播报', type: 'bool' },
]

/** CSS 变量别名（与官方 dsw-alias 一致）。 */
const v = {
  border: 'var(--dsw-alias-border-l2)',
  bg3: 'var(--dsw-alias-bg-layer-3)',
  bg2: 'var(--dsw-alias-bg-layer-2)',
  label1: 'var(--dsw-alias-label-primary)',
  label2: 'var(--dsw-alias-label-secondary)',
  label3: 'var(--dsw-alias-label-tertiary)',
  brand: 'var(--dsw-alias-brand-primary)',
  err: 'var(--dsw-alias-label-error)',
}

function VoiceAnnouncerCard(props: { scope: SettingsScope<VoiceAnnouncerSettings> }) {
  const { scope } = props
  const [snap, setSnap] = useState(scope.getSnapshot())
  const [open, setOpen] = useState(false)
  // 草稿：字段名 → 待写值；null 表示 clear。
  const [draft, setDraft] = useState<Record<string, unknown | null>>({})
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)
  const dirtyRef = useRef(false)
  dirtyRef.current = Object.keys(draft).length > 0

  useEffect(() => scope.subscribe(() => { setSnap(scope.getSnapshot()) }), [scope])

  const value = (snap.status === 'ready' ? snap.value : {}) as Partial<VoiceAnnouncerSettings>
  const user = (snap.status === 'ready' ? snap.user : undefined) as Record<string, unknown> | undefined
  const writable = snap.writable

  /** 字段当前显示值：草稿优先，否则存储值。 */
  const fieldValue = (field: FieldDef): unknown => {
    if (field.key in draft) return draft[field.key]
    return value[field.key]
  }
  /** 字段是否被用户覆盖（user 层有值，或草稿里 set）。 */
  const overridden = (field: FieldDef): boolean =>
    draft[field.key] !== undefined || (user !== undefined && field.key in user)
  /** 当前引擎（草稿优先）。 */
  const engine = String(fieldValue(FIELDS[1]) ?? 'edge-tts')
  /** sapi 引擎：不支持 voice/rate/pitch（SAPI 用系统语音）。 */
  const engineIsSapi = engine === 'sapi'
  const fieldDisabled = (field: FieldDef): boolean => !writable || (engineIsSapi && (field.key === 'voice' || field.key === 'rate' || field.key === 'pitch'))

  const parseNum = (v: unknown, suffix: string): number | undefined => {
    if (typeof v !== 'string') return undefined
    const n = Number(v.replace(suffix, '').trim())
    return Number.isFinite(n) ? n : undefined
  }
  const fmtNum = (n: number, suffix: string): string => (n >= 0 ? '+' : '') + n + suffix

  const stage = (field: string, val: unknown | null): void => {
    setFailed(false)
    setDraft(prev => ({ ...prev, [field]: val }))
  }
  const stageClear = (field: string): void => {
    setFailed(false)
    setDraft(prev => {
      const next = { ...prev }
      delete next[field]
      return next
    })
  }
  const commit = (): void => {
    if (Object.keys(draft).length === 0 || saving || !writable) return
    setSaving(true)
    const writes: Promise<void>[] = []
    for (const [field, val] of Object.entries(draft)) {
      if (val === null || val === undefined) writes.push(scope.unset(field))
      else writes.push(scope.set(field, val))
    }
    void Promise.all(writes).then(() => {
      setDraft({})
      setSaving(false)
    }).catch(() => {
      setFailed(true)
      setSaving(false)
    })
  }
  const discard = (): void => {
    if (!dirtyRef.current && !failed) return
    setDraft({})
    setFailed(false)
  }

  const inputBase: React.CSSProperties = {
    height: 34, padding: '0 12px', border: '1px solid ' + v.border, borderRadius: 8,
    background: v.bg3, font: 'inherit', fontSize: 13, lineHeight: '1.5', color: v.label1,
    width: 220,
  }

  return (
    <li style={{ listStyle: 'none', border: '1px solid ' + v.border, borderRadius: 12, background: open ? v.bg2 : v.bg3, transition: 'border-color .16s, background .16s' }}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        style={{ width: '100%', appearance: 'none', border: 0, background: 'none', font: 'inherit', color: 'inherit', textAlign: 'left', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 12, padding: '14px 16px', borderRadius: 12 }}
      >
        <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: 15, fontWeight: 600, lineHeight: '1.4', color: v.label1 }}>语音播报</span>
          <span style={{ fontSize: 13, lineHeight: '1.5', color: v.label3 }}>对话结束时语音播报会话名、轮数与结果（edge-tts / SAPI）</span>
        </span>
        {dirtyRef.current
          ? <span style={{ flex: 'none', borderRadius: 999, padding: '1px 8px', fontSize: 11, lineHeight: '17px', fontWeight: 500, whiteSpace: 'nowrap', background: 'var(--dsw-alias-bg-module-platform)', color: v.label2 }}>有未保存的修改</span>
          : null}
        <span style={{ flex: 'none', color: v.label3, transition: 'transform .16s', transform: open ? 'rotate(180deg)' : undefined, fontSize: 12 }}>▾</span>
      </button>
      {open
        ? (
          <div style={{ borderTop: '1px solid ' + v.border, margin: '0 16px', paddingBottom: 8 }}>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {FIELDS.map((field, idx) => {
                const cur = fieldValue(field)
                const ovr = overridden(field)
                return (
                  <div key={field.key} style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '12px 0', borderTop: idx === 0 ? 'none' : '1px solid ' + v.border }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 500, lineHeight: '1.5', color: v.label1 }}>{field.label}</span>
                      {ovr
                        ? (
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                            <span style={{ borderRadius: 999, padding: '1px 8px', fontSize: 11, lineHeight: '17px', whiteSpace: 'nowrap', fontWeight: 500, background: 'var(--dsw-alias-bg-module-platform)', color: v.label2 }}>已自定义</span>
                            <button type="button" disabled={!writable} onClick={() => stageClear(field.key as string)}
                              style={{ border: 'none', background: 'none', padding: 0, font: 'inherit', fontSize: 12, lineHeight: '1.5', color: v.label2, cursor: 'pointer' }}>重置</button>
                          </span>
                        )
                        : null}
                    </div>
                    {field.type === 'bool'
                      ? (
                        <input type="checkbox" checked={cur === true} disabled={fieldDisabled(field)}
                          onChange={(e) => stage(field.key as string, e.target.checked)}
                          style={{ width: 16, height: 16, accentColor: v.brand }} />
                      )
                      : field.type === 'slider'
                        ? (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                            <input type="range" min={field.min ?? -50} max={field.max ?? 50} step={field.step ?? 5}
                              disabled={fieldDisabled(field)}
                              value={parseNum(cur, field.suffix ?? '') ?? 0}
                              onChange={(e) => stage(field.key as string, fmtNum(Number(e.target.value), field.suffix ?? ''))}
                              style={{ flex: 1, accentColor: v.brand }} />
                            <span style={{ width: 56, textAlign: 'right', fontSize: 13, color: v.label1 }}>
                              {fmtNum(parseNum(cur, field.suffix ?? '') ?? 0, field.suffix ?? '')}
                            </span>
                          </div>
                        )
                        : (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <select value={String(cur ?? '')} disabled={fieldDisabled(field)}
                              onChange={(e) => { const val = e.target.value; stage(field.key as string, val === '' ? null : val) }}
                              style={inputBase}>
                              {(field.options ?? []).map(o => <option key={o} value={o}>{o}</option>)}
                            </select>
                            {field.key === 'voice'
                              ? (
                                <button type="button"
                                  disabled={String(fieldValue(field) ?? '') === 'auto' || !writable}
                                  onClick={() => {
                                    const voice = String(fieldValue(field) ?? '')
                                    if (!voice || voice === 'auto') return
                                    void (async () => {
                                      try {
                                        const resp = await fetch('/voice-announcer/preview', {
                                          method: 'POST',
                                          headers: { 'Content-Type': 'application/json' },
                                          body: JSON.stringify({
                                            voice,
                                            rate: String(fieldValue(FIELDS[3]) ?? '+0%'),
                                            pitch: String(fieldValue(FIELDS[4]) ?? '+0Hz'),
                                          }),
                                        })
                                        if (!resp.ok) return
                                        const blob = await resp.blob()
                                        const url = URL.createObjectURL(blob)
                                        const audio = new Audio(url)
                                        audio.onended = () => URL.revokeObjectURL(url)
                                        void audio.play()
                                      } catch { /* 试听失败静默 */ }
                                    })()
                                  }}
                                  style={{ appearance: 'none', border: '1px solid ' + v.border, borderRadius: 8, padding: '5px 12px', font: 'inherit', fontSize: 13, lineHeight: '1.5', cursor: 'pointer', background: 'none', color: v.label2, whiteSpace: 'nowrap' }}>
                                  试听
                                </button>
                              )
                              : null}
                          </div>
                        )}
                    <p style={{ margin: 0, fontSize: 12, lineHeight: '1.5', color: v.label3 }}>{field.hint}</p>
                  </div>
                )
              })}
            </div>
            {!writable
              ? <p style={{ margin: '12px 0 0', fontSize: 12, lineHeight: '1.5', color: v.label3 }}>设置文档当前为只读，无法修改。</p>
              : null}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, padding: '12px 0 4px', borderTop: '1px solid ' + v.border }}>
              {failed
                ? <p style={{ flex: 1, minWidth: 0, margin: 0, fontSize: 12, lineHeight: '1.5', color: v.err }}>保存失败：写入被拒绝</p>
                : null}
              <button type="button" disabled={!dirtyRef.current || saving} onClick={discard}
                style={{ appearance: 'none', border: '1px solid ' + v.border, borderRadius: 8, padding: '5px 14px', font: 'inherit', fontSize: 13, lineHeight: '1.5', cursor: 'pointer', background: 'none', color: v.label2, opacity: (!dirtyRef.current || saving) ? 0.4 : 1 }}>
                放弃修改
              </button>
              <button type="button" disabled={!dirtyRef.current || saving} onClick={commit}
                style={{ appearance: 'none', border: '1px solid transparent', borderRadius: 8, padding: '5px 14px', font: 'inherit', fontSize: 13, lineHeight: '1.5', cursor: 'pointer', background: v.label1, color: v.bg3, opacity: (!dirtyRef.current || saving) ? 0.4 : 1 }}>
                {saving ? '保存中…' : '保存设置'}
              </button>
            </div>
          </div>
        )
        : null}
    </li>
  )
}

export function apply(ctx: ClientContext): void {
  const scope = ctx.settingsScope.bind<VoiceAnnouncerSettings>({ namespace: NS })

  ctx.effect(() => ctx.slots.inject('settings.plugin.item', () =>
    ctx.slots.register({
      name: 'settings.plugin.item',
      key: NS,
      label: () => '语音播报',
      inject: () => ({ scope }),
    }, VoiceAnnouncerCard as never),
  ), 'voice-announcer: settings card')
}
