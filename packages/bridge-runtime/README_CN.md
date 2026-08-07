# Claude-to-IM Skill

将 Claude Code / Codex 桥接到 IM 平台 —— 在 Telegram、Discord、飞书、QQ 或微信中与 AI 编程代理对话。

[English](README.md)

> **想要桌面图形界面？** 试试 [CodePilot](https://github.com/op7418/CodePilot) —— 一个功能完整的桌面应用，提供可视化聊天界面、会话管理、文件树预览、权限控制等。本 Skill 从 CodePilot 的 IM 桥接模块中提取而来，适合偏好轻量级纯 CLI 方案的用户。

---

## 工作原理

本 Skill 运行一个后台守护进程，将你的 IM 机器人连接到 Claude Code 或 Codex 会话。来自 IM 的消息被转发给 AI 编程代理，响应（包括工具调用、权限请求、流式预览）会发回到聊天中。

```
你 (Telegram/Discord/飞书/QQ/微信)
  ↕ Bot API
后台守护进程 (Node.js)
  ↕ Claude Agent SDK 或 Codex SDK（通过 CTI_RUNTIME 配置）
Claude Code / Codex → 读写你的代码库
```

## 功能特点

- **五大 IM 平台** — Telegram、Discord、飞书、QQ、微信，可任意组合启用
- **交互式配置** — 引导式向导逐步收集 token，附带详细获取说明
- **权限控制** — 工具调用需要在聊天中通过内联按钮（Telegram/Discord）或文本 `/perm` 命令 / 快捷 `1/2/3` 回复（飞书/QQ/微信）明确批准
- **流式预览** — 实时查看 Claude 的输出（Telegram 和 Discord 支持）
- **可选本地语音预览** — 开发版 `0.3.0` 新增飞书首发的本地 ASR/TTS、原生 Opus 回复和 Contract 驱动的控制面板页面；语音默认关闭
- **会话持久化** — 对话在守护进程重启后保留
- **密钥保护** — token 以 `chmod 600` 存储，日志中自动脱敏
- **无需编写代码** — 安装 Skill 后运行 `/claude-to-im setup`，或直接对 Codex 说 `claude-to-im setup`

## 前置要求

- **Node.js >= 20**
- **Claude Code CLI**（`CTI_RUNTIME=claude` 或 `auto` 时需要）— 已安装并完成认证（`claude` 命令可用）
- **Codex CLI**（`CTI_RUNTIME=codex` 或 `auto` 时需要）— `npm install -g @openai/codex`。鉴权：运行 `codex auth login`，或设置 `OPENAI_API_KEY`（可选，API 模式）

## 安装

请先按你实际使用的 AI Agent 产品选择对应安装方式。

### Claude Code

#### 推荐：`npx skills`

```bash
npx skills add op7418/Claude-to-IM-skill
```

安装完成后，直接对 Claude Code 说：

```text
/claude-to-im setup
```

如果你主要想接微信，也可以直接说：

```text
帮我接微信
```

#### 备选：直接克隆到 Claude Code Skills 目录

```bash
git clone https://github.com/op7418/Claude-to-IM-skill.git ~/.claude/skills/claude-to-im
```

Claude Code 会自动发现。

#### 备选：符号链接方式（适合开发）

```bash
git clone https://github.com/op7418/Claude-to-IM-skill.git ~/code/Claude-to-IM-skill
mkdir -p ~/.claude/skills
ln -s ~/code/Claude-to-IM-skill ~/.claude/skills/claude-to-im
```

### Codex

#### 推荐：使用 Codex 安装脚本

```bash
git clone https://github.com/op7418/Claude-to-IM-skill.git ~/code/Claude-to-IM-skill
bash ~/code/Claude-to-IM-skill/scripts/install-codex.sh
```

如果你想保留可开发的本地仓库：

```bash
bash ~/code/Claude-to-IM-skill/scripts/install-codex.sh --link
```

安装脚本会把 Skill 放到 `~/.codex/skills/claude-to-im`，并自动安装依赖、构建 daemon。

安装完成后，直接对 Codex 说：

```text
claude-to-im setup
```

如果你主要想接微信，也可以直接说：

```text
帮我接微信桥接
```

#### 备选：直接克隆到 Codex skills 目录

```bash
git clone https://github.com/op7418/Claude-to-IM-skill.git ~/.codex/skills/claude-to-im
cd ~/.codex/skills/claude-to-im
npm install
npm run build
```

### 验证安装

**Claude Code：** 启动新会话，输入 `/` 应能看到 `claude-to-im`。也可以直接问 Claude："What skills are available?"

**Codex：** 启动新会话，说 `claude-to-im setup`、`start bridge` 或 `帮我接微信桥接`。

## 更新 Skill

请按你的 AI Agent 产品和安装方式选择对应的更新方式。

### Claude Code

如果你是通过 `npx skills` 安装的，直接重新执行：

```bash
npx skills add op7418/Claude-to-IM-skill
```

如果你是通过 `git clone` 或符号链接安装的：

```bash
cd ~/.claude/skills/claude-to-im
git pull
npm install
npm run build
```

更新完成后，对 Claude Code 说：

```text
/claude-to-im doctor
/claude-to-im start
```

### Codex

如果你是用 `install-codex.sh` 的复制模式安装的：

```bash
rm -rf ~/.codex/skills/claude-to-im
bash ~/code/Claude-to-IM-skill/scripts/install-codex.sh
```

如果你是用 `--link` 模式，或者直接克隆到 Codex skills 目录：

```bash
cd ~/.codex/skills/claude-to-im
git pull
npm install
npm run build
```

更新完成后，对 Codex 说：

```text
claude-to-im doctor
start bridge
```

## 快速开始

### 1. 配置

**Claude Code**

```text
/claude-to-im setup
```

**Codex**

```text
claude-to-im setup
```

向导会引导你完成以下步骤：

1. **选择渠道** — 选择 Telegram、Discord、飞书、QQ、微信，或任意组合
2. **输入凭据** — 向导会详细说明如何获取每个 token、需要开启哪些设置、授予哪些权限
3. **设置默认值** — 工作目录、模型、模式
4. **验证** — 立即通过平台 API 验证 token 有效性

### 2. 启动

**Claude Code**

```text
/claude-to-im start
```

**Codex**

```text
start bridge
```

守护进程在后台启动。关闭终端后仍会继续运行。

### 3. 开始聊天

打开 IM 应用，给你的机器人发消息，Claude Code / Codex 会通过桥接回复。

当 Claude 需要使用工具（编辑文件、运行命令）时，聊天中会弹出带有 **允许** / **拒绝** 按钮的权限请求（Telegram/Discord），或文本 `/perm` 命令提示 / 快捷 `1/2/3` 回复（飞书/QQ/微信）。

## 命令列表

所有命令在 Claude Code 或 Codex 中执行：

| Claude Code | Codex（自然语言） | 说明 |
|---|---|---|
| `/claude-to-im setup` | "claude-to-im setup" / "配置" | 交互式配置向导 |
| `/claude-to-im start` | "start bridge" / "启动桥接" | 启动桥接守护进程 |
| `/claude-to-im stop` | "stop bridge" / "停止桥接" | 停止守护进程 |
| `/claude-to-im status` | "bridge status" / "状态" | 查看运行状态 |
| `/claude-to-im logs` | "查看日志" | 查看最近 50 行日志 |
| `/claude-to-im logs 200` | "logs 200" | 查看最近 200 行日志 |
| `/claude-to-im reconfigure` | "reconfigure" / "修改配置" | 交互式修改配置 |
| `/claude-to-im doctor` | "doctor" / "诊断" | 诊断问题 |

## 平台配置指南

`setup` 向导会在每一步提供内联指引，以下是概要：

### Telegram

1. 在 Telegram 中搜索 `@BotFather` → 发送 `/newbot` → 按提示操作
2. 复制 bot token（格式：`123456789:AABbCc...`）
3. 建议：`/setprivacy` → Disable（用于群组）
4. 获取 User ID：给 `@userinfobot` 发消息

### Discord

1. 前往 [Discord 开发者门户](https://discord.com/developers/applications) → 新建应用
2. Bot 标签页 → Reset Token → 复制 token
3. 在 Privileged Gateway Intents 下开启 **Message Content Intent**
4. OAuth2 → URL Generator → scope 选 `bot` → 权限选 Send Messages、Read Message History、View Channels → 复制邀请链接

### 飞书 / Lark

1. 前往[飞书开放平台](https://open.feishu.cn/app)（或 [Lark](https://open.larksuite.com/app)）
2. 创建自建应用 → 获取 App ID 和 App Secret
3. **批量添加权限**：进入"权限管理" → 使用批量配置添加所有必需权限（`setup` 向导提供完整 JSON）
4. 在"添加应用能力"中启用机器人
5. **事件与回调**：选择**长连接**作为事件订阅方式 → 添加 `im.message.receive_v1` 事件
6. **发布**：进入"版本管理与发布" → 创建版本 → 提交审核 → 在管理后台审核通过
7. **注意**：版本审核通过并发布后机器人才能使用

### QQ

> QQ 目前仅支持 **C2C 私聊**（沙箱接入）。不支持群聊/频道、内联权限按钮、流式预览。权限确认使用文本 `/perm ...` 命令。仅支持图片入站（不支持图片回复）。

1. 前往 [QQ 机器人 OpenClaw](https://q.qq.com/qqbot/openclaw)
2. 创建或选择已有 QQ 机器人 → 获取 **App ID** 和 **App Secret**（仅需这两个必填项）
3. 配置沙箱接入，用 QQ 扫码添加机器人
4. `CTI_QQ_ALLOWED_USERS` 填写 `user_openid`（不是 QQ 号）— 可先留空
5. 如果底层 provider 不支持图片输入，设置 `CTI_QQ_IMAGE_ENABLED=false`

### 微信 / Weixin

> 微信当前采用扫码登录、单账号模式、文本权限确认，不支持流式预览。

1. 在已安装的 Skill 目录里运行本地扫码工具：
   - Claude Code 默认安装：`cd ~/.claude/skills/claude-to-im && npm run weixin:login`
   - Codex 默认安装：`cd ~/.codex/skills/claude-to-im && npm run weixin:login`
2. 工具会生成 `~/.claude-to-im/runtime/weixin-login.html`，并尽量自动用浏览器打开
3. 用微信扫码并在手机上确认
4. 成功后，账号会保存到 `~/.claude-to-im/data/weixin-accounts.json`
5. 再次运行扫码工具，会替换当前已绑定的微信账号

补充说明：

- `CTI_WEIXIN_MEDIA_ENABLED` 只控制图片 / 文件 / 视频的入站下载
- 语音消息只使用微信自带的语音转文字结果
- 如果微信没有提供 `voice_item.text`，桥会直接报错，不会自行下载或转写原始语音
- 权限确认使用文本 `/perm ...` 命令或快捷 `1/2/3` 回复

## 本地语音（开发版 0.3.0 预览）

截至 2026-08-07，这是一项源码开发能力，不代表 live skill 或 release 包已经验收。首期渠道只有飞书；微信继续使用平台提供的转写，其他渠道保持现状。

- 语音输入和语音输出均默认关闭；缺少可选语音依赖不能阻断纯文字 Bridge。
- 没有会话覆盖时，可信飞书语音会在本地转写，并默认以语音回复；普通文字默认仍以文字回复。
- 在已连接的飞书会话内发送 `/voice on` 或 `/voice off` 可修改当前会话回复格式。`/voice off` 是硬禁用，直到再次发送 `/voice on` 前都只返回文字；完整优先级为：明确文字 → `/voice off` → 明确语音 → `/voice on` → Runtime 策略 → 入站语音 / 模型提示。这两个命令是 IM 聊天命令，不是 `claude-to-im` 守护进程子命令。
- 语音成功只保留一个飞书原生 Opus 终态。转写、合成、校验、进度卡替换或上传失败时，只收口一次完整文字错误或结果，不再发送相互竞争的第二个终态。
- 模型、FFmpeg、Python 和 ASR/TTS 二进制都是可选依赖，不随 npm、live skill 或 release 包安装，首条语音消息也不会触发下载；必须由用户显式安装或配置路径。
- 语音 Runtime 不读取、不迁移、不依赖 `F:\unity\ST4\.cti-audio`。

职责边界固定如下：

| 层 | 职责 |
|---|---|
| `packages/bridge-core` | 校验当前消息的飞书语音证据、裁决回复模式、调用可选 Speech Host，并保证唯一用户可见终态。 |
| `packages/bridge-runtime` | 负责配置、依赖解析、本机 Sidecar、媒体校验与转换、ASR/TTS 和音色注册表。 |
| `apps/control-panel` | 渲染共享 Contract 状态并调用 Runtime 动作；不实现语音策略、不复制 Provider 枚举，也不在 Runtime 确认前伪造设置已生效。 |

语音数据只位于 `CTI_HOME` 的受控目录：

| 数据 | 路径 |
|---|---|
| 受管模型与二进制 | `CTI_HOME\runtime-deps\speech` |
| 音色注册表与授权参考音频 | `CTI_HOME\runtime\speech\voices` |
| 请求临时文件与默认输出 | `CTI_HOME\runtime\speech` |

共享状态协议只有四态：`ready`、`optional_missing`、`blocked`、`error`。可选组件缺失不会被报告成整个 Bridge 故障；显式错误路径、授权失败或校验失败也不会被静默绕过。

当前尚未执行 live 同步/重启、RTX 3070 性能与显存验收，以及重启后的真实飞书语音端到端验收。不能把开发版构建或单元测试通过写成现场已可用。

## 架构

```
~/.claude-to-im/
├── config.env             ← 凭据与配置 (chmod 600)
├── data/                  ← 持久化 JSON 存储
│   ├── sessions.json
│   ├── bindings.json
│   ├── permissions.json
│   └── messages/          ← 按会话分文件的消息历史
├── logs/
│   └── bridge.log         ← 自动轮转，密钥脱敏
└── runtime/
    ├── bridge.pid          ← 守护进程 PID 文件
    └── status.json         ← 当前状态
```

### 核心组件

| 组件 | 职责 |
|---|---|
| `src/main.ts` | 守护进程入口，组装依赖注入，启动 bridge |
| `src/config.ts` | 加载/保存 `config.env`，映射为 bridge 设置 |
| `src/store.ts` | JSON 文件 BridgeStore（30 个方法，写穿缓存） |
| `src/llm-provider.ts` | Claude Agent SDK `query()` → SSE 流 |
| `src/codex-provider.ts` | Codex SDK `runStreamed()` → SSE 流 |
| `src/sse-utils.ts` | 共享的 SSE 格式化辅助函数 |
| `src/permission-gateway.ts` | 异步桥接：SDK `canUseTool` ↔ IM 按钮 |
| `src/logger.ts` | 密钥脱敏的文件日志，支持轮转 |
| `scripts/daemon.sh` | 进程管理（start/stop/status/logs） |
| `scripts/doctor.sh` | 诊断检查 |
| `SKILL.md` | Claude Code Skill 定义文件 |

### 权限流程

```
1. Claude 想使用工具（如编辑文件）
2. SDK 调用 canUseTool() → LLMProvider 发射 permission_request SSE 事件
3. Bridge 在 IM 聊天中发送内联按钮：[允许] [拒绝]
4. canUseTool() 阻塞等待用户响应（5 分钟超时）
5. 用户点击允许 → Bridge 解除权限等待
6. SDK 继续执行工具 → 结果流式发回 IM
```

## 故障排查

运行诊断：

```
/claude-to-im doctor
```

检查项目：Node.js 版本、配置文件是否存在及权限、token 有效性（实时 API 调用）、日志目录、PID 文件一致性、最近的错误。

| 问题 | 解决方案 |
|---|---|
| `Bridge 无法启动` | 运行 `doctor`，检查 Node 版本和日志 |
| `收不到消息` | 用 `doctor` 验证 token，检查允许用户配置 |
| `权限超时` | 用户 5 分钟内未响应，工具调用自动拒绝 |
| `PID 文件残留` | 运行 `stop` 再 `start`，脚本会自动清理 |

详见 [references/troubleshooting.md](references/troubleshooting.md)。

## 安全

- 所有凭据存储在 `~/.claude-to-im/config.env`，权限 `chmod 600`
- 日志输出中 token 自动脱敏（基于正则匹配）
- 允许用户/频道/服务器列表限制谁可以与机器人交互
- 守护进程是本地进程，没有入站网络监听
- 详见 [SECURITY.md](SECURITY.md) 了解威胁模型和应急响应

## 开发

```bash
npm install        # 安装依赖
npm run dev        # 开发模式运行
npm run typecheck  # 类型检查
npm test           # 运行测试
npm run build      # 构建打包
```

## 许可

[MIT](LICENSE)
