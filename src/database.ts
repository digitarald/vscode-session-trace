import * as sqlite3 from '@vscode/sqlite3';
import { SessionSummary, TurnRow, AnnotationRow, SearchResult } from './types';

const SCHEMA_VERSION = 2;

/**
 * SQLite-backed persistent store for chat session data.
 *
 * Three tables + FTS5:
 *   sessions  — one row per conversation
 *   turns     — one row per user↔agent exchange
 *   annotations — one row per interesting facet (tool, file edit, reference, etc.)
 *   turns_fts — FTS5 virtual table for full-text search on turns
 */
export class ChatDatabase {
  private db: sqlite3.Database | null = null;
  private indexingBarrier: Promise<void> | null = null;
  private indexingBarrierResolve: (() => void) | null = null;

  constructor(private readonly dbPath: string) {}

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.db = new sqlite3.Database(this.dbPath, (err) => {
        if (err) { return reject(err); }
        this.initialize().then(resolve, reject);
      });
    });
  }

  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.db) { return resolve(); }
      this.db.close((err) => {
        this.db = null;
        err ? reject(err) : resolve();
      });
    });
  }

  beginIndexing(): void {
    if (this.indexingBarrier) { return; }
    this.indexingBarrier = new Promise((resolve) => {
      this.indexingBarrierResolve = resolve;
    });
  }

  endIndexing(): void {
    if (!this.indexingBarrierResolve) { return; }
    this.indexingBarrierResolve();
    this.indexingBarrierResolve = null;
    this.indexingBarrier = null;
  }

  // ---------------------------------------------------------------------------
  // Schema
  // ---------------------------------------------------------------------------

  private async initialize(): Promise<void> {
    await this.run('PRAGMA journal_mode = WAL');
    await this.run('PRAGMA synchronous = NORMAL');
    await this.run('PRAGMA foreign_keys = ON');

    // Check schema version
    await this.run(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)`);
    const row = await this.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', 'schema_version');
    const existingVersion = row ? parseInt(row.value, 10) : 0;

    if (existingVersion !== SCHEMA_VERSION) {
      await this.recreateSchema();
    } else {
      await this.ensureSchema();
    }
  }

  private async recreateSchema(): Promise<void> {
    await this.dropAllTables();
    await this.ensureSchema();
    await this.run(
      `INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`,
      'schema_version', String(SCHEMA_VERSION),
    );
  }

  private async dropAllTables(): Promise<void> {
    await this.exec(`
      DROP TABLE IF EXISTS annotations;
      DROP TABLE IF EXISTS turns_fts;
      DROP TABLE IF EXISTS turns;
      DROP TABLE IF EXISTS sessions;
    `);
  }

  /**
   * Wipe all indexed data while keeping the connection open.
   * Used by fullReindex to avoid a close→open gap.
   */
  async wipeData(): Promise<void> {
    await this.dropAllTables();
    await this.ensureSchema();
  }

  private async ensureSchema(): Promise<void> {
    await this.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        session_id    TEXT PRIMARY KEY,
        file_path     TEXT NOT NULL,
        title         TEXT,
        creation_date INTEGER,
        request_count INTEGER,
        last_message  TEXT,
        model_ids     TEXT,
        agents        TEXT,
        total_tokens  INTEGER DEFAULT 0,
        has_votes     INTEGER DEFAULT 0,
        file_size     INTEGER DEFAULT 0,
        storage_type  TEXT,
        workspace_path TEXT,
        file_mtime    INTEGER DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS turns (
        id               INTEGER PRIMARY KEY,
        session_id       TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
        turn_index       INTEGER NOT NULL,
        prompt_text      TEXT,
        response_text    TEXT,
        agent            TEXT,
        model            TEXT,
        timestamp        INTEGER,
        duration_ms      INTEGER,
        token_total      INTEGER DEFAULT 0,
        token_prompt     INTEGER DEFAULT 0,
        token_completion INTEGER DEFAULT 0,
        vote             INTEGER,
        UNIQUE(session_id, turn_index)
      );

      CREATE TABLE IF NOT EXISTS annotations (
        id      INTEGER PRIMARY KEY,
        turn_id INTEGER NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
        kind    TEXT NOT NULL,
        name    TEXT DEFAULT '',
        uri     TEXT DEFAULT '',
        detail  TEXT DEFAULT ''
      );

      CREATE INDEX IF NOT EXISTS idx_annotations_kind_name ON annotations(kind, name);
      CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session_id);
    `);

  // FTS5 virtual table backed by the turns table (content=turns);
  // we sync via triggers so the FTS index stays in lockstep
    try {
      await this.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS turns_fts USING fts5(
          prompt_text,
          response_text,
          agent,
          model,
          content=turns,
          content_rowid=id,
          tokenize='unicode61'
        );
      `);
    } catch {
      // FTS5 may already exist — ignore
    }

    // Triggers to keep FTS in sync
    await this.exec(`
      CREATE TRIGGER IF NOT EXISTS turns_ai AFTER INSERT ON turns BEGIN
        INSERT INTO turns_fts(rowid, prompt_text, response_text, agent, model)
        VALUES (new.id, new.prompt_text, new.response_text, new.agent, new.model);
      END;

      CREATE TRIGGER IF NOT EXISTS turns_ad AFTER DELETE ON turns BEGIN
        INSERT INTO turns_fts(turns_fts, rowid, prompt_text, response_text, agent, model)
        VALUES ('delete', old.id, old.prompt_text, old.response_text, old.agent, old.model);
      END;

      CREATE TRIGGER IF NOT EXISTS turns_au AFTER UPDATE ON turns BEGIN
        INSERT INTO turns_fts(turns_fts, rowid, prompt_text, response_text, agent, model)
        VALUES ('delete', old.id, old.prompt_text, old.response_text, old.agent, old.model);
        INSERT INTO turns_fts(rowid, prompt_text, response_text, agent, model)
        VALUES (new.id, new.prompt_text, new.response_text, new.agent, new.model);
      END;
    `);
  }

  // ---------------------------------------------------------------------------
  // Session CRUD
  // ---------------------------------------------------------------------------

  async upsertSession(s: SessionSummary, mtime: number): Promise<void> {
    await this.run(
      `INSERT INTO sessions
        (session_id, file_path, title, creation_date, request_count, last_message,
         model_ids, agents, total_tokens, has_votes, file_size, storage_type, workspace_path, file_mtime)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         file_path = excluded.file_path,
         title = excluded.title,
         creation_date = excluded.creation_date,
         request_count = excluded.request_count,
         last_message = excluded.last_message,
         model_ids = excluded.model_ids,
         agents = excluded.agents,
         total_tokens = excluded.total_tokens,
         has_votes = excluded.has_votes,
         file_size = excluded.file_size,
         storage_type = excluded.storage_type,
         workspace_path = excluded.workspace_path,
         file_mtime = excluded.file_mtime`,
      s.sessionId, s.filePath, s.title || null, s.creationDate, s.requestCount,
      s.lastMessage || null, s.modelIds.join(','), s.agents.join(','),
      s.totalTokens, s.hasVotes ? 1 : 0, s.fileSize, s.storageType,
      s.workspacePath, mtime,
    );
  }

  async listSessions(opts: {
    maxAgeDays?: number;
    storageType?: string;
    workspacePath?: string;
    limit?: number;
    offset?: number;
  } = {}): Promise<SessionSummary[]> {
    await this.waitForIndexing();
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (opts.maxAgeDays && opts.maxAgeDays > 0) {
      const cutoff = Date.now() - opts.maxAgeDays * 86_400_000;
      conditions.push('creation_date >= ?');
      params.push(cutoff);
    }
    if (opts.storageType) {
      conditions.push('storage_type = ?');
      params.push(opts.storageType);
    }
    if (opts.workspacePath) {
      conditions.push('workspace_path = ?');
      params.push(opts.workspacePath);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = (opts.limit && Number.isInteger(opts.limit) && opts.limit > 0) ? `LIMIT ${opts.limit}` : '';
    const offset = (opts.offset && Number.isInteger(opts.offset) && opts.offset > 0) ? `OFFSET ${opts.offset}` : '';

    const rows = await this.all<{
      session_id: string; file_path: string; title: string | null;
      creation_date: number; request_count: number; last_message: string | null;
      model_ids: string; agents: string; total_tokens: number;
      has_votes: number; file_size: number; storage_type: string; workspace_path: string;
    }>(`SELECT * FROM sessions ${where} ORDER BY creation_date DESC ${limit} ${offset}`, ...params);

    return rows.map(r => ({
      sessionId: r.session_id,
      filePath: r.file_path,
      title: r.title || undefined,
      creationDate: r.creation_date,
      requestCount: r.request_count,
      lastMessage: r.last_message || undefined,
      modelIds: r.model_ids ? r.model_ids.split(',') : [],
      agents: r.agents ? r.agents.split(',') : [],
      totalTokens: r.total_tokens,
      hasVotes: r.has_votes === 1,
      fileSize: r.file_size,
      storageType: r.storage_type as SessionSummary['storageType'],
      workspacePath: r.workspace_path,
    }));
  }

  async deleteSessions(sessionIds: string[]): Promise<void> {
    if (sessionIds.length === 0) { return; }
    const placeholders = sessionIds.map(() => '?').join(',');
    await this.run(`DELETE FROM sessions WHERE session_id IN (${placeholders})`, ...sessionIds);
  }

  async deleteSessionsByFilePath(filePath: string, exceptSessionId?: string): Promise<void> {
    if (exceptSessionId) {
      await this.run('DELETE FROM sessions WHERE file_path = ? AND session_id != ?', filePath, exceptSessionId);
      return;
    }
    await this.run('DELETE FROM sessions WHERE file_path = ?', filePath);
  }

  async getAllSessionPaths(skipIndexingWait = false): Promise<Map<string, string>> {
    if (!skipIndexingWait) {
      await this.waitForIndexing();
    }
    const rows = await this.all<{ session_id: string; file_path: string }>(
      'SELECT session_id, file_path FROM sessions',
    );
    const map = new Map<string, string>();
    for (const r of rows) { map.set(r.file_path, r.session_id); }
    return map;
  }

  /** Single bulk query returning filePath → stored mtime for all indexed sessions. */
  async getAllSessionMtimes(skipIndexingWait = false): Promise<Map<string, number>> {
    if (!skipIndexingWait) {
      await this.waitForIndexing();
    }
    const rows = await this.all<{ file_path: string; file_mtime: number }>(
      'SELECT file_path, file_mtime FROM sessions',
    );
    const map = new Map<string, number>();
    for (const r of rows) { map.set(r.file_path, r.file_mtime); }
    return map;
  }

  // ---------------------------------------------------------------------------
  // Turn CRUD
  // ---------------------------------------------------------------------------

  async upsertTurn(t: TurnRow): Promise<number> {
    await this.run(
      `INSERT INTO turns
        (session_id, turn_index, prompt_text, response_text, agent, model,
         timestamp, duration_ms, token_total, token_prompt, token_completion, vote)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id, turn_index) DO UPDATE SET
         prompt_text = excluded.prompt_text,
         response_text = excluded.response_text,
         agent = excluded.agent,
         model = excluded.model,
         timestamp = excluded.timestamp,
         duration_ms = excluded.duration_ms,
         token_total = excluded.token_total,
         token_prompt = excluded.token_prompt,
         token_completion = excluded.token_completion,
         vote = excluded.vote`,
      t.sessionId, t.turnIndex, t.promptText, t.responseText,
      t.agent, t.model, t.timestamp, t.durationMs,
      t.tokenTotal, t.tokenPrompt, t.tokenCompletion, t.vote,
    );
    // Retrieve the actual row id — lastID is unreliable on ON CONFLICT UPDATE path
    const row = await this.get<{ id: number }>(
      'SELECT id FROM turns WHERE session_id = ? AND turn_index = ?',
      t.sessionId, t.turnIndex,
    );
    return row!.id;
  }

  async getSessionTurns(sessionId: string): Promise<TurnRow[]> {
    await this.waitForIndexing();
    const rows = await this.all<{
      id: number; session_id: string; turn_index: number;
      prompt_text: string; response_text: string; agent: string; model: string;
      timestamp: number; duration_ms: number;
      token_total: number; token_prompt: number; token_completion: number;
      vote: number | null;
    }>('SELECT * FROM turns WHERE session_id = ? ORDER BY turn_index', sessionId);

    return rows.map(r => ({
      id: r.id,
      sessionId: r.session_id,
      turnIndex: r.turn_index,
      promptText: r.prompt_text || '',
      responseText: r.response_text || '',
      agent: r.agent || '',
      model: r.model || '',
      timestamp: r.timestamp || 0,
      durationMs: r.duration_ms || 0,
      tokenTotal: r.token_total || 0,
      tokenPrompt: r.token_prompt || 0,
      tokenCompletion: r.token_completion || 0,
      vote: r.vote,
    }));
  }

  async deleteTurnsForSession(sessionId: string): Promise<void> {
    await this.run('DELETE FROM turns WHERE session_id = ?', sessionId);
  }

  // ---------------------------------------------------------------------------
  // Annotation CRUD
  // ---------------------------------------------------------------------------

  async addAnnotations(turnId: number, annotations: { kind: string; name: string; uri: string; detail: string }[]): Promise<void> {
    if (annotations.length === 0) { return; }
    const stmt = 'INSERT INTO annotations (turn_id, kind, name, uri, detail) VALUES (?, ?, ?, ?, ?)';
    for (const a of annotations) {
      await this.run(stmt, turnId, a.kind, a.name, a.uri, a.detail);
    }
  }

  async queryAnnotations(opts: {
    kind?: string;
    name?: string;
    sessionId?: string;
    limit?: number;
  } = {}): Promise<AnnotationRow[]> {
    await this.waitForIndexing();
    const conditions: string[] = [];
    const params: unknown[] = [];
    let join = '';

    if (opts.kind) {
      conditions.push('a.kind = ?');
      params.push(opts.kind);
    }
    if (opts.name) {
      conditions.push('a.name = ?');
      params.push(opts.name);
    }
    if (opts.sessionId) {
      join = 'JOIN turns t ON a.turn_id = t.id';
      conditions.push('t.session_id = ?');
      params.push(opts.sessionId);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = (opts.limit && Number.isInteger(opts.limit) && opts.limit > 0) ? `LIMIT ${opts.limit}` : 'LIMIT 100';

    return this.all<AnnotationRow>(
      `SELECT a.* FROM annotations a ${join} ${where} ORDER BY a.id DESC ${limit}`,
      ...params,
    );
  }

  // ---------------------------------------------------------------------------
  // FTS5 search
  // ---------------------------------------------------------------------------

  async search(query: string, opts: {
    scope?: string;
    daysBack?: number;
    limit?: number;
  } = {}): Promise<SearchResult[]> {
    await this.waitForIndexing();
    if (!query.trim()) { return []; }

    // Build FTS5 match expression: add * for prefix matching on each term.
    // Preserve FTS5 boolean operators (OR, NOT, AND) when present.
    const FTS_OPERATORS = new Set(['OR', 'NOT', 'AND']);
    const tokens = query.trim()
      .split(/\s+/)
      .map(term => FTS_OPERATORS.has(term.toUpperCase())
        ? term.toUpperCase()
        : `"${term.replace(/"/g, '""')}"*`);
    // Strip leading/trailing bare operators (e.g. "OR term" → "term")
    while (tokens.length > 0 && FTS_OPERATORS.has(tokens[0])) { tokens.shift(); }
    while (tokens.length > 0 && FTS_OPERATORS.has(tokens[tokens.length - 1])) { tokens.pop(); }
    const ftsQuery = tokens.join(' ');
    if (!ftsQuery) { return []; }

    const conditions: string[] = [];
    const params: unknown[] = [ftsQuery];

    if (opts.scope) {
      conditions.push('s.workspace_path = ?');
      params.push(opts.scope);
    }
    if (opts.daysBack && opts.daysBack > 0) {
      const cutoff = Date.now() - opts.daysBack * 86_400_000;
      conditions.push('t.timestamp >= ?');
      params.push(cutoff);
    }

    const extraWhere = conditions.length > 0 ? `AND ${conditions.join(' AND ')}` : '';
    const limit = opts.limit || 20;

    const rows = await this.all<{
      session_id: string; file_path: string; title: string | null;
      workspace_path: string; storage_type: string;
      turn_index: number; prompt_text: string; response_text: string;
      agent: string; model: string; timestamp: number; duration_ms: number;
      rank: number;
    }>(`
      SELECT
        s.session_id, s.file_path, s.title, s.workspace_path, s.storage_type,
        t.turn_index, t.prompt_text, t.response_text,
        t.agent, t.model, t.timestamp, t.duration_ms,
        turns_fts.rank
      FROM turns_fts
      JOIN turns t ON t.id = turns_fts.rowid
      JOIN sessions s ON s.session_id = t.session_id
      WHERE turns_fts MATCH ? ${extraWhere}
      ORDER BY turns_fts.rank
      LIMIT ?
    `, ...params, limit);

    return rows.map(r => ({
      sessionId: r.session_id,
      filePath: r.file_path,
      sessionTitle: r.title || '',
      workspacePath: r.workspace_path || '',
      storageType: r.storage_type || '',
      turnIndex: r.turn_index,
      promptText: r.prompt_text || '',
      responseText: r.response_text || '',
      agent: r.agent || '',
      model: r.model || '',
      timestamp: r.timestamp || 0,
      durationMs: r.duration_ms || 0,
      rank: r.rank,
    }));
  }

  // ---------------------------------------------------------------------------
  // Read-only SQL execution
  // ---------------------------------------------------------------------------

  private static readonly MAX_QUERY_ROWS = 500;

  /**
   * Run a read-only SELECT on a separate OPEN_READONLY connection.
   * Validates the statement is a SELECT and caps rows at MAX_QUERY_ROWS.
   */
  queryReadOnly(sql: string): Promise<{ rows: unknown[]; truncated: boolean }> {
    const pending = this.waitForIndexing();
    if (!this.db) {
      return Promise.reject(new Error('Database is not open'));
    }

    return pending.then(() => {
      const trimmed = sql.trim();
      if (!/^(SELECT|WITH)\b/i.test(trimmed)) {
        return Promise.reject(new Error('Only SELECT statements are allowed'));
      }
      if (/\bRECURSIVE\b/i.test(trimmed)) {
        return Promise.reject(new Error('Recursive CTEs are not supported'));
      }

      const limited = `SELECT * FROM (${trimmed}) LIMIT ${ChatDatabase.MAX_QUERY_ROWS + 1}`;

      return new Promise((resolve, reject) => {
        const ro = new sqlite3.Database(this.dbPath, sqlite3.OPEN_READONLY, (err) => {
          if (err) { return reject(err); }
          ro.all(limited, [], (err2, rows) => {
            ro.close(() => {/* best-effort close */});
            if (err2) { return reject(err2); }
            const all = (rows || []) as unknown[];
            const truncated = all.length > ChatDatabase.MAX_QUERY_ROWS;
            resolve({ rows: truncated ? all.slice(0, ChatDatabase.MAX_QUERY_ROWS) : all, truncated });
          });
        });
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Stats
  // ---------------------------------------------------------------------------

  async getStats(): Promise<{ sessions: number; turns: number; annotations: number }> {
    await this.waitForIndexing();
    const s = await this.get<{ c: number }>('SELECT COUNT(*) as c FROM sessions');
    const t = await this.get<{ c: number }>('SELECT COUNT(*) as c FROM turns');
    const a = await this.get<{ c: number }>('SELECT COUNT(*) as c FROM annotations');
    return {
      sessions: s?.c || 0,
      turns: t?.c || 0,
      annotations: a?.c || 0,
    };
  }

  /**
   * Return a schema overview with row counts, annotation kind distribution,
   * top models/agents, and date range. Designed to replace 3-4 exploratory
   * queries with a single call.
   */
  async describe(): Promise<Record<string, unknown>> {
    await this.waitForIndexing();
    const [stats, kinds, models, agents, dateRange, topTools] = await Promise.all([
      this.getStats(),
      this.all<{ kind: string; c: number }>(
        'SELECT kind, COUNT(*) as c FROM annotations GROUP BY kind ORDER BY c DESC',
      ),
      this.all<{ model: string; c: number }>(
        `SELECT model, COUNT(*) as c FROM turns WHERE model != '' GROUP BY model ORDER BY c DESC LIMIT 10`,
      ),
      this.all<{ agent: string; c: number }>(
        `SELECT agent, COUNT(*) as c FROM turns WHERE agent != '' GROUP BY agent ORDER BY c DESC LIMIT 10`,
      ),
      this.get<{ earliest: number; latest: number }>(
        'SELECT MIN(creation_date) as earliest, MAX(creation_date) as latest FROM sessions',
      ),
      this.all<{ name: string; c: number }>(
        `SELECT name, COUNT(*) as c FROM annotations WHERE kind='tool' GROUP BY name ORDER BY c DESC LIMIT 15`,
      ),
    ]);

    const kindNames = new Set(kinds.map(k => k.kind));
    const hints: string[] = [];
    if (kindNames.has('tool') && topTools.length > 0) {
      hints.push('Tool annotations are available. Query with: SELECT name, COUNT(*) c FROM annotations WHERE kind=\'tool\' GROUP BY name ORDER BY c DESC LIMIT 20');
      const mcpTools = topTools.filter(t => t.name.startsWith('mcp_'));
      if (mcpTools.length > 0) {
        hints.push('MCP tools found: ' + mcpTools.map(t => t.name).join(', '));
      }
    } else {
      hints.push('Tool annotations (kind=\'tool\') are not yet populated. Re-index to populate them, or use FTS text search: query parameter with tool names like "mcp_github OR mcp_perplexity".');
    }

    return {
      tableCounts: stats,
      annotationKinds: kinds.map(k => ({ kind: k.kind, count: k.c })),
      topTools: topTools.map(t => ({ name: t.name, count: t.c })),
      topModels: models.map(m => ({ model: m.model, count: m.c })),
      topAgents: agents.map(a => ({ agent: a.agent, count: a.c })),
      dateRange: dateRange
        ? { earliest: dateRange.earliest, latest: dateRange.latest }
        : null,
      hints,
    };
  }

  // ---------------------------------------------------------------------------
  // Low-level helpers
  // ---------------------------------------------------------------------------

  private run(sql: string, ...params: unknown[]): Promise<void> {
    return new Promise((resolve, reject) => {
      this.db!.run(sql, params, (err) => err ? reject(err) : resolve());
    });
  }

  private runWithLastId(sql: string, ...params: unknown[]): Promise<number> {
    return new Promise((resolve, reject) => {
      this.db!.run(sql, params, function (err) {
        err ? reject(err) : resolve(this.lastID);
      });
    });
  }

  private get<T>(sql: string, ...params: unknown[]): Promise<T | undefined> {
    return new Promise((resolve, reject) => {
      this.db!.get(sql, params, (err, row) => err ? reject(err) : resolve(row as T | undefined));
    });
  }

  private all<T>(sql: string, ...params: unknown[]): Promise<T[]> {
    return new Promise((resolve, reject) => {
      this.db!.all(sql, params, (err, rows) => err ? reject(err) : resolve((rows || []) as T[]));
    });
  }

  async beginTransaction(): Promise<void> {
    await this.run('BEGIN IMMEDIATE');
  }

  async commit(): Promise<void> {
    await this.run('COMMIT');
  }

  async rollback(): Promise<void> {
    await this.run('ROLLBACK');
  }

  private async waitForIndexing(): Promise<void> {
    if (this.indexingBarrier) {
      await this.indexingBarrier;
    }
  }

  private exec(sql: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.db!.exec(sql, (err) => err ? reject(err) : resolve());
    });
  }
}
