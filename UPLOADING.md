# DSH 插件上传 / 更新 / 版本规范（通用指南）

> 供开发/维护 DSH（DeepSeek Harness）生态插件的 AI 与开发者参考。
> 覆盖：安装性要求、GitHub 规范、npm 发布、awesome-dsh-plugin 收录、通用工程与性能纪律、版本与 TAG。
> 均为生态通用要求，不涉及具体插件。

## 1. 安装性（最重要，先于一切）

DSH 插件通过 `dsh plugin --profile <profile> add <包名>` 安装。**可安装的前提是 package.json 声明 `dsh.bundle`**：

```jsonc
{
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },  // ← 必须（装配补丁）
    "client": { "platform": "web" }               // ← 仅当有浏览器 UI 时需要
  }
}
```

配套的 `cordis.patch.yml`（仓库根，或 bundle 引用的路径）：

```yaml
- insert:
    - id: your-plugin-id          # 插件 id（与 apply 的 name 一致）
      config:                     # 可选：默认配置
        enabled: true
```

> ⚠️ **只声明 `dsh.client` 不算可安装**——这是 awesome-dsh-plugin 收录最常见的被拒原因。
> 纯 Node 插件（无 UI）不需要 `dsh.client`。

## 2. GitHub 仓库要求

- 真实可用的代码（占位 / 纯 README / 空壳不收）。
- 添加 **`dsh-plugin`** topic（收录会检查）。
- 活跃维护：定期扫描会移除仓库消失 / 归档 / 长期停更的条目。
- 命名：仓库建议 `dsh-<功能>`（如 dsh-voice、dsh-search），生态惯例。

## 3. npm 发布

### 3.1 包名

- **不要用 `@dsh-external/*` 前缀**——那是注入器本地命名空间，publish 会 404。
- 生态惯例是**无 scope**（dsh-voice、dsh-ears、dshmarket 都是）。
- 小写、连字符命名。

### 3.2 peerDependencies（关键坑）

官方 `@deepseek-ai/*` 包必须声明为 **peerDependencies**（不是 dependencies），且**必须带显式预发布分支**：

```jsonc
// ❌ 看起来很宽，但静默排除所有 0.1.0-* 预发布（用户会踩 ERESOLVE）
"peerDependencies": { "@deepseek-ai/dsh-tools": ">=0.0.1-rc.1 <0.2.0" }

// ✅ 在匹配的 major.minor.patch 元组上带预发布标签
"peerDependencies": {
  "@deepseek-ai/dsh-tools": ">=0.0.1-rc.1 <0.1.0 || >=0.1.0-rc.1 <0.2.0-0"
}
```

规则：node-semver 只有某比较符与版本的 `major.minor.patch` 元组完全一致**且自身带预发布标签**时，才放行预发布版。宽范围（哪怕 `>=0.0.0-0 <0.2.0-0`）匹配不到 `0.1.0-rc.6`。每个官方包写一段即可（DSH 当前 0.x 阶段，新包同理加段）。

### 3.3 repository 字段

`repository` 必须指回 GitHub 仓库（npm↔仓库自动关联，awesome 列表据此显示下载量）：

```jsonc
"repository": { "type": "git", "url": "git+https://github.com/<owner>/<repo>.git" }
```

### 3.4 发布内容（files）

`files` 控制发布内容，通常为：

```jsonc
"files": ["lib"]   // + 需要的 README/types；声明式列出的文件才进包
```

发布前 `npm pack --dry-run` 检查产物清单（有无遗漏/多余文件）。

### 3.5 发布凭据（2FA）

npm 2FA 若为 **security key（安全密钥）方式**（非 TOTP），CLI `--otp` 无效。需在网页 tokens 页生成 **Bypass 2FA 的 Granular Access Token**，写入 `~/.npmrc`：

```ini
//registry.npmjs.org/:_authToken=npm_xxxxxxxx
```

发布前 `npm whoami` 验证 token 有效。

## 4. awesome-dsh-plugin 收录

仓库：github.com/awesome-dsh-plugin/awesome-dsh-plugin（先读 `contributing.md`）。

### 4.1 提交方式

- 一个 PR 添加**一个 YAML 文件**：`data/plugins/<owner>__<repo>.yml`（monorepo 子包用 `owner/repo#subname` 命名）。
- 格式：

```yaml
url: https://github.com/owner/repo        # 与仓库完全一致
name: owner/repo                          # 列表显示文字
category: voice                           # 见分类列表
description:
  en: 'One-line description ending with a period.'   # 必填
  zh: '一句话描述，以句号结尾。'                      # 可选，维护者会补
```

- **README 由脚本生成，勿手改**：`npm ci && node scripts/generate-readme.mjs`，两个 README 随 PR 提交。
- 描述含 `: `（英文冒号+空格）必须加引号，否则 YAML 解析失败。
- **一个 PR 最多 3 条**（超了 CI 拒）。
- 只改自己的条目（gate 会列出 PR 修改的既有条目）。

