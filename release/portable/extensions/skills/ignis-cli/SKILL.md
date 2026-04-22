# Ignis CLI

Use this guide when work should be done through the `ignis` command line, especially for:
- creative generation from terminal or script
- agent-to-agent orchestration through a stable CLI
- reuse of existing assets via `file_id`
- async runs that need polling
- session-based iterative work through a stable command interface

## Core framing

- `ignis` is backed by a very capable multimodal AI agent
- it supports natural-language interaction for creative work, planning, analysis, image understanding, and video understanding
- when another agent uses `ignis`, it should treat it as an A2A interface, not just a thin shell command
- give `ignis` clear natural-language intent, constraints, references, and desired outputs

## Install

Install globally:

```bash
npm install -g ignis-agent-cli
```

Use this exact npm package name:
- `ignis-agent-cli`
- command name after install: `ignis`

Check that the command is available:

```bash
ignis --help
```

Upgrade later:

```bash
npm install -g ignis-agent-cli@latest
```

## Bootstrap

Preferred bootstrap:

```bash
ignis login --config-url <user_config_link>
```

`config_url` rule:
- treat `config_url` as a short-lived bootstrap link
- consume it immediately and save the config locally
- do not forward or reuse it casually

Fallback bootstrap:

```bash
ignis login --base-url https://ignis-cli.funplus-marketing.ai --token <provided_cli_token>
```

On first use, check the local CLI config first:

```bash
cat ~/.ignis/config.json
```

If config is missing, incomplete, or clearly points to the wrong environment, ask the user to provide either:
- a short-lived `config_url`
- or a CLI token that should be used with `https://ignis-cli.funplus-marketing.ai`

## Windows note

- Windows support is not yet formally verified
- for Windows users, prefer downloading the config JSON first and placing it manually in `%USERPROFILE%\\.ignis\\config.json`
- after that, run `ignis --help` and a simple command like `ignis skills` to confirm the environment works

## What Ignis is good at

`ignis` is best for business-facing creative workflows where the caller wants a predictable terminal interface.

Important capability:
- `ignis` has strong search, asset search, image understanding, and video understanding capabilities
- it can work from the current session context, uploaded assets, `file_id`s, external links, and browsable materials

Typical use cases:
- ask for ideas, titles, scripts, briefs, prompts, storyboard directions
- generate images or videos from a short creative brief
- continue a session and iterate on prior output
- upload local references and convert them into reusable `file_id`s
- inspect history, current results, and available skills
- automate multi-step creative jobs from another agent or script

## Capability map

Use this CLI for these concrete jobs:
- start a new creative conversation
- continue an existing conversation by session
- branch into a new session for a new theme or experiment
- submit image/video/copy/plan/storyboard requests
- submit slow jobs asynchronously and poll for the result later
- upload local files and convert them into reusable `file_id`s
- reuse prior assets by `file_id`
- inspect the latest result for a turn or session
- wait for a running turn to finish
- inspect session history
- resume an interrupted turn
- cancel a running turn
- list/search available skills before guiding `ignis` with natural language

In short, `ignis` can handle:
- generation
- continuation
- inspection
- asset reuse
- async orchestration
- skill discovery

## Skills

`ignis` also has its own internal skills system:
- `ignis skills` lists all visible skills by default
- `ignis skills --query <text>` narrows the list by keyword
- skills are triggered through natural-language requests, including inline `$skillname` tokens
- use the skill list to discover what capabilities exist, then trigger the right one in the prompt

Typical usage:

```bash
ignis skills
ignis skills --query storyboard
ignis ask "$storyboard-prompts 给我 3 个分镜方向"
ignis ask "帮我做 3 个分镜方向，偏短视频口播结构"
```

## Core mental model

There are four objects you should keep straight:
- `session_id`
  The conversation container. Reuse this when you want continuity.
- `turn_id`
  One execution attempt inside a session.
- `file_id`
  The canonical asset handle. Prefer this over raw URLs inside CLI flows.
- `canvas_id`
  The web canvas bound to the session. One session maps to one canvas.

Recommended mental model:

```text
ignis upload -> file_id
ignis ask    -> session_id + turn_id
ignis result -> current turn snapshot
ignis wait   -> wait for terminal result
ignis history -> session history
```

Canvas rule:
- one `session_id` is bound to one `canvas_id`
- the canvas is the stable web surface for browsing that session's outputs
- if you know the `canvas_id`, the user can open it directly in the browser

Canvas URL pattern:

```text
https://ignis.funplus-marketing.ai/canvas/<canvas_id>
```

## Session behavior

Ignis is stateless per process, but it is not stateless per conversation.

Conversation continuity is maintained by:
- server-side `session_id`
- local cwd -> `session_id` mapping in `~/.ignis/config.json`

Important rules:
- if you run `ignis ask` with no `--session` and no `--new`, it reuses the current directory's saved session
- `ignis ask --session <session_id>` explicitly targets one known session
- `ignis ask --new ...` creates a fresh session and updates the current directory's default session binding
- `ignis history`, `ignis result`, and `ignis wait` with no explicit session/turn will use the current directory's saved session

