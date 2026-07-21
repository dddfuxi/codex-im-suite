# Windows PowerShell 5.1 UTF-8 根因防线实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Windows PowerShell 5.1 向原生程序传递中文 stdin 时默认使用 UTF-8，并在 Agent 规则及文件外发前提供绕过检测与失败关闭。

**Architecture:** suite 用幂等 PowerShell 脚本管理当前用户 `CurrentUserAllHosts` Profile；bootstrap 安装、doctor 运行真实原生 stdin 探针。Runtime Agent Home 固化 `-NoProfile` 规则，新增 ArtifactEncodingInspector Host，在 Bridge 最终发送本地文本或 ZIP 前检查严格 UTF-8、连续问号和受限 ZIP 文本条目。

**Tech Stack:** Windows PowerShell 5.1、PowerShell/.NET UTF8Encoding、TypeScript/Node.js 20、Node test runner、`yauzl`、Bridge Host 注入、UTF-8 Markdown。

---

### Task 1: PowerShell 5.1 Profile 管理与真实探针

**Files:**
- Create: `scripts/windows-powershell-utf8-profile.ps1`
- Create: `scripts/__tests__/windows-powershell-utf8-profile.test.mjs`

- [x] **Step 1: 写失败测试**

测试创建临时 Profile，依次执行 `-Check`、`-Apply`、二次 `-Apply`、`-Remove`。断言初始 Check 失败，Apply 后真实 `powershell.exe 5.1 -> node stdin` 探针输出 `e4b8ade69687e6b58be8af950d0a`，二次 Apply Hash 不变，Remove 保留用户自定义行。

- [x] **Step 2: 运行 RED**

```powershell
node --test scripts/__tests__/windows-powershell-utf8-profile.test.mjs
```

预期：失败，提示脚本不存在。

- [x] **Step 3: 实现 Profile 管理脚本**

脚本参数：

```powershell
param(
  [ValidateSet('Apply','Check','Remove')][string]$Mode = 'Check',
  [string]$ProfilePath = '',
  [string]$PowerShellPath = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
)
```

实现稳定标记 `BEGIN/END codex-im-suite PowerShell UTF-8`，使用 `[IO.File]::WriteAllText(..., [Text.UTF8Encoding]::new($false))` 写入；Apply 前备份；Probe 用 Unicode 环境变量携带“中文测试”，由目标 Profile 设置 `$OutputEncoding` 后管道给 Node 输出十六进制。Apply 后 Probe 失败必须恢复 before-image。

- [x] **Step 4: 运行 GREEN**

```powershell
node --test scripts/__tests__/windows-powershell-utf8-profile.test.mjs
```

预期：全部通过。

### Task 2: bootstrap 与 doctor 接入

**Files:**
- Modify: `scripts/bootstrap-suite.ps1`
- Modify: `scripts/doctor-suite-targets.ps1`
- Modify: `scripts/__tests__/windows-powershell-utf8-profile.test.mjs`

- [x] **Step 1: 扩展失败测试**

断言 bootstrap 调用 Profile 脚本 `-Mode Apply`，doctor 调用 `-Mode Check`，且路径由 `$PSScriptRoot` 推导，不包含固定用户名。

- [x] **Step 2: 运行 RED**

预期：bootstrap/doctor 断言失败。

- [x] **Step 3: 最小实现**

bootstrap 在依赖安装前执行 Apply；doctor 把 Check 结果加入 `Key file checks`，失败只显示 `powershell-utf8=failed` 和修复命令，不中断其他诊断。

- [x] **Step 4: 运行 GREEN**

运行 Profile 测试并确认通过。

### Task 3: Agent Home 全局 `-NoProfile` 规则

**Files:**
- Modify: `packages/bridge-runtime/src/agent-home.ts`
- Modify: `packages/bridge-runtime/src/__tests__/agent-home.test.ts`

- [x] **Step 1: 写失败测试**

创建旧 v4 `工具与环境.md`，运行 `ensureAgentHome()` 后断言保留用户正文，并出现：PowerShell 5.1 `$OutputEncoding`、`-NoProfile` 内联设置、优先直接 apply_patch/UTF-8 文件/base64、外发前回读检查。

- [x] **Step 2: 运行 RED**

```powershell
npm --workspace packages/bridge-runtime test -- --test-name-pattern="PowerShell 5.1 UTF-8"
```

预期：规则不存在。

- [x] **Step 3: 更新模板与 legacy migration**

把工具模板升级到 v5；只在模板受控内容未被用户改写时升级，保留用户自定义 Agent Home 文本。

- [x] **Step 4: 运行 GREEN**

运行 Agent Home 专项测试。

### Task 4: 产物编码检查 Host

