---
name: food-ordering-advisor
description: Provide conversational restaurant discovery, meal recommendations, cross-platform comparison, menu selection, cart preparation, and guarded order handoff using current evidence from 美团、Meituan、美团外卖、大众点评、Dianping or other local-life providers. Use when a user asks 吃什么、附近有什么好吃的、外卖推荐、餐厅推荐、探店、点评比较、帮我点餐、选店、选菜、凑单、多人聚餐 or wants to prepare an order through chat. Require real source evidence for current merchants, prices, ratings, availability, delivery estimates, discounts, carts, and order results; never pretend that a Skill alone is a live platform API.
---

# Food Ordering Advisor

## Goal

Guide the user from an open-ended meal question to a small, explainable shortlist and, when a verified platform session is available, to a reviewed cart. Keep recommendation logic independent from any single platform so Meituan, Dianping, official partner APIs, browser/app automation, and future providers can share one workflow.

## Choose the Mode

Classify the request before acting:

- `advice`: recommend cuisines, dishes, or meal combinations without claiming current platform data.
- `discovery`: find current nearby merchants from verified sources.
- `comparison`: compare named merchants or results across platforms.
- `order_draft`: inspect a menu and prepare a cart without submitting it.
- `order_submit`: submit only after a fresh checkout summary and explicit authorization.

Do not turn a recommendation request into an order. Do not treat “就这个”“可以” or a candidate-selection button as authorization to spend money.

## Run the Conversation

1. Reuse facts already supplied in the current conversation. Do not ask for them again.
2. Ask only for the missing facts that materially change the result. Prefer one compact question containing at most three items.
3. For live discovery, require at least an approximate location or a user-authorized platform location. Never guess the city, delivery address, or current position.
4. Prioritize these inputs:
   - dining mode: delivery, pickup, or dine-in;
   - people and budget, stating whether the budget includes delivery;
   - taste, cuisine, allergies, dietary restrictions, and hard dislikes;
   - maximum distance or delivery time;
   - meal time and any occasion constraints.
5. Treat allergies and religious/medical dietary restrictions as hard constraints. Mark cross-contamination uncertainty instead of declaring a dish safe without evidence.
6. Keep optional preferences soft. If the user says “随便”“你看着办”, choose reasonable defaults and state them briefly rather than asking a long questionnaire.

Use ordinary single-user structured choices for a small set of cuisines or shortlisted merchants when supported. Never use group vote/claim/parallel choices, ordinary buttons, emoji reactions, or another participant's message as purchase authorization.

## Acquire Current Evidence

Inspect available tools before claiming access to a platform. Follow this source order:

1. Configured official or authorized partner API.
2. User-authorized, already logged-in browser or mobile-app session on the intended platform.
3. Current web search limited to official Meituan/Dianping domains for read-only discovery.
4. User-provided platform link, screenshot, menu, or cart screenshot.
5. General culinary knowledge, clearly labeled as non-live advice.

Read [references/platform-evidence.md](references/platform-evidence.md) before live discovery, cross-platform comparison, browser/app operation, or order preparation.

Treat interactive browser access as an optional per-turn evidence source, not as an installed Meituan/Dianping API. Before using it, verify that the current runtime actually exposes a controllable browser, that the browser target matches the platform and account scope authorized by the user, and that the required values are visibly unmasked on the current page. Do not enable or inherit an entire desktop plugin set merely to satisfy this Skill.

For promotions and group-buying deals, `商家团购套餐`, `商户优惠`, `￥**`, `打开App查看`, a QR code, or an app deep link proves at most that the page advertises a promotion entry. It does not verify the package name, sale price, validity window, purchase rules, inventory, or eligibility. A browser verification challenge succeeding does not upgrade app-only fields into browser evidence.

Do not reverse-engineer private APIs, import cookies, ask the user to paste credentials, bypass CAPTCHA or anti-bot controls, or scrape at scale. If the available source cannot verify current availability, price, discount, delivery time, or rating, omit that field or label it unknown.

