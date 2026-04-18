---
name: github-memory-protocol
description: Codex-compatible local markdown memory protocol adapted from the GitHub project hanfang/claude-memory-skill. Use when the user asks to remember, recall, preserve preferences, or retrieve durable project constraints from local memory files.
source_repo: https://github.com/hanfang/claude-memory-skill
---

# GitHub Memory Protocol

This skill adapts the idea from `hanfang/claude-memory-skill` for Codex.

It does not use a database or embeddings. It keeps durable memory in plain
markdown files that are readable, editable, and easy to inspect.

## Memory Layout

Use this directory:

```text
C:\Users\admin\.codex\memory\
├── core.md
├── me.md
├── topics\
│   └── <topic>.md
└── projects\
    └── <project>.md
```

Meaning:

- `me.md`: durable user preferences and stable habits
- `core.md`: top-level summaries and pointers
- `topics/*.md`: topic-specific detailed memory
- `projects/*.md`: project-specific memory

## When To Use

Use this skill when:

- the user explicitly says "remember", "save this", or "do not forget"
- the user asks "do you remember", "what did we decide", or similar
- the current task clearly depends on stable preferences, naming rules,
  project constraints, or long-term operating rules
- repeated conclusions should be saved for reuse

Do not save random small talk.

## Read Policy

Keep reads minimal:

1. Read `me.md`
2. Read `core.md`
3. Open only the relevant `topics/*.md` or `projects/*.md`

Do not load the entire memory directory into context.

## Write Policy

Only save:

1. Stable preferences
- language preference
- default project/workspace rules
- document naming rules
- screenshot rules
- authority and permission boundaries

2. Reusable conclusions
- fixed project workflows
- recurring error-handling knowledge
- repository constraints
- skill trigger rules

Do not save:

- temporary emotions
- one-off greetings
- obviously expired transient state
- facts that can be trivially re-derived from code or config

## Entry Format

Topic files should use this format:

```markdown
## <Short title> [YYYY-MM-DD]
<The fact or constraint in 1-3 sentences>
```

If an entry becomes a long-term repeated rule, also summarize it in `core.md`:

```markdown
## <Topic>
<One-line summary>
-> topics/<topic>.md
```

## Suggested Topics

Common topics:

- `preferences`
- `workflow`
- `bridge`
- `unity-st3`
- `documents`
- `naming`
- `debugging`

Project-specific knowledge should go to `projects/<project>.md` first.

## Editing Rules

- Prefer appending over rewriting the whole file
- If updating an existing record, change only the relevant block
- Prefer ASCII
- Create the topic file if it does not exist
- Merge duplicate knowledge instead of appending near-identical entries

## Practical Use

When the user asks to remember something:

1. Decide whether it is durable knowledge or transient state
2. Choose `topics/*.md` or `projects/*.md`
3. Append the entry
4. Update `core.md` if needed
5. Reply briefly with what was saved

When the user asks to recall something:

1. Read `core.md`
2. Open only the relevant topics
3. Return only the fragments relevant to the current task
4. Do not dump unrelated old memory

## Boundaries

This skill is the local markdown memory layer. It does not replace:

- remote Feishu chat history
- repository retrieval or indexed history tools
- the project source code itself

Correct division of responsibility:

- remote chat history: raw conversation source
- local memory: durable rules and reusable conclusions
- retrieval skills: fetch only the relevant fragments

## Example User Triggers

- "Remember this rule."
- "Save this preference."
- "Use this naming rule next time."
- "Do you remember the ST3 screenshot rule?"
- "Check local memory for this constraint."

## Reply Style

Reply with the conclusion only, for example:

- "Saved: ST3 stays the default project unless you explicitly authorize another one."
- "Found it: document titles should use content titles, not generic chat-summary titles."

Do not expose the whole memory read/write process to the user.
