# dsh-voice-announcer

[English](README.md) | **简体中文**

DSH（DeepSeek Harness）语音播报插件：监听每个会话的 `turn/end` 事件，用语音播报**会话名、轮数与结果**——不用盯着屏幕，也能知道哪个会话聊完了、是否出错。

## 功能

- **播报清晰**：`会话名：第 N 轮对话结束了`，出错、中止、截断、打断各有专属文案
- **8 种语言**：按音色语言自动切换播报文案（中/英/日/韩/法/德/俄/西），未知语言回退中文
- **子代理可控**：子代理（subagent）会话默认静默，一键开启即可一并播报
- **Web 设置界面**：在 设置 → 插件配置 中完成全部配置，保存后即时生效，无需改配置文件
- **音色试听**：音色下拉旁提供「试听」按钮，按当前语速与音调合成示例语音
- **双引擎**：edge-tts（神经网络音质，需联网）/ sapi（Windows 本地语音，离线可用）
- **并发安全**：每次播报使用独立临时文件、播完即删；多会话同时完成互不干扰、不丢播报

## 安装

```bash
# 1. 安装 dsh-voice（edge-tts 合成引擎，peer 依赖）
dsh plugin --profile web add dsh-voice

# 2. 安装本插件
dsh plugin --profile web add dsh-voice-announcer
```

> 未安装 dsh-voice 时自动降级为 Windows 本地 SAPI 语音（可出声、音质一般），日志会给出提示。

### 其他依赖

- **ffmpeg**（edge-tts 模式的 MP3→WAV 转换）：`winget install ffmpeg`
- Windows 系统（使用 SoundPlayer 播放）

## 配置

### 方式一：Web 设置界面（推荐）

侧边栏 **设置 → 插件配置 → 语音播报**：保存后即时生效。

### 方式二：配置文件

在 `~/.dsh/profiles/<profile>/cordis.patch.yml` 末尾追加：

```yaml
- id: dsh-voice-announcer
  config:
    enabled: true
    engine: edge-tts        # edge-tts / sapi
    voice: auto              # auto：跟随界面语言；或指定音色 id
    announceCompleted: true
    announceError: true
    announceSubagent: false  # 是否播报子代理会话
```

### 配置项

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| enabled | true | 总开关 |
| engine | edge-tts | 播报引擎；选择 sapi 时音色/语速/音调控件自动禁用 |
| voice | auto | 音色 id（仅 edge-tts），见下；`auto` 按界面语言自动选择（中文→晓晓，英文→Aria），未设置时生效 |
| rate | +0% | 语速（edge-tts），滑杆 -50% ~ +50% |
| pitch | +0Hz | 音调（edge-tts），滑杆 -50Hz ~ +50Hz |
| announceCompleted | true | 对话正常结束时播报 |
| announceError | true | 出错、中止、截断时播报 |
| announceSubagent | false | 是否播报子代理会话 |

## 音色（edge-tts，共 22 个）

| 语言 | 音色 |
| --- | --- |
| 中文 | 晓晓 / 晓伊 / 云希 / 云扬 / 云健（zh-CN-*Neural） |
| 方言 | 晓北（辽宁）、晓妮（陕西） |
| 粤语 | 曉曼（zh-HK-HiuMaanNeural） |
| 台语 | 曉臻（zh-TW-HsiaoChenNeural） |
| 英语 | Aria / Jenny / Guy / Davis（en-US）、Sonia / Ryan（en-GB） |
| 日语 | Nanami / Keita（ja-JP） |
| 韩语 | SunHi（ko-KR） |
| 法语 | Denise（fr-FR） |
| 德语 | Katja（de-DE） |
| 俄语 | Svetlana（ru-RU） |
| 西语 | Elvira（es-ES） |

> 非 CJK 音色要求合成文本与音色语言一致（服务端限制），各语言试听文本已内置。

## 行为

- 子代理会话默认不播报（可通过 `announceSubagent` 开启）
- 每次播报使用独立临时文件、播完即删，并发播报互不干扰、不丢播报
- 出错时附带错误信息（截取前 60 字）；中止时区分「你中止」与「父代理中止」

## 开发

```bash
# 构建 host（需要 DSH 源码 checkout 的 tsc）
DSH_CHECKOUT=<你的dsh-harness路径> bash scripts/build.sh
# 构建 client（Web 设置卡片）
npx tsdown
```

## License

BSD-3-Clause