Practical guidance:
- use the same session when the user says "继续", "延续", "改一下", "保留上一版风格"
- use `--new` when the user explicitly wants a clean branch, a new topic, or a separate experiment
- use `--session <session_id>` when you must return to an older session without changing your intent
- remember that continuing the same session also means continuing the same web canvas

Testing warning:
- `--new` does not delete the old session
- but it does change the current directory's default session pointer
- if you are only testing, be careful not to accidentally switch the user's default working session

## Conversation management

Treat session management as part of the job.

Use these rules:
- one topic / one thread of iteration / one active line of thought -> one `session`
- a materially different direction -> new session
- a refinement of the same direction -> same session
- parallel work -> separate sessions

Recommended strategy:
- if the user wants several variations of the same idea, first try to batch them into one turn
- if the user wants truly separate directions, create separate sessions
- if you are juggling multiple long-running jobs, keep track of the `session_id` and `turn_id` for each one explicitly

Good patterns:

```bash
ignis ask "同一主题给我 4 张不同构图的图"
ignis ask --new "方向 A：可爱治愈风"
ignis ask --new "方向 B：电影感史诗风"
ignis ask --session <session_A> "继续第一条"
ignis ask --session <session_B> "继续第二条"
```

Practical advice for agents:
- do not spray many small asks into one session when one batched ask would do
- do not assume the cwd default session is always the one you want
- when handling multiple conversations, prefer explicit `--session <session_id>`
- when testing, avoid accidentally stealing the current directory's default session unless that is intentional

Multi-window workflow is valid:
- window A can continue `session_A`
- window B can continue `session_B`
- this is the correct way to parallelize conversations, because one session itself is single-flight

## How to think before you ask

When you generate through `ignis`, ask in business terms, not low-level tool terms.

Good prompt ingredients:
- business goal: what outcome should the asset achieve
- audience: who it is for
- format: image, video, copy, plan, storyboard, etc.
- tone/style: cute, premium, dramatic, realistic, meme, platform-native
- constraints: duration, quantity, platform, aspect ratio, must-keep elements
- references: pass `file_id`s when continuity matters

Good examples:

```bash
ignis ask "基于上一轮那张胖猫主视觉，给我 3 个封面方向，目标是提高点击率，风格夸张、年轻、女性向"
ignis ask "基于这张图，出 2 个 5 秒短视频方向，突出胖猫的治愈感"
ignis ask "延续上一轮风格，但把主题改成春季上新，保留可爱和高饱和"
```

Weak prompts:
- "来一个"
- "帮我搞一下"
- "随便做点图"

## Command workflow

### 1. Start or continue work

Use `ask` for the main action.

```bash
ignis ask "帮我写 5 个标题"
ignis ask "延续上一轮，把第 2 个展开成脚本"
ignis ask --new "开一个新主题，做宠物品牌广告方向"
ignis ask --session <session_id> "继续这条会话"
```

Guidance:
- no flag: reuse the current directory's session
- `--new`: start a new session
- `--session`: explicitly continue a known session

### 2. Async for slow jobs

Treat asset creation as async-first by default.

This especially applies to:
- image generation
- video generation
- any job expected to produce new files or media outputs

Reason:
- asset creation can easily take minutes
- async avoids request timeout and long blocking waits
- async also makes it easier to manage retries, polling, and parallel sessions

Typical time expectation:
- images usually take about 1-2 minutes
- videos usually take about 5-10 minutes

Default rule:
- creating assets -> prefer `--async`
- image generation -> usually use `--async`
- video generation -> strongly prefer `--async`
- if you expect review, batching, or multiple assets -> use `--async`

```bash
ignis ask --async "基于这只猫再来 2 张图"
ignis result <turn_id>
ignis wait <turn_id>
```

Use:
- `result` to fetch the current snapshot
- `wait` to block until terminal status

Recommended pattern:
1. submit with `--async`
2. store `turn_id` and `session_id`
3. use `ignis result <turn_id>` to inspect progress or the latest snapshot
4. use `ignis wait <turn_id>` when you actually need the final output before taking the next step

Interaction rule:
- if you choose async, proactively ask the user whether they want you to keep polling and wait for completion
- do not assume they want you to block unless they say so

Do not keep the agent blocked on a long asset-generation run unless the next action truly depends on completion.

### 3. History and inspection

```bash
ignis history
ignis history --session <session_id>
ignis result
ignis result <turn_id>
ignis wait
ignis wait --session <session_id>
```

Use:
- `history` for the session narrative
- `result` for the latest state of a turn
- `wait` when you need the final answer before proceeding

### 4. Discover available skills

Use `skills` to list all available skills, then narrow or trigger as needed.

```bash
ignis skills
ignis skills --query video
ignis skills --json
```

Use:
- `ignis skills` to list all available skills
- `ignis skills --query <text>` to narrow by topic or workflow
- `ignis skills --json` when another agent or script needs structured output

