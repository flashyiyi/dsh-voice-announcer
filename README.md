# dsh-voice-announcer

**English** | [简体中文](README.zh-CN.md)

A voice announcement plugin for DSH (DeepSeek Harness). It listens for each session's `turn/end` event and speaks the **session title, round number, and outcome** — so you know which conversation finished and whether it encountered an error, without watching the screen.

## Features

- **Clear announcements** — `Session title: Round N ended`, with dedicated copy for errors, aborts, truncation, and interruptions
- **8-language support** — announcement copy switches automatically based on the voice language (Chinese, English, Japanese, Korean, French, German, Russian, Spanish), falling back to Chinese
- **Subagent control** — subagent sessions are silent by default; enable them with one toggle
- **Web settings UI** — configure everything in Settings → Plugin configuration; changes apply live, no config-file editing
- **Voice preview** — a "Preview" button next to the voice picker synthesizes a sample using the current rate and pitch
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
    voice: auto              # auto: follow UI language; or a specific voice id
    announceCompleted: true
    announceError: true
    announceSubagent: false  # announce subagent sessions too
```

### Options

| Option | Default | Description |
| --- | --- | --- |
| enabled | true | Master switch |
| engine | edge-tts | Engine; voice/rate/pitch controls are disabled when sapi is selected |
| voice | auto | Voice id (edge-tts only), see below; `auto` picks by UI language (zh→Xiaoxiao, en→Aria) when unset |
| rate | +0% | Speech rate (edge-tts), slider -50% ~ +50% |
| pitch | +0Hz | Speech pitch (edge-tts), slider -50Hz ~ +50Hz |
| announceCompleted | true | Announce normal completion |
| announceError | true | Announce errors, aborts, and truncations |
| announceSubagent | false | Announce subagent sessions too |

## Voices (edge-tts, 22)

| Language | Voices |
| --- | --- |
| Chinese | Xiaoxiao / Xiaoyi / Yunxi / Yunyang / Yunjian (zh-CN-*Neural) |
| Dialects | Xiaobei (Liaoning), Xiaoni (Shaanxi) |
| Cantonese | HiuMaan (zh-HK) |
| Taiwanese | HsiaoChen (zh-TW) |
| English | Aria / Jenny / Guy / Davis (en-US), Sonia / Ryan (en-GB) |
| Japanese | Nanami / Keita (ja-JP) |
| Korean | SunHi (ko-KR) |
| French | Denise (fr-FR) |
| German | Katja (de-DE) |
| Russian | Svetlana (ru-RU) |
| Spanish | Elvira (es-ES) |

> Non-CJK voices require the text to be in the matching language (server-side requirement); per-language preview texts are built in.

## Behavior

- Subagent sessions are not announced by default (enable via `announceSubagent`)
- Each announcement is synthesized and streamed straight to the player — no temp files, no conversion; if ffplay is missing it falls back to SAPI
- Error messages are included (truncated to 60 characters); aborts distinguish "by you" from "by the parent agent"

## Development

```bash
# Build the host (requires the tsc from a DSH source checkout)
DSH_CHECKOUT=<path-to-dsh-harness> bash scripts/build.sh
# Build the client (web settings card)
npx tsdown
```

## License

BSD-3-Clause
