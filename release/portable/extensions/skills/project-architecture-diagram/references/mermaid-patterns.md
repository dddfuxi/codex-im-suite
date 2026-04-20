# Mermaid Patterns

Use small diagrams that answer one architectural question at a time.

## System Context

```mermaid
flowchart TD
  User[User] --> App[Application]
  App --> LocalStore[(Local Store)]
  App --> External[External Service]
```

Use for project boundaries, external dependencies, and top-level responsibilities.

## Module Relationship

```mermaid
flowchart TD
  Runtime[Runtime Shell] --> Core[Bridge Core]
  Runtime --> Providers[Execution Providers]
  Runtime --> Mcp[MCP Bridge]
  Core --> Adapters[Channel Adapters]
```

Use for package/module boundaries and dependency direction.

## Request Flow

```mermaid
sequenceDiagram
  participant User
  participant Adapter
  participant Router
  participant Provider
  participant Sender
  User->>Adapter: message
  Adapter->>Router: inbound message
  Router->>Provider: execute
  Provider-->>Router: final result
  Router->>Sender: send reply
```

Use for runtime event paths and async handoffs.

## Data Flow

```mermaid
flowchart LR
  Inbound[Inbound Message] --> Index[History Index]
  Index --> Recall[Relevant Recall]
  Recall --> Provider[Provider Context]
  Provider --> Reply[Final Reply]
```

Use for memory, cache, persistence, indexing, and context compression.

## Rules

- Split a dense diagram into multiple diagrams instead of adding many crossing edges.
- Label nodes with domain meaning, not class names only.
- Label edges when the transferred data or action is not obvious.
- Avoid documenting implementation details that are likely to change weekly.
