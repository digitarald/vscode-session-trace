# Session Trace

[![Build](https://github.com/digitarald/vscode-session-trace/actions/workflows/build.yml/badge.svg)](https://github.com/digitarald/vscode-session-trace/actions/workflows/build.yml)

A VS Code extension that indexes your Copilot Chat session files (`.jsonl`) into a local SQLite database and exposes them through a tree view, a quick-pick search, and a language model tool for conversational queries.

## Features

### Session Tree View
Browse all Copilot Chat sessions stored on disk — workspace sessions, global (empty window) sessions, and transferred sessions. Expand each session to see individual turns with their prompts and responses.

The view toolbar provides:

- **Sort** (`$(arrow-up)`) — order sessions by date (newest first), number of turns, or name.
- **Filter** (`$(filter)`) — narrow sessions by storage type (workspace / global / transferred) and time range (last 7, 30, or 90 days). The active filter is shown in the view's subtitle.
- **Switch to Recent View** (`$(history)`) / **Switch to Sessions View** (`$(list-tree)`) — toggle between the grouped sessions tree and a flat recent-messages view that streams in the latest turns with their full prompt and response content.

### Search Conversations
Use the **Session Trace: Search Conversations** command (`Ctrl+Shift+P`) to fuzzy-search across all indexed prompts, responses, and session titles using full-text search backed by SQLite FTS5.

### `#sessionTraceSearch` Language Model Tool
In Copilot Chat, reference `#sessionTraceSearch` to query your history with natural language, SQL, or full-text search:

```
What did I ask about React hooks last week? #sessionTraceSearch
```

The tool supports three modes:
- **`describe`** — Returns a schema overview: row counts, annotation distribution, top tools, models, and date range.
- **`query`** — Full-text search via FTS5 with BM25 ranking (implicit AND, supports OR/NOT).
- **`sql`** — Read-only SQL SELECT for aggregations, complex filters, and joins.

## Usage

1. Install the extension.
2. Open the **Session Trace** activity bar panel (speech-bubble icon).
3. Sessions are discovered and indexed automatically on activation.
4. Use the **Refresh** button to re-index after new sessions are created.
5. Use the **Sort** or **Filter** toolbar buttons to narrow or reorder the session list.
6. Click the **Switch to Recent View** button to browse the latest conversation turns inline.
7. Click the **Search** icon or run `Session Trace: Search Conversations` to search.

## Data Storage

The extension discovers `.jsonl` session files from VS Code's user data directory (derived from `ExtensionContext.globalStorageUri`). It supports:
- `User/globalStorage/emptyWindowChatSessions/` — global sessions
- `User/globalStorage/transferredChatSessions/` — transferred sessions
- `User/workspaceStorage/{hash}/chatSessions/` — per-workspace sessions

The SQLite index is stored in the extension's global storage directory and is rebuilt incrementally.

## Requirements

- VS Code `^1.99.0`
- GitHub Copilot Chat extension

## Extension Settings

This extension contributes no user-configurable settings.

