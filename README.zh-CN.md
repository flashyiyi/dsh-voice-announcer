# dsh-voice-announcer

[English](README.md) | **简体中文**

DSH（DeepSeek Harness）语音播报插件：监听每个会话的 `turn/end` 事件，用语音播报**会话名、轮数与结果**——不用盯着屏幕，也能知道哪个会话聊完了、是否出错。

## 功能

- **播报清晰**：`会话名：第 N 轮对话结束了`，出错、中止、截断、打断各有专属文案
- **会话独立音色**：每个会话从勾选的音色池中按索引轮转分配一个中文音色并固定，新会话自动错开，跨重启保持
- **音色筛选**：在设置界面勾选 14 个中文音色中的任意子集；只勾 1 个 = 全会话一种声音
- **子代理可控**：子代理（subagent）会话默认静默，一键开启即可一并播报
- **实时朗读**：回复生成过程中按句朗读（edge-tts，句子缓冲、预合成无缝衔接）；可只读当前活动会话，追不上时自动跳到最新内容
- **Web 设置界面**：在 设置 → 插件配置 中完成全部配置，保存后即时生效，无需改配置文件
- **音色试听**：每个音色行都有「试听」按钮，按当前语速与音调合成示例语音
- **双引擎**：edge-tts（神经网络音质，需联网）/ sapi（Windows 本地语音，离线可用）
- **流式播放**：边合成边播放，无临时文件、无转码；首字约 0.6 秒内出声
- **并发安全**：每次播报相互独立；多会话同时完成互不干扰、不丢播报

## 安装

```bash
dsh plugin --profile web add dsh-voice-announcer
```

> edge-tts 合成引擎已内置（零第三方 npm 依赖）。

### 其他依赖

- **ffplay**（edge-tts 模式的流式播放）：`winget install ffmpeg`（自带 ffplay）
- **Node.js ≥ 22**（edge-tts 模式；内置 WebSocket 客户端无需任何外部包）
- Windows 系统（sapi 引擎）

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
    voices: []               # [] = 全部中文音色（默认）；或指定列表，如 [zh-CN-XiaoxiaoNeural, zh-CN-YunxiNeural]
    overlapLive: true         # 多会话重叠朗读（默认开启）：不同音色的会话可同时朗读；设为 false 回退全局单队列
    announceCompleted: true
    announceError: true
    announceSubagent: false  # 是否播报子代理会话
    announceWait: true       # 会话在等你时播报（提问 / 计划审阅 / 审批提权）
    liveRead: true           # 实时朗读：回复生成时边出边念（仅 edge-tts）
    liveReadActiveOnly: false # 只朗读当前活动会话
    liveReadMaxQueue: 5      # 跟读跳跃阈值（待念队列句数）
```

### 配置项

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| enabled | true | 总开关 |
| engine | edge-tts | 播报引擎；选择 sapi 时音色/语速/音调控件自动禁用 |
| voices | [] | 音色池（edge-tts 中文音色）。新会话按索引轮转从池中分配一个并固定；空 = 全部 14 个中文音色（默认）；只 1 个 = 全会话一种声音 |
| rate | +0% | 语速（edge-tts），滑杆 -50% ~ +50% |
| pitch | +0Hz | 音调（edge-tts），滑杆 -50Hz ~ +50Hz |
| announceCompleted | true | 对话正常结束时播报 |
| announceError | true | 出错、中止、截断时播报 |
| announceSubagent | false | 是否播报子代理会话 |
| announceWait | true | 会话挂起等你回应时播报：向你提问、计划待审阅、审批/提权请求 |
| liveRead | true | 实时朗读：回复按句边出边念（仅 edge-tts） |
| liveReadActiveOnly | false | 只朗读当前活动会话（浏览器自动上报） |
| overlapLive | true | 多会话重叠朗读：默认开启 = 不同音色的会话可同时朗读（同会话仍串行）；关闭 = 全局单队列，同一时间只念一个会话 |
| liveReadMaxQueue | 5 | 跟读跳跃：待念队列超过此句数时丢弃旧文本、跳到最新内容 |

## 音色（edge-tts，14 个中文音色）

全部为中文音色（普通话 / 方言 / 粤语 / 台湾）——edge-tts 每个音色都能朗读英文，中英混合内容照常。

| 分组 | 音色 |
| --- | --- |
| 普通话（zh-CN） | 晓晓 · 晓伊 · 云希 · 云扬 · 云健 · 云夏 |
| 方言（zh-CN） | 晓北（辽宁）· 晓妮（陕西） |
| 粤语（zh-HK） | 曉佳 · 曉曼 · 雲龍 |
| 台湾（zh-TW） | 曉臻 · 曉雨 · 雲哲 |

> **会话分配**：新会话（首次朗读时）按 `分配计数 % 音色池长度` 从勾选池中取一个音色并永久固定（持久化到 `voice-announcer-session-voices.json`）。修改筛选只影响之后的分配——已分配会话保持原音色，取模保证新会话与新列表长度自动对齐。

## 行为

- 子代理会话默认不播报（可通过 `announceSubagent` 开启）
- 每个会话固定使用分配到的音色直至会话结束；升级前已朗读过的会话保留旧单音色行为
- 实时朗读默认多会话重叠（不同音色的会话可同时朗读，同会话仍串行）；将「多会话重叠朗读」关闭后回退全局单队列（同一时间只念一个会话）
- 每次播报边合成边流式播放，无临时文件、无转码；ffplay 缺失时自动降级 SAPI
- 会话挂起等你回应时（向你提问 / 计划待审阅 / 审批提权请求）会用该会话音色播报一句提示，只打断该会话的实时朗读（`announceWait` 控制）
- 出错时附带错误信息（截取前 60 字）；中止时区分「你中止」与「父代理中止」

## 开发

```bash
# 构建 host（需要 DSH 源码 checkout 的 tsc）
DSH_CHECKOUT=<你的dsh-harness路径> bash scripts/build.sh
# 构建 client（Web 设置卡片）
npx tsdown
```

## 更新记录

- **0.1.7** — 性能修复：会话标题读取不再走 `sessionProjections.snapshot()`——该调用会对超大会话（百万级事件 × 每个注册投影 key）同步做全量 fold，曾导致 DSH 服务端定期完全卡住（冻结数秒到分钟级后自动恢复）。现在改为轻量反向扫描最近的 `session/title` 事件取标题，播报标题不再触发全量投影。

## License

BSD-3-Clause
