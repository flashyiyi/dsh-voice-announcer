# dsh-voice-announcer

对话轮结束语音播报守护插件（DSH 事件驱动）：监听每个会话的 turn/end，用语音播报**会话名 + 轮数 + 结果**——不用看屏幕也知道哪个会话聊完了、出没出错。

## 功能

- **播报内容**：`会话名：第 N 轮对话结束了`（出错/中止/截断等各有对应文案）
- **8 语言播报**：按音色语言自动切换文案（中/英/日/韩/法/德/俄/西），未知回退中文
- **子代理静默**：子代理（subagent）会话不播报，只有主会话刷屏消失
- **Web 设置界面**：设置页「插件配置」可改全部配置，live 生效，无需改配置文件
- **音色试听**：音色下拉旁「试听」按钮，带当前语速/音调合成播放
- **引擎**：edge-tts（晓晓神经网络音质，需联网）/ sapi（Windows 本地离线可靠）
- **并发安全**：每次播报唯一临时文件，播完即删，多会话同时完成不丢播报

## 安装

```bash
# 1. 装 dsh-voice（edge-tts 合成引擎，peer 依赖）
dsh plugin --profile web add dsh-voice

# 2. 装本插件
dsh plugin --profile web add dsh-voice-announcer
```

> 没装 dsh-voice 时自动降级 Windows 本地 SAPI 语音（可出声、音质一般），日志提示安装。

### 其他依赖

- **ffmpeg**（edge-tts 模式 MP3→WAV 转换）：`winget install ffmpeg`
- Windows 系统（SoundPlayer 播放）

## 配置

### 方式一：Web 设置界面（推荐）

侧边栏 **设置 → 插件配置 → 语音播报**：改完即保存，live 生效。

### 方式二：配置文件

`~/.dsh/profiles/<profile>/cordis.patch.yml` 追加：

```yaml
- id: dsh-voice-announcer
  config:
    enabled: true
    engine: edge-tts        # edge-tts / sapi
    voice: zh-CN-XiaoxiaoNeural
    announceCompleted: true
    announceError: true
```

### 配置项

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| enabled | true | 总开关 |
| engine | edge-tts | 播报引擎；sapi 时音色/语速/音调控件自动禁用 |
| voice | zh-CN-XiaoxiaoNeural | 音色 id（仅 edge-tts），见下 |
| rate | +0% | 语速（edge-tts），滑杆 -50% ~ +50% |
| pitch | +0Hz | 音调（edge-tts），滑杆 -50Hz ~ +50Hz |
| announceCompleted | true | 正常完成时播报 |
| announceError | true | 出错/中止/截断时播报 |

## 音色（edge-tts，22 个）

| 语言 | 音色 |
| --- | --- |
| 中文 | 晓晓/晓伊/云希/云扬/云健（zh-CN-*Neural） |
| 方言 | 辽宁晓北、陕西晓妮（zh-CN-liaoning/shaanxi-*） |
| 粤语 | 曉曼（zh-HK-HiuMaanNeural） |
| 台语 | 曉臻（zh-TW-HsiaoChenNeural） |
| 英语 | Aria/Jenny/Guy/Davis（en-US）、Sonia/Ryan（en-GB） |
| 日语 | Nanami/Keita（ja-JP） |
| 韩语 | SunHi（ko-KR） |
| 法语 | Denise（fr-FR） |
| 德语 | Katja（de-DE） |
| 俄语 | Svetlana（ru-RU） |
| 西语 | Elvira（es-ES） |

> 非 CJK 音色合成时文本须为对应语言（服务端要求），试听文本已内置各语言。

## 行为

- 子代理会话不播报（只播主会话）
- 唯一临时文件 + 播完即删，并发播报互不干扰、不丢播报
- 出错时附错误信息（截 60 字）；中止时区分"你中止"还是"父代理中止"

## 开发

```bash
# 构建 host（需要 DSH 源码 checkout 的 tsc）
DSH_CHECKOUT=<你的dsh-harness路径> bash scripts/build.sh
# 构建 client（Web 设置卡片）
npx tsdown
```

## License

BSD-3-Clause
