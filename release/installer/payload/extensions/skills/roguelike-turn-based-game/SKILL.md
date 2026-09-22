---
name: roguelike-turn-based-game
description: Host a concise interactive roguelike turn-based adventure with persistent stats, fair probability checks, meaningful choices, branching consequences, puzzles, complete endings, illustrated card-hero mode, and trusted group-choice sessions. Use when a user asks to play 肉鸽、回合制、文字冒险、选择游戏、解密冒险、跑一局、开一局冒险, or explicitly asks for 全员投票、全员抢选、多人多线的肉鸽. Keep ordinary requests text-first; use illustrated mode only for 沉浸版肉鸽 or 图文版肉鸽.
---

# Roguelike Turn-Based Game

## Start the Game

1. Use a setting already named by the player and begin immediately.
2. Otherwise offer 3-6 concise styles plus `随机`; treat 随便、都行、不指定 as permission to choose randomly without asking again.
3. Open with a concrete crisis, a compact status panel, and the first decision. Explain rules only when asked.
4. Default to a short complete run of 5 key decisions and track `主线进度 0/5` through `5/5`.

Suggested styles include 中世纪战争、武侠江湖、末日生存、赛博都市、暗黑地牢、星际远征、海盗寻宝、东方志怪. Vary them when useful.

## Participation Mode

- Keep ordinary 肉鸽 single-player. Do not open a group session merely because the game is happening in a group chat.
- When the user explicitly asks for `全员投票`、`大家投票` or an equivalent group vote, include a structured `choice_session` in the same `cti-final` envelope as the 2-4 visible choices:

```json
{"mode":"vote","state":"active","duration_seconds":30}
```

- Use the duration requested by the user. If no duration is given, use 30 seconds. Keep it between 10 and 3600 seconds. Do not simulate a countdown in prose or generate callback fields. The Bridge records one vote per verified member, permits a changed vote by default, closes at the trusted deadline, and sends one aggregate continuation.
- When the user explicitly asks for `全员抢选`、`抢答`、`抢单`、`先到先得` or equivalent first-claim play, include:

```json
{"mode":"claim","state":"active"}
```

- Treat the first Bridge-verified successful continuation as binding. Do not name a winner before the Bridge reports the successful claim.
- When the user explicitly asks for `多人多线`、`每个人各走各的`、`各自选择路线` or equivalent parallel play, include:

```json
{"mode":"parallel","state":"active"}
```

- Resolve each Bridge-verified participant branch independently from its branch evidence. Never infer or expose a platform user ID. Do not merge one participant's inventory, injuries, clues, costs, or outcome into another participant's branch.
- Open `parallel` to all verified members only on the shared entry card. After the Bridge reports an opaque participant branch, continue that branch with `choice_flow` choices but do not reopen its follow-up buttons as a new all-member session. The Bridge preserves the parallel branch semantics and binds each follow-up card to that participant.
- For multi-turn group play, keep `choice_flow: {"mode":"continuous","state":"active"}` while another finite choice is required. Return `choice_flow: {"mode":"continuous","state":"complete"}` when that branch or group decision is finished. Use `choice_session: {"mode":"<current mode>","state":"complete"}` only when the shared group session itself is complete.
- Always use the structured Bridge protocol for group participation. Do not replace it with “大家回复 A/B/C”, markdown pseudo-buttons, model-generated callback data, commands, URLs, chat IDs, user IDs, or custom action parameters.
- Never use group choices for permissions, Owner/high-risk confirmation, credentials, identity resolution, purchases, or destructive actions.

## Presentation Mode

- Treat explicit `沉浸版肉鸽` or `图文版肉鸽` as illustrated mode. Keep ordinary `肉鸽`、`文字肉鸽`、`来一轮肉鸽` text-first.
- Persist the selected presentation and participation modes for the run. Short replies and button callbacks continue those modes without requiring the trigger phrase again.
- In illustrated mode, generate at most one new wide scene image for each visible turn. Depict only revealed facts, preserve recurring appearance, prefer cinematic 16:9 composition, and avoid baked-in UI, option labels, watermarks, and spoilers.
- Use a real exposed image-generation capability. Never invent a path, image key, upload result, or successful generation.
- Declare the same verified local image in `images` and `card_hero.image`; put the narrative, status, choices, group mode, and buttons in that same card. Never supply a URL, callback data, or platform identity as the hero source.
- If generation, upload, or hero embedding fails, keep the game playable and let the delivery layer use its verified ordinary-image fallback. Never reuse an old image as proof of a new turn.

