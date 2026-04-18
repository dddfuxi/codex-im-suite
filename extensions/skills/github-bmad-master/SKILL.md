---
skill_id: github-bmad-master
name: GitHub BMAD Master
description: Core BMAD workflow orchestrator adapted from the GitHub project aj-geddes/claude-code-bmad-skills. Use when the user wants structured workflow routing, project initialization, or phased task planning.
source_repo: https://github.com/aj-geddes/claude-code-bmad-skills
---

# GitHub BMAD Master

This is the lightweight BMAD orchestrator only. It does not pull the full BMAD
agent stack into the current workflow.

Use it when the user needs:

- workflow initialization
- project phase/status checks
- structured task decomposition
- a concrete next-step recommendation for a project workflow

## Commands / Intents

Treat these as core triggers:

- `/workflow-status`
- `/status`
- `/workflow-init`
- `/init`
- "use BMAD to structure this task"
- "check workflow status"
- "initialize this project's workflow"

## Responsibilities

1. Initialize lightweight BMAD project structure
2. Route the user to the appropriate next workflow step
3. Track progress through phases
4. Keep recommendations focused and actionable
5. Avoid dragging in heavy methodology overhead when the task is small

## BMAD Overview

Phases:

1. Analysis
2. Planning
3. Solutioning
4. Implementation

Project levels:

- Level 0: single atomic change
- Level 1: small feature
- Level 2: medium feature set
- Level 3: complex integration
- Level 4: enterprise-scale work

## Operating Rules

- Keep responses concise
- Prefer actionable next steps over long methodology explanations
- If the project is not initialized, say so and offer initialization
- If the user only wants a quick workflow view, do not over-engineer the output
- Treat BMAD as an orchestration aid, not as a requirement for every task

## /workflow-status

Purpose:

- Show current workflow state
- Recommend the next concrete step

Steps:

1. Check whether BMAD config/status files exist in the current project
2. If missing, explain BMAD is not initialized
3. If present, summarize:
   - project name
   - project type
   - project level
   - current phase
   - next recommended workflow

## /workflow-init

Purpose:

- Create the minimal BMAD project structure for the current project

Create:

```text
bmad/
  config.yaml
  agent-overrides/

docs/
  bmm-workflow-status.yaml
  stories/
```

Then collect:

- project name
- project type
- project level

And write:

- `bmad/config.yaml`
- `docs/bmm-workflow-status.yaml`

## Boundaries

This skill should not:

- force the user into the full BMAD agent suite
- replace normal direct execution when the user already knows what to do
- bloat small tasks with unnecessary process

It is a project workflow organizer, not a universal planning system.
