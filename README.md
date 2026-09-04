# dsh-voice-announcer

**English** | [简体中文](README.zh-CN.md)

A voice announcement plugin for DSH (DeepSeek Harness). It listens for each session's `turn/end` event and speaks the **session title, round number, and outcome** — so you know which conversation finished and whether it encountered an error, without watching the screen.

## Features

- **Clear announcements** — `Session title: Round N ended`, with dedicated copy for errors, aborts, truncation, and interruptions
- **Per-session voices** — each session is assigned a Chinese voice from your checked pool (all 14 by default), rotating by index so new sessions differ; the assignment is fixed and persists across restarts
- **Voice filtering** — check any subset of the 14 Chinese voices in the settings UI; checking one voice means every session uses that single voice
- **Subagent control** — subagent sessions are silent by default; enable them with one toggle
- **Live reading** — while a reply streams in, sentences are spoken as they complete (edge-tts, sentence-buffered, pre-synthesized for gapless playback); optionally restrict to the currently active session only, with catch-up jumping when the reading falls behind
- **Web settings UI** — configure everything in Settings → Plugin configuration; changes apply live, no config-file editing
- **Voice preview** — every voice row has a "Preview" button that synthesizes a sample with the current rate and pitch
- **Two engines** — edge-tts (neural voices, requires network) or sapi (offline Windows voices)
- **Streaming playback** — audio plays as it is synthesized (no temp files, no conversion); the first syllable arrives within ~0.6s
- **Concurrency-safe** — each announcement is independent; concurrent sessions never drop or interfere with announcements

## Install

```bash
dsh plugin --profile web add dsh-voice-announcer
```

> The edge-tts engine is built into the plugin (zero third-party npm dependencies).

### Other dependencies

- **ffplay** (streaming playback for edge-tts mode): `winget install ffmpeg` (bundles ffplay)
- **Node.js ≥ 22** (edge-tts mode; the built-in WebSocket client requires no external packages)
- Windows (SAPI engine)

## Configuration

### Option 1: Web settings UI (recommended)

Open **Settings → Plugin configuration → Voice announcement** in the sidebar. Edits are applied live after saving.

### Option 2: Config file

Append the following to `~/.dsh/profiles/<profile>/cordis.patch.yml`:

```yaml
- id: dsh-voice-announcer
  config:
    enabled: true
    engine: edge-tts        # edge-tts / sapi
    voices: []               # [] = all Chinese voices (default); or a list, e.g. [zh-CN-XiaoxiaoNeural, zh-CN-YunxiNeural]
    overlapLive: true         # sessions with different voices read aloud simultaneously (default); set false for a single global queue
    announceCompleted: true
    announceError: true
    announceSubagent: false  # announce subagent sessions too
    announceWait: true       # speak when a session waits for you (question / plan review / approval request)
    liveRead: true           # live-read replies as they stream in (edge-tts only)
    liveReadActiveOnly: false # live-read only the currently active session
    liveReadMaxQueue: 5      # catch-up jump threshold (pending sentences)
```

### Options

| Option | Default | Description |
| --- | --- | --- |
| enabled | true | Master switch |
| engine | edge-tts | Engine; voice/rate/pitch controls are disabled when sapi is selected |
| voices | [] | Voice pool (edge-tts Chinese voices). New sessions pick one by round-robin index from this pool and keep it. Empty = all 14 Chinese voices (default); one entry = every session uses that single voice |
| rate | +0% | Speech rate (edge-tts), slider -50% ~ +50% |
| pitch | +0Hz | Speech pitch (edge-tts), slider -50Hz ~ +50Hz |
| announceCompleted | true | Announce normal completion |
| announceError | true | Announce errors, aborts, and truncations |
| announceSubagent | false | Announce subagent sessions too |
| announceWait | true | Speak when a session pauses waiting for you: it asks a question, presents a plan for review, or requests approval |
| liveRead | true | Live-read replies sentence by sentence while they stream (edge-tts only) |
| liveReadActiveOnly | false | Live-read only the currently active session (the browser reports it) |
| overlapLive | true | Overlap live-reading across sessions: on (default) = sessions with different voices can speak simultaneously (same session still serial); off = one session speaks at a time (global queue) |
| liveReadMaxQueue | 5 | Catch-up jump: when the pending queue exceeds this many sentences, drop the stale ones and jump to the latest content |

## Voices (edge-tts, 14 Chinese voices)

All voices are Chinese (Mandarin / dialects / Cantonese / Taiwanese) — every edge-tts voice can also read English text, so mixed content works.

| Group | Voices |
| --- | --- |
| Mandarin (zh-CN) | Xiaoxiao · Xiaoyi · Yunxi · Yunyang · Yunjian · Yunxia |
| Dialects (zh-CN) | Xiaobei (Liaoning) · Xiaoni (Shaanxi) |
| Cantonese (zh-HK) | HiuGaai · HiuMaan · WanLung |
| Taiwanese (zh-TW) | HsiaoChen · HsiaoYu · YunJhe |

> **Per-session assignment**: a new session (the first time it is read aloud) is assigned the voice at index `allocationCount % voices.length` of your checked pool, then keeps it permanently (persisted to `voice-announcer-session-voices.json`). Changing the filter only affects future assignments — existing sessions keep their voice, and the modulo keeps new sessions aligned to the new list length.

## Behavior

- Subagent sessions are not announced by default (enable via `announceSubagent`)
- Each session keeps its assigned voice until the session ends; a session that already spoke before an upgrade keeps its previous single-voice behavior
- Live reading overlaps across sessions by default — sessions with different voices can read aloud simultaneously (same session stays serial). Set **overlapLive** to false to fall back to a single global queue (one session speaks at a time)
- Each announcement is synthesized and streamed straight to the player — no temp files, no conversion; if ffplay is missing it falls back to SAPI
- When a session pauses waiting for you — it asks a question, presents a plan for review, or requests approval — a prompt is spoken with that session's voice, interrupting only that session's live reading (control via `announceWait`)
- Error messages are included (truncated to 60 characters); aborts distinguish "by you" from "by the parent agent"

## Development

```bash
# Build the host (requires the tsc from a DSH source checkout)
DSH_CHECKOUT=<path-to-dsh-harness> bash scripts/build.sh
# Build the client (web settings card)
npx tsdown
```

## Changelog

- **0.1.7** — Performance fix: the session-title lookup no longer calls `sessionProjections.snapshot()`, which synchronously folds the entire event log of a huge session (millions of events × every registered projection key) and can freeze the DSH web server for seconds to minutes. Titles are now read with a lightweight reverse scan for the latest `session/title` event.

## License

BSD-3-Clause
