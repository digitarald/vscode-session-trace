# Changelog

## [0.0.1] - 2026-02-19

### Added
- Session tree view for browsing Copilot Chat JSONL sessions from disk
- Sorting and filtering toolbar in the session tree: sort by date, turn count, or name; filter by scope (all workspaces, current workspace, global storage, transferred) and time period (last 7 or 30 days)
- `$(open-preview)` inline action on session items to open the session as a formatted Markdown preview
- `$(go-to-file)` inline action on session items to open the raw JSONL file
- Full-text search command (`Session Trace: Search Conversations`) backed by SQLite FTS5
- `#searchChatSessions` language model tool with `describe`, `query`, and `sql` modes
- Incremental indexing: startup scan compares file modification times and only re-indexes changed or new session files
- SQLite WAL mode for non-blocking reads during indexing
- Support for workspace, global, and transferred session storage paths
- GitHub Actions build workflow producing platform-specific VSIX packages (Linux, Windows, macOS)
- GitHub Actions release workflow for VS Code Marketplace publishing (release and pre-release channels)
- ESLint flat config (`eslint.config.mjs`)
- `$(timeline-open)` icon for the extension activity bar view

### Changed
- Folded the separate "Recent Messages" panel into the main session tree view; recency is now controlled by the time-period filter
- Renamed the language model tool from `#sessionTraceSearch` to `#searchChatSessions`

### Fixed
- GitHub Actions macOS runner was using the unsupported `macos-13-us-default` configuration; updated to `macos-latest`
- Raw line index clamped with `Math.max(0, rawLines.length - 1)` to prevent out-of-bounds access
- `errorDetails?.message?.split('\n') ?? []` prevents a crash when error details are absent in a session request
- Recent view now correctly respects active scope and day filters rather than always showing a fixed window
