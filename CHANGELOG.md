# Changelog

## 1.0.0

- Initial release: clickable chat jumps to workspace code via native citation fences.
- Always-on rule `always-cite-workspace-code` so existing code is cited as `startLine:endLine:filepath`.
- Skill `resolve-code-jump` and command `/jump-to-code` for path-less or paraphrased snippets.
- MCP server `plugin-chat-jump-links-jump` with tool `resolve_code_jump` (ripgrep literal match, ranked, citation-ready).