How skills are used:
- `ignis skills` is for discovery and inspection
- once you know the right skill, trigger it in the user message with `$skillname`
- plain natural-language requests can also activate the right skill when the intent is clear

Typical follow-up flow:

```bash
ignis skills --query storyboard
ignis ask "$storyboard-prompts 给我 3 个分镜方向"
ignis ask "帮我做 3 个分镜方向，偏短视频口播结构"
```

### 5. Interrupts

If a turn asks a follow-up question, you can resume it:

```bash
ignis resume <turn_id> --answer "选第 2 个"
```

Current CLI behavior is also compatible with direct continuation:
- if a session has a pending interrupt and you send a new `ask`
- the pending interrupt is auto-cancelled
- the new user message continues execution

Use explicit `resume` when the question really needs a structured answer.

### 6. Concurrency rule

One session is single-flight.

That means:
- one session can only process one active turn at a time
- if the same session is already running, a new `ask` on that same session will be rejected as busy
- if you need true parallel work, use a different session, usually via `--new`

Practical consequence:
- do not submit a second slow image/video job into the same session while the first is still running
- if the user wants several assets from the same direction, prefer one batched ask such as "出 4 张图" or "出 2 个视频方向"
- if the user wants multiple long-running jobs in parallel, split them into separate sessions

## File workflow

### A. Upload local files

Turn a local file into a reusable `file_id`:

```bash
ignis upload ./reference.png
ignis upload ./brief.pdf --json
```

Use this when:
- another agent already knows the local path
- you want a reusable asset handle for later turns
- you want to separate upload from generation

### B. Attach a local file in one step

```bash
ignis ask --attach ./reference.png "基于这张图给我 3 个视频方向"
```

This does:
1. upload local file
2. get back a `file_id`
3. submit the turn with that `file_id`

### C. Reuse an existing file_id

This is the preferred pattern for stable automation.

```bash
ignis ask --file-id abc123.jpg "基于这张图继续做动态版本"
ignis ask --file-id xyz789.mp4 "帮我分析这个视频的风格卖点"
```

Prefer `file_id` over local path whenever the asset already exists in the system.

## file_id and CDN URL

`file_id` is the canonical internal handle.

Examples:
- `abc123.jpg`
- `0zmYTI.mp4`
- `6YAlLx.md`

Inside CLI flows, prefer:
- `--file-id <file_id>`
- response fields like `input.file_ids`
- output fields like `artifact_summary.file_ids`

If you need the public asset URL, combine it like this:

```text
https://cdn-asia.funplus-marketing.ai/ultra/<file_id>
```

Example:

```text
file_id: 0zmYTI.mp4
url: https://cdn-asia.funplus-marketing.ai/ultra/0zmYTI.mp4
```

Rule of thumb:
- use `file_id` for CLI and agent workflows
- use CDN URL for previewing, sharing, or opening the raw asset externally

Main browse domain:
- users browse generated canvases on `https://ignis.funplus-marketing.ai`
- CLI traffic goes to `https://ignis-cli.funplus-marketing.ai`

## What an agent should ask the user

When the request is vague, ask only for the fields that unblock execution:
- what is the business goal
- what output type is needed
- how many variants are needed
- what references must be preserved
- what should stay unchanged from the prior round

Useful clarifying questions:
- "这是要图片、视频、脚本还是选题？"
- "目标人群和平台是什么？"
- "要延续上一轮风格，还是开一个新主题？"
- "有没有必须沿用的 `file_id` 或参考图？"
- "这轮是要最终成品，还是先出 2-3 个方向？"

## What this skill can do

This skill is especially useful for:
- terminal-first creative generation
- programmatic asset pipelines
- batch-friendly human review loops
- session-based iteration on images/videos/copy
- turning local files into system-native `file_id`s

This skill is not ideal for:
- workflows that depend on heavy manual intervention outside the CLI
- free-form exploration where no stable session or artifact tracking is needed

## Operating rules

- Prefer one business goal per turn.
- Prefer `--new` when the user explicitly wants a new theme or a fresh branch.
- Prefer reusing the same `session_id` when the user says "继续", "延续", "改一下", "保留上一版风格".
- Prefer `--async` for asset creation, especially images and videos, to avoid timeout.
- Prefer `file_id` over raw URLs during CLI work.
- If a session is already running, wait for it or switch to a new session; do not assume same-session parallel execution.
- When reporting outputs, surface:
  - `turn_id`
  - `session_id`
  - `canvas_id`
  - `file_id`s for outputs
  - final assistant text
- When useful, also surface the canvas browse URL:
  - `https://ignis.funplus-marketing.ai/canvas/<canvas_id>`

## Minimal command set to remember

```bash
ignis ask "..."
ignis ask --async "..."
ignis ask --file-id <file_id> "..."
ignis upload ./local-file
ignis result <turn_id>
ignis wait <turn_id>
ignis history
ignis resume <turn_id> --answer "..."
```