## Build the Shortlist

Return 2-4 candidates, normally 3. For each candidate include:

- platform and exact merchant name;
- why it matches the user's stated constraints;
- directly observed price range or estimated meal total, with its basis;
- directly observed distance/delivery estimate when available;
- one useful tradeoff or uncertainty;
- evidence time and source type.

Do not compare Meituan and Dianping scores as if they used the same scale. Only merge two listings as the same physical merchant when the normalized name plus address or another strong identifier agrees. Keep chain branches separate.

Rank by fit to the user's constraints, not by whichever platform appears first. Explain the top choice in one or two sentences; do not manufacture a numeric ranking formula.

## Prepare the Cart

After the user selects a merchant:

1. Re-read the current menu from the same verified platform session or source.
2. Propose concrete items, quantities, required variants, add-ons, and notes.
3. Check minimum order, packaging, delivery fee, estimated arrival, sold-out state, and obvious duplicate portions when visible.
4. Keep optional substitutions explicit. Never silently replace an item.
5. Recalculate the expected total from current visible values. Distinguish item subtotal, packaging, delivery, service fees, discounts, and final payable amount when the platform exposes them.
6. Stop at a draft if any required option, quantity, address scope, allergen concern, or material price is unresolved.

## Guard Order Submission

Treat order submission as a financial side effect.

1. Move from a group chat to the user's private conversation before displaying an address, phone fragment, coupon ownership, or account-specific cart.
2. Present a fresh checkout summary containing platform, merchant, items, quantities/options, remarks, price breakdown, masked address, expected time, discount choice, and substitution policy.
3. Ask the same authenticated user to type an explicit confirmation such as `确认提交订单`. Do not accept vague assent, a group vote, a generic choice callback, an old confirmation, or a confirmation made before the latest material change.
4. If merchant, items, quantity, options, payable amount, address, delivery time, coupon, or remarks change after confirmation, present the updated summary and confirm again.
5. Submit only through a tool that exposes a real authorized platform session and reports a success receipt. Otherwise stop at the reviewed cart and explain the handoff.
6. Hand control to the user for login, CAPTCHA, two-factor authentication, payment password, biometric approval, or any platform takeover prompt.
7. Report success only from a real platform receipt or visible order state. Include the platform status and a masked order identifier when available. Never infer success from a click alone.

Never store or repeat full delivery addresses, phone numbers, credentials, cookies, tokens, payment details, or identity documents. Persist food preferences only when the user explicitly asks to remember them, using the suite's normal memory boundary rather than a private Skill store.

## Degrade Gracefully

When live platform access is unavailable:

- Continue `advice` mode using the user's constraints.
- Provide platform-specific search phrases and filters, for example cuisine + area + budget + dining mode.
- Ask the user to send one Meituan/Dianping link or a current search/menu screenshot if they want evidence-based comparison.
- State exactly what remains unverified. Never output invented merchants, ratings, prices, coupons, delivery times, or order results.

Use this concise fallback:

```text
我可以先完成口味和预算推荐，但当前没有拿到美团/大众点评的实时页面或授权接口。
未验证：商家是否营业、当前价格、配送时间和优惠。
你可以发一个平台链接/截图，或授权可控浏览器后我继续比选。
```

## Output Shape

Lead with the recommendation or current blocking fact. Keep the answer conversational.

For a shortlist, use:

```text
首选：<商家> — <匹配原因>

1. <平台｜商家>
   - 适合：<约束匹配>
   - 当前信息：<价格/距离/配送，缺失则不写>
   - 注意：<权衡或未知>
   - 证据：<来源类型，查询时间>

下一步：选一家看菜单，或告诉我想调整的条件。
```

For a cart, show the itemized draft first, then the explicit confirmation boundary. Do not bury fees, uncertainties, or the need for user takeover in prose.
