import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import { ChatDatabase } from './database';
import { relativeTime } from './utils';

interface SearchToolInput {
  query?: string;
  sql?: string;
  describe?: boolean;
  scope?: 'currentWorkspace' | 'allWorkspaces';
  daysBack?: number;
  label?: string;
}

/**
 * Language Model Tool for full-text search over chat conversation history
 * backed by SQLite FTS5.
 */
export class SessionTraceSearchTool
  implements vscode.LanguageModelTool<SearchToolInput>
{
  constructor(private readonly db: ChatDatabase) {}

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<SearchToolInput>,
  ): Promise<vscode.LanguageModelToolResult> {
    const { query, sql, describe, scope, daysBack } = options.input;

    // --- Describe: return schema overview ---
    if (describe) {
      if (sql || query) {
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(JSON.stringify({ error: "'describe' is mutually exclusive with 'query' and 'sql'. Use describe alone." })),
        ]);
      }
      try {
        const info = await this.db.describe();
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(JSON.stringify(info, null, 2)),
        ]);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : 'Describe failed';
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(JSON.stringify({ error: msg })),
        ]);
      }
    }

    // --- Validate: need exactly one of sql or query ---
    if (sql && query) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(JSON.stringify({ error: "Provide either 'query' (FTS search) or 'sql' (SELECT statement), not both." })),
      ]);
    }
    if (!sql && !query?.trim()) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(JSON.stringify({ error: "Provide either 'query' (FTS search) or 'sql' (SELECT statement)." })),
      ]);
    }

    // --- Raw SQL path ---
    if (sql) {
      if (/\?|[:$@][a-zA-Z_]/.test(sql)) {
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(JSON.stringify({ error: 'Parameterized queries (?, :name, $name, @name) are not supported. Use literal values in SQL.' })),
        ]);
      }
      try {
        const { rows, truncated } = await this.db.queryReadOnly(sql);
        const result: { rowCount: number; rows: unknown[]; truncated?: boolean; hint?: string } = { rowCount: rows.length, rows };
        if (truncated) { result.truncated = true; }
        if (rows.length === 0) {
          // Detect annotation kind queries and give specific guidance
          const kindMatch = sql.match(/kind\s*=\s*'([^']+)'/i);
          if (kindMatch) {
            result.hint = `No annotations with kind='${kindMatch[1]}' found. Use describe:true to see available annotation kinds and top tools. After re-indexing, tool annotations (kind='tool') should be populated.`;
          } else {
            result.hint = 'No rows matched. Try the FTS \'query\' parameter for keyword search, or explore available values with SELECT DISTINCT on the column you filtered.';
          }
        }
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(JSON.stringify(result, null, 2)),
        ]);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : 'Query failed';
        // Strip filesystem paths from error messages (Unix and Windows)
        // Replace home dir first (handles paths with spaces), then remaining absolute paths
        const homeEscaped = os.homedir().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const safe = msg
          .replace(new RegExp(homeEscaped, 'g'), '~')
          .replace(/(?:[A-Za-z]:[\\]|\/)[^\s"]*/g, '<path>');
        let hint: string | undefined;
        if (/no such column/i.test(msg)) {
          hint = 'Column not found. Available columns — sessions: session_id, title, creation_date, request_count, model_ids, agents, total_tokens, has_votes, storage_type, workspace_path; turns: id, session_id, turn_index, prompt_text, response_text, agent, model, timestamp, duration_ms, token_total, vote; annotations: id, turn_id, kind, name, uri, detail.';
        } else if (/no such table/i.test(msg)) {
          hint = 'Table not found. Available tables: sessions, turns, annotations, turns_fts.';
        } else if (/fts5/i.test(msg) || /match/i.test(msg)) {
          hint = 'FTS5 syntax error. Use turns_fts MATCH \'term1 term2\' (implicit AND) or MATCH \'term1 OR term2\' for OR. For the query parameter, use \'term1 OR term2\' directly. For complex text searches, consider using the \'query\' parameter instead.';
        }
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(JSON.stringify(hint ? { error: safe, hint } : { error: safe })),
        ]);
      }
    }

    // --- FTS5 search path (query is guaranteed non-empty here) ---
    const searchQuery = query!;

    let wsScope: string | undefined;
    if (scope === 'currentWorkspace') {
      const wsFolder = vscode.workspace.workspaceFolders?.[0];
      if (wsFolder) {
        wsScope = path.basename(wsFolder.uri.fsPath);
      }
    }

    try {
      const results = await this.db.search(searchQuery, {
        scope: wsScope,
        daysBack,
        limit: 20,
      });

      const output = results.map((r) => ({
        sessionTitle: r.sessionTitle,
        promptText: r.promptText.substring(0, 500),
        responseText: r.responseText.substring(0, 300),
        agent: r.agent || undefined,
        model: r.model || undefined,
        timestamp: r.timestamp,
        timeAgo: relativeTime(r.timestamp),
        workspacePath: r.workspacePath || undefined,
        turnIndex: r.turnIndex,
      }));

      const envelope: { resultCount: number; results: typeof output; hint?: string } = { resultCount: output.length, results: output };
      if (output.length === 0) {
        envelope.hint = 'No matches found. For multi-term searches, try \'term1 OR term2\' for any-match instead of the default all-match. Use describe:true to see available annotation kinds and data, or the \'sql\' parameter for structured queries.';
      }

      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(JSON.stringify(envelope, null, 2)),
      ]);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Search failed';
      const homeEscaped2 = os.homedir().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const safe = msg
        .replace(new RegExp(homeEscaped2, 'g'), '~')
        .replace(/(?:[A-Za-z]:[\\/]|\/)[^\s"]*/g, '<path>');
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(JSON.stringify({ error: safe, hint: 'FTS search failed. Try simpler search terms (single words work best). Use \'term1 OR term2\' for any-match semantics. Or use the \'sql\' parameter with LIKE for flexible text matching.' })),
      ]);
    }
  }

  async prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<SearchToolInput>,
  ): Promise<vscode.PreparedToolInvocation> {
    const { sql, query, describe, label } = options.input;
    let message: string;
    if (label) {
      message = label;
    } else if (describe) {
      message = 'Describing chat history schema…';
    } else if (sql && query) {
      message = 'Invalid: both sql and query provided';
    } else if (sql) {
      message = sql.length > 80 ? `Running SQL: ${sql.slice(0, 80)}…` : `Running SQL: ${sql}`;
    } else {
      message = `Searching chat history for "${query ?? ''}"…`;
    }
    return { invocationMessage: message };
  }
}

