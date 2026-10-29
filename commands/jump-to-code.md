---
name: jump-to-code
description: Find the most likely workspace location for a code snippet from chat and emit a clickable citation jump.
---

# Jump to code

Load and follow the **resolve-code-jump** skill.

## User input

A pasted snippet, a quoted identifier, or “the last code block.” Optional path or language hint.

## Steps

1. Take the snippet from this message (or the latest uncited code block in the thread).
2. Call `resolve_code_jump` with that snippet and this session’s absolute `workspace_roots`.
3. Reply with the citation fence so the user can click to jump and highlight. Include `Jump to code: <path>:<start>-<end>` above the fence.
