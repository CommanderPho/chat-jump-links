# Chat Jump Links

One-click navigation from code mentioned in a Cursor chat to the matching workspace location. Clicking the citation control jumps to that file and highlights the range.

Cursor cannot inject a custom React button into chat. The jump control is Cursor’s native **code reference fence**. This plugin makes the agent emit that fence, and resolves a file/line in the background when the model omits a path.

## Install

The plugin lives at `~/.cursor/plugins/local/chat-jump-links/` and is available after you enable it in Cursor plugin settings.

1. Enable **Chat Jump Links**.
2. Approve the MCP server `plugin-chat-jump-links-jump` the first time it runs.
3. Restart the chat (or reload the window) if the always-on citation rule does not appear.

Requires **Node.js** on `PATH` (the MCP server is `node mcp-server/index.js`). [ripgrep](https://github.com/BurntSushi/ripgrep) is recommended and is already bundled with Cursor; the server falls back to a slower file walk if `rg` is missing.

## What you click

Existing workspace code is shown as a **code reference**, not a language-tagged fence:

````markdown
```41:43:src/video.py
def parse_video_folder(cls, folder_path: Path, video_extensions: List[str] = ['.mp4', '.avi']) -> pd.DataFrame:
    ...
```
````

That header (`startLine:endLine:filepath`) is the jump-and-highlight control. New code that is not in the repo still uses a normal language fence (` ```python `).

## Background resolve

When the agent does not already have a verified path and line range from `Read` / `Grep` this turn, it calls MCP `resolve_code_jump` with a literal snippet. The tool searches relevant files, ranks matches, and returns a citation header the agent must paste unchanged.

You do not run a search yourself. The tool call happens in the same turn, then the answer already contains a clickable jump.

## Command

```
/jump-to-code
```

Paste a snippet, a quoted identifier, or say “the last code block.” Optional path or language hint. The agent resolves it and replies with a citation fence.

## Components

| Component | Role |
|-----------|------|
| Rule `always-cite-workspace-code` | Always emit clickable citations for existing workspace code |
| Skill `resolve-code-jump` | Extract snippet → `resolve_code_jump` → paste `best` fence |
| Command `/jump-to-code` | User-triggered resolve |
| MCP `resolve_code_jump` | Ranked literal search; returns citation-ready headers |

## Limitations

- No custom chat-chrome button; the native citation chip is the jump control.
- Brand-new proposed code is not linked (there is nothing in the workspace to jump to).
- Ambiguous snippets cite the top-ranked match and list alternatives; they do not invent line numbers.
- After-the-fact rewrite of an already-rendered assistant bubble is not possible with current hooks.


## Initial Prompt:
```
/create-plugin-scaffold Write a new Cursor Plugin that allows easy-click navigation to any code referenced in a Cursor chat by including a specific jump-link button. Clicking the jump-link button jumps directly to that location in code and highlights it. If the model doesn't produce a direct reference to workspace code, the plugin will perform a search in relevant files for a literal match in the background to find the most-likely matching code location and provide a link to that.

```