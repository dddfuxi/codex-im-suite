---
name: jev-decision
description: Use the suite's provider-neutral decision mode for explicit yes/no judgments, finite classifications, and bounded score questions. Use when a user asks to judge, classify, rank, score, or compare a small set of concrete alternatives and wants the decision probabilities shown. This Skill does not call OpenRouter, send Feishu messages, execute tools, or authorize actions; the Runtime DecisionProvider and Bridge policy own those boundaries.
---

# Jev Decision

Use this Skill to organize a question for the suite Decision Layer. The active
provider may be Jev today and another provider later, so never write a prompt
that assumes a specific HTTP endpoint or model response format.

## Supported question forms

- `noul`: a clear yes/no question with evidence and a defined meaning of yes.
- `choice`: a finite classification with concrete, mutually understandable
  labels. Keep the set small and do not invent labels that are not supported by
  the supplied state.
- `score`: a bounded rating with a stated scale and what each end means.

Ask only questions that can be answered from the supplied state. Keep the state
short, factual, and free of credentials, absolute paths, platform IDs, callback
data, commands, or tool instructions. Add stable evidence references when the
caller provides them.

## Invocation and fallback

An explicit user request such as “用判断模式分析” may enter Decision mode.
Automatic entry is allowed only after the Bridge's deterministic intent and
permission gates identify a real judgment, classification, or score request.
Do not turn ordinary words such as“看看”“检查”or“选一个”into a Decision
request by themselves.

When the DecisionProvider is disabled, unavailable, timed out, or returns an
invalid result, continue through the existing Primary path. Do not fabricate a
decision, probability, provider name, or completion claim.

## Visible result

The Bridge owns the final channel presentation. A read-only DecisionView may
show the current `noul` yes/no probability, `choice` category distribution, or
`score` value and distribution. These are model evidence, not clickable user
choices: never emit callback data, Card JSON, URLs, commands, user IDs, chat IDs,
or action parameters in the Skill output.

Keep a useful ordinary text fallback. Feishu may render a compact Card 2.0
view; other channels may use Markdown. A Decision result never replaces the
existing permission, Owner confirmation, tool-evidence, or delivery gates.