## State and Persistence

- Track 4-6 theme-appropriate stats, for example 生命、士气、粮食、金币、队伍规模 and one run-specific resource.
- Apply every stated cost exactly once, clamp bounded stats, and end honestly if life reaches zero.
- Persist an active run in `.state/<platform-chat-or-session-id>.json` when a stable identifier exists. Store the run seed, participation/presentation modes, hidden puzzle truth, per-participant branch state, discoveries, stats, inventory, progress, and used check nonces.
- Read state before every continuation and update it after every result. Keep hidden solution fields and seeds out of player-facing replies. Archive or delete active state only after the ending or explicit restart.
- In parallel mode, key player-facing branch logic by the Bridge-provided opaque participant branch evidence, never by a guessed display name or platform ID.

## Choices and Resolution

- Keep each turn fast: outcome, updated status, immediate situation, then 2-4 materially different choices.
- Show known costs and broad risk/reward. Reward established preparation and clues; do not retcon after a choice.
- Permit reasonable free-form actions and resolve them through the same state-and-consequence system.
- Use randomness only where uncertainty remains. Do not erase good preparation or force a predetermined plot.
- If a resource is insufficient, disable that route in the narrative or offer a believable alternative.

## Probability Checks

- Run `scripts/probability_check.py` whenever unresolved uncertainty can materially cause injury, resource loss, capture, irreversible failure, or death.
- Choose the base chance first, list only established modifiers, and use one hidden stable run seed plus a unique nonce for each check.
- Example: `python scripts/probability_check.py --base 45 --modifier "完整线索=25" --modifier "重伤=-20" --seed "<run-id>" --nonce "turn-3-lock"`.
- Treat `critical_success`, `success`, `failure`, and `critical_failure` as binding. Never reroll unless an established one-use resource explicitly permits it.
- Show the final success percentage before a consequential gamble and the rolled percentile/result afterward. Do not reveal seeds, future branches, or hidden reasoning.

## Puzzle and Investigation Play

- Fix the hidden solution, culprit, mechanism, or sequence before presenting the first clue and keep it stable.
- Judge free-form answers against established truth and available evidence. Do not reshape the mystery to validate the latest guess.
- Separate deduction from execution: correct deduction can reduce/remove a roll; a risky wrong answer can trigger stated consequences.

## Tone and Output

- Keep narration vivid but concise, usually 1-3 short paragraphs. Start resolution turns with the outcome.
- Show a stable compact status panel after each action.
- Label choices `A｜`, `B｜`, `C｜`, optionally `D｜`; also emit the same 2-4 items as structured `choices` when interactive choices are supported.
- Include only visible `label` and optional `description` in each choice. Never include callback/action/platform fields.

Use this shape:

```text
[Outcome-first consequence]

**主线进度：N/5｜当前阶段**
❤️ 生命 X/10｜🔥 士气 X/10｜[resource panels]

[Immediate situation]

**A｜行动名**：成本/风险｜预期方向
**B｜行动名**：成本/风险｜预期方向
**C｜行动名**：成本/风险｜预期方向
```

## Ending

- Resolve the main objective at `5/5`; do not add another mandatory choice.
- Give a consequence-specific ending title, final stats, and 2-4 decisive prior effects.
- Offer `再来一局`、`同风格新地图` or `换风格` without auto-starting.
- In group mode, summarize the actual aggregate result or separated participant outcomes supplied by the Bridge; never fabricate missing participants or votes.

## Guardrails

- Do not make every option succeed or punish players using unknowable information unless it was marked as a gamble.
- Do not expose hidden calculations, future branch trees, platform identities, or internal protocol fields.
- Keep the game playable through short replies, real buttons, or reasonable free-form actions.
- Never protect a player from a fair lethal outcome.
