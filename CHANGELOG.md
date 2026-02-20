# Changelog

## [0.0.1] - 2026-02-19

### Added
- Session tree view for browsing Copilot Chat JSONL sessions from disk
- Recent messages view showing the latest indexed turns
- Full-text search command (`Session Trace: Search Conversations`) backed by SQLite FTS5
- `#sessionTraceSearch` language model tool with `describe`, `query`, and `sql` modes
- Incremental indexing with SQLite WAL mode for non-blocking reads
- Support for workspace, global, and transferred session storage paths