### 4.2 分类

`agi` `ui` `usage` `theme` `model` `identity` `session` `memory` `tools` `browser` `vision` `voice` `docs` `skill` `workflow` `git` `notify` `dev` `security` `remote` `market` `fun`。选最贴合功能者，维护者会微调，不因分类打回。

### 4.3 描述准确性

描述会被**对照代码逐句审核**。写数字（如「46 个工具」）就要真有；写命令/API 就要存在。夸大是打回主因。无营销词，只说功能。

### 4.4 CI 自动检查

1. 每个 PR ≤3 条；2. `dsh.bundle`（只 `dsh.client` 失败）；3. 仓库满 1 天 + ≥10 commits；4. awesome-lint + 站点构建（双语一致等）。检查失败按提示改同一分支推送即可。

### 4.5 可选增强

- **发 npm**：映射自动从 registry 采集，无需在 yml 写 npm 字段（手写会被拒）。前提是 `repository` 指回仓库。
- **tarball**（不发 npm 时）：预构建 tgz 附到 GitHub Release，yml 加 `tarball: https://github.com/owner/repo/releases/latest/download/xxx.tgz`（必须 GitHub Release 托管的 https .tgz）。
- **screenshots**：仓库内 `screenshots.json` 声明 1-8 张图（相对路径，不能跳出目录）。

## 5. 通用工程与性能纪律（踩坑总结）

- **资源注册**：一切贡献走 `ctx.effect()` / `ctx.on()`，注册返回 disposer（HMR 安全）。
- **inject 声明**：apply 里用到的服务必须声明在 `inject`（如 `ctx.sessions` 必须 `inject: ['sessions', ...]`），否则属性访问抛错且难排查（会被 try/catch 吞掉变静默故障）。
- **日志纪律**：
  - 诊断类日志收敛到 `debugLog` 开关（默认关）；关键事件（启动/配置变更/异常/播报）始终记。
  - 流式高频事件（每 token/每句）**不要每事件写日志**（同步写文件会阻塞事件循环 + 文件爆炸）。实测失控可达上百 MB。
  - 高频上报同理：只在状态**真正变化**时发，必要时防抖。
- **网络/连接**：
  - 合成类网络调用做**连接复用/池化**（实测免去每次 TLS 握手，性能提升明显），带 TTL 与 dispose 清理。
  - 超时保护（短超时快速失败 + 降级路径），避免卡死状态机。
  - Node 22 全局 WebSocket（undici）**不能带自定义请求头**——部分服务（如微软 edge-tts）拒绝握手，需自研 RFC 6455 客户端或 `ws` 库；ESM 里 Windows 绝对路径 import 必须 `file:///` 前缀；`https.request` 不接受 `wss:` 协议（转 `https:`）。
- **状态机**：完成回调一律触发（防卡死）；世代号/自引用保护防过期异步结果污染新状态。
- **设置集成**：`installSettingsSection(ctx, namespace, schema, entry, { setSource, onChange })`（dsh-settings），Web 设置页即时生效。
- **client 插件**：入口 `.tsx`（JSX 才被转译）；注册走 slots；输入类字段（可自由输入+建议）慎用 `<datalist>`（部分浏览器聚焦不弹列表），用 select+「自定义…」双模式更可靠。

## 6. 版本号与 TAG

- **semver**：`major.minor.patch`。功能→minor，修复→patch；去依赖/破坏性变更→major（0.x 阶段 minor 即可）。
- **git tag**：`v0.1.0` 格式，与 npm 版本对应（发布 npm 前 commit + tag + push）。
- **发布顺序**：改版本号 → build（host + client）→ git commit + push → `npm publish` → `npm view` 验证（registry CDN 可能有几秒延迟，稍等重查）。
- **GitHub Release**（可选）：预构建 tgz 附件（供 awesome tarball 字段 / 免源码构建安装）。
- **README 同步**：新增配置项/功能必须同步更新 README（双语）——评审和用户都会对照文档。

## 7. 发布前自查清单

- [ ] `dsh.bundle` + `cordis.patch.yml` 就位，`dsh plugin add` 可装
- [ ] peerDependencies 全部带预发布分支
- [ ] `repository` 指回 GitHub
- [ ] `npm pack --dry-run` 产物正确，无多余/缺失
- [ ] 日志分级（关键事件 vs debugLog），无高频写日志
- [ ] 网络调用有连接复用 + 超时 + 降级
- [ ] README 双语同步（含新配置项/功能）
- [ ] 版本号已 bump，git tag + push，npm publish 后 `npm view` 确认
- [ ] （收录时）data/plugins yml + README 重新生成，只改自己的条目
