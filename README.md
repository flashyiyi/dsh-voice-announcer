# dsh-voice-announcer

**English** | [简体中文](README.zh-CN.md)

Voice announcement plugin for DSH (DeepSeek Harness): listens to every session's `turn/end` and speaks **session title + round number + outcome** — know which conversation finished and whether it errored without looking at the screen.

## Features

- **Announcement format**: `Session title: Round N ended` (distinct copy for errors, aborts, truncation, etc.)
- **8-language announcements**: copy switches automatically by voice language (zh/en/ja/ko/fr/de/ru/es), falls back to Chinese
- **Subagent silence**: subagent sessions are not announced — no spam, main sessions only
- **Web settings UI**: configure everything in Settings → Plugin configuration, live-applied, no config file editing
- **Voice preview**: "Preview" button next to the voice picker, synthesizes with current rate/pitch
- **Engines**: edge-tts (neural voices, requires internet) / sapi (offline Windows voices)
- **Concurrency-safe**: unique temp file per announcement, deleted after playback; concurrent sessions never drop announcements

## Install

```bash
# 1. Install dsh-voice (edge-tts engine, peer dependency)
dsh plugin --profile web add dsh-voice

# 2. Install this plugin
dsh plugin --profile web add dsh-voice-announcer
```

> Falls back to Windows local SAPI voice (audible, lower quality) when dsh-voice is missing; the log will tell you.

### Other dependencies

- **ffmpeg** (MP3→WAV conversion for edge-tts mode): `winget install ffmpeg`
- Windows (SoundPlayer playback)

## Configuration

### Option 1: Web settings UI (recommended)

Sidebar **Settings → Plugin configuration → 语音播报**: edits are saved and applied live.

### Option 2: Config file

Append to `~/.dsh/profiles/<profile>/cordis.patch.yml`:

```yaml
- id: dsh-voice-announcer
  config:
    enabled: true
    engine: edge-tts        # edge-tts / sapi
    voice: zh-CN-XiaoxiaoNeural
    announceCompleted: true
    announceError: true
```

### Options

| Option | Default | Description |
| --- | --- | --- |
| enabled | true | Master switch |
| engine | edge-tts | Engine; voice/rate/pitch controls are disabled when sapi is selected |
| voice | zh-CN-XiaoxiaoNeural | Voice id (edge-tts only), see below |
| rate | +0% | Speech rate (edge-tts), slider -50% ~ +50% |
| pitch | +0Hz | Speech pitch (edge-tts), slider -50Hz ~ +50Hz |
| announceCompleted | true | Announce normal completion |
| announceError | true | Announce errors/aborts/truncations |

## Voices (edge-tts, 22)

| Language | Voices |
| --- | --- |
| Chinese | Xiaoxiao/Xiaoyi/Yunxi/Yunyang/Yunjian (zh-CN-*Neural) |
| Dialects | Xiaobei (Liaoning), Xiaoni (Shaanxi) |
| Cantonese | HiuMaan (zh-HK) |
| Taiwanese | HsiaoChen (zh-TW) |
| English | Aria/Jenny/Guy/Davis (en-US), Sonia/Ryan (en-GB) |
| Japanese | Nanami/Keita (ja-JP) |
| Korean | SunHi (ko-KR) |
| French | Denise (fr-FR) |
| German | Katja (de-DE) |
| Russian | Svetlana (ru-RU) |
| Spanish | Elvira (es-ES) |

> Non-CJK voices require text in the matching language (server-side requirement); preview texts are built in per language.

## Behavior

- Subagent sessions are never announced (main sessions only)
- Unique temp file + delete after playback; concurrent announcements never interfere or drop
- Error messages included (truncated to 60 chars); aborts distinguish "by you" vs "by parent agent"

## Development

```bash
# Build host (needs the DSH source checkout's tsc)
DSH_CHECKOUT=<path-to-dsh-harness> bash scripts/build.sh
# Build client (web settings card)
npx tsdown
```

## License

BSD-3-Clause