**Files:**
- Create: `packages/bridge-runtime/src/artifact-encoding-inspector.ts`
- Create: `packages/bridge-runtime/src/__tests__/artifact-encoding-inspector.test.ts`
- Modify: `packages/bridge-runtime/package.json`
- Modify: `package-lock.json`
- Modify: `packages/bridge-core/src/lib/bridge/host.ts`
- Modify: `packages/bridge-core/src/lib/bridge/context.ts`
- Modify: `packages/bridge-runtime/src/main.ts`

- [x] **Step 1: 写失败测试**

测试严格 UTF-8、`U+FFFD`、连续 `???`、正常 PowerShell 正则 `(?:\.0+)?`、URL 查询参数、正常 UTF-8 Markdown、包含损坏 Markdown 的 ZIP、正常文本+二进制 ZIP、超过条目/大小限制和路径穿越名称。

- [x] **Step 2: 运行 RED**

预期：模块不存在。

- [x] **Step 3: 实现 Inspector**

定义：

```ts
export interface ArtifactEncodingIssue {
  filePath: string;
  entryName?: string;
  kind: 'invalid_utf8' | 'replacement_character' | 'question_mark_loss' | 'unsafe_zip_entry' | 'zip_limit';
  sample: string;
}

export interface ArtifactEncodingInspectorHost {
  inspectFiles(input: { files: string[] }): Promise<{ ok: boolean; issues: ArtifactEncodingIssue[] }>;
}
```

白名单文本扩展：`.md/.txt/.json/.jsonl/.yaml/.yml/.ps1/.py/.js/.mjs/.ts/.tsx/.cs`。直接文件限制 2 MiB；ZIP 使用 `yauzl` lazy entries，最多 256 条、单文本 2 MiB、总解压 20 MiB，不落盘。连续三个以上 ASCII `?` 判为丢失；允许单个/双问号和常见正则量词。

- [x] **Step 4: Runtime 注入 Host**

在 `main.ts` 初始化 Inspector，并通过 `initBridgeContext` 注入 `artifactEncoding`；Core 仅依赖 Host 接口。

- [x] **Step 5: 运行 GREEN**

运行 Runtime Inspector 专项、typecheck。

### Task 5: Bridge 外发失败关闭

**Files:**
- Modify: `packages/bridge-core/src/lib/bridge/bridge-manager.ts`
- Modify: `packages/bridge-core/src/__tests__/unit/bridge-manager.test.ts`

- [x] **Step 1: 写失败测试**

模型返回一个真实存在的损坏 Markdown/ZIP；Host 返回 issue。断言 Bridge 不发送文件，保留正常回答主题，并明确显示“文件编码检查失败、未发送”。Host 返回 ok 时维持原文件交付。

- [x] **Step 2: 运行 RED**

预期：损坏文件仍被发送。

- [x] **Step 3: 实现 Delivery 门禁**

在 `prepareBridgeReplyPayload`、文件存在性验证之后，最终 answer review 之前调用 `artifactEncoding.inspectFiles()`；异常或 issue 均失败关闭，清空 `images/files`，不泄露绝对路径，只显示文件名、entry 和 issue kind。

- [x] **Step 4: 运行 GREEN**

运行 Bridge manager 专项与 Core 全量。

### Task 6: 文档、安装与现场验证

**Files:**
- Modify: `AGENTS.md`
- Modify: `docs/PROJECT-ARCHITECTURE.md`
- Modify: `docs/DEVELOPMENT-LOG.md`
- Modify: `README.md`（仅在新增用户命令需要展示时）

- [x] **Step 1: 同步人类文档**

记录 Profile 管理入口、`-NoProfile` 边界、ArtifactEncodingInspector Host 和外发失败关闭。

- [x] **Step 2: 跑完整门禁**

```powershell
npm run test:core
npm run test:runtime
npm run test:boundaries
npm run check:boundaries
npm run check:human-docs
powershell -ExecutionPolicy Bypass -File .\scripts\update-architecture-docs.ps1
```

- [x] **Step 3: 应用本机 Profile**

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\windows-powershell-utf8-profile.ps1 -Mode Apply
powershell -ExecutionPolicy Bypass -File .\scripts\windows-powershell-utf8-profile.ps1 -Mode Check
```

确认真实探针返回 UTF-8，并备份路径存在。

- [x] **Step 4: 同步 live 并重启**

运行 `scripts/sync-live-skill.ps1`，重启 Bridge，核对 status、runtime audit、Feishu WS 和 `lastUnhandledError`。

- [x] **Step 5: 恢复受损 Skill**

从原始 rollout JSONL 的真实 patch 恢复四个中文文件，安全 UTF-8 写入，重新运行 Skill 测试/验证、乱码扫描和 ZIP 回读后再打包。未经用户额外要求，不主动向群发送恢复后的 ZIP。
