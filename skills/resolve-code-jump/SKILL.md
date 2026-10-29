---
name: resolve-code-jump
description: Resolve paraphrased or path-less chat code to a workspace file/line and emit a clickable citation jump. Use when citing existing code without a verified path, when the user wants to jump/open that code, or for /jump-to-code.
---

# Resolve code jump

## Trigger

- Existing workspace code in the answer, but no verified `filepath` + lines from this turn
- User wants to jump, open, or find code mentioned in chat
- `/jump-to-code`

## Steps

1. Extract a literal snippet (1–8 lines). Strip ellipsis placeholders such as `// ... existing code ...` and `# ...`.
2. Call MCP `resolve_code_jump` on server `plugin-chat-jump-links-jump` with:
   - `snippet` (required)
   - `workspace_roots`: the absolute workspace folder paths from this session
   - optional `hint_path`, `hint_symbol`, `glob`
3. If `unique` is true, or `best.score` is ≥ 0.8: emit the citation using `best.citation_fence_header` and the matched body. Do not invent or rewrite line numbers.
4. Put a short jump line above the fence, for example: `Jump to code: src/app.ts:12-15`
5. If several matches are close: cite `best`, then list other `filepath:startLine` in prose.
6. If no match: say so. Do not fake a citation. Offer `/jump-to-code` with a longer or more unique snippet.

## Do not

- Use Grep as the primary resolver (unranked; often pasted as text instead of a citation).
- Wrap existing-code fences in a language tag.
- Cite brand-new proposed code that is not in the repo.
