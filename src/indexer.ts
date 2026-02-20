import * as vscode from 'vscode';
import * as fs from 'fs';
import { JsonlSessionReader } from './jsonlReader';
import { ChatDatabase } from './database';
import { ExtractedAnnotation } from './types';
import { extractResponseParts } from './utils';

/**
 * Bridges JsonlSessionReader → ChatDatabase.
 * Provides incremental indexing using file mtime for change detection.
 */
export class Indexer {
  constructor(
    private readonly reader: JsonlSessionReader,
    private readonly db: ChatDatabase,
  ) {}

  /**
   * Incrementally reindex: only re-parse JSONL files whose mtime has changed.
   * Prunes sessions whose source files no longer exist.
   */
  async reindex(
    progress?: vscode.Progress<{ message?: string; increment?: number }>,
  ): Promise<{ indexed: number; skipped: number; pruned: number }> {
    // 1. Discover all sessions from disk (no age filter)
    progress?.report({ message: 'Discovering sessions…' });
    const summaries = await this.reader.listAllSessions(0);

    // 2. Check which files need re-indexing
    const toIndex: { summary: typeof summaries[number]; mtime: number }[] = [];
    let skipped = 0;

    for (const s of summaries) {
      try {
        const stat = await fs.promises.stat(s.filePath);
        const stale = await this.db.isStale(s.filePath, stat.mtimeMs);
        if (stale) {
          toIndex.push({ summary: s, mtime: stat.mtimeMs });
        } else {
          skipped++;
        }
      } catch {
        // File disappeared between discovery and stat
      }
    }

    // 3. Index changed/new files in batches
    const BATCH_SIZE = 8;
    let indexed = 0;

    for (let i = 0; i < toIndex.length; i += BATCH_SIZE) {
      const batch = toIndex.slice(i, i + BATCH_SIZE);
      progress?.report({
        message: `Indexing ${i + 1}–${Math.min(i + BATCH_SIZE, toIndex.length)} of ${toIndex.length}…`,
        increment: (batch.length / toIndex.length) * 100,
      });

      await Promise.all(batch.map(async ({ summary, mtime }) => {
        try {
          await this.indexSession(summary, mtime);
          indexed++;
        } catch (e) {
          console.warn(`Failed to index ${summary.filePath}:`, e);
        }
      }));

      // Yield to keep extension responsive
      await new Promise(resolve => setTimeout(resolve, 0));
    }

    // 4. Prune sessions whose JSONL files no longer exist
    progress?.report({ message: 'Pruning deleted sessions…' });
    const pruned = await this.pruneDeleted(summaries);

    return { indexed, skipped, pruned };
  }

  /**
   * Full reindex: wipe the DB and rebuild from scratch.
   */
  async fullReindex(
    progress?: vscode.Progress<{ message?: string; increment?: number }>,
  ): Promise<{ indexed: number; skipped: number; pruned: number }> {
    // Wipe all data in-place — no close/open gap that could leave the DB null
    await this.db.wipeData();
    return this.reindex(progress);
  }

  private async indexSession(summary: (typeof this.reader extends { listAllSessions(n: number): Promise<infer T> } ? T extends (infer U)[] ? U : never : never), mtime: number): Promise<void> {
    const data = await this.reader.readFullSession(summary.filePath);
    if (!data?.requests) { return; }

    // Upsert session with the mtime from the initial stat (avoids TOCTOU double-stat)
    await this.db.upsertSession(summary, mtime);

    // Index each turn
    for (let i = 0; i < data.requests.length; i++) {
      const req = data.requests[i];
      const { text: responseText, annotations } = extractResponseParts(req.response || []);

      // Extract attachment annotations from user-provided variables
      const attachmentAnnotations: ExtractedAnnotation[] = [];
      if (req.variableData?.variables) {
        for (const v of req.variableData.variables) {
          attachmentAnnotations.push({
            kind: 'attachment',
            name: v.name || v.id,
            uri: typeof v.value === 'string' ? v.value : '',
            detail: '',
          });
        }
      }

      const allAnnotations = [
        ...annotations,
        ...attachmentAnnotations,
      ].filter(a => a.kind === 'tool' || (a.kind === 'thinking' && a.detail) || a.name || a.uri || a.detail);

      const turnId = await this.db.upsertTurn({
        sessionId: data.sessionId,
        turnIndex: i,
        promptText: req.message?.text || '',
        responseText,
        agent: req.agent?.id || req.agent?.agentId || '',
        model: req.modelId || '',
        timestamp: req.timestamp || data.creationDate || 0,
        durationMs: req.result?.timings?.totalElapsed || 0,
        tokenTotal: req.usage?.totalTokens || 0,
        tokenPrompt: req.usage?.promptTokens || 0,
        tokenCompletion: req.usage?.completionTokens || 0,
        vote: req.vote || null,
      });

      if (allAnnotations.length > 0) {
        await this.db.addAnnotations(turnId, allAnnotations);
      }
    }
  }

  private async pruneDeleted(
    currentSummaries: { filePath: string }[],
  ): Promise<number> {
    const existingPaths = new Set(currentSummaries.map(s => s.filePath));
    const dbPaths = await this.db.getAllSessionPaths();

    const toDelete: string[] = [];
    for (const [filePath, sessionId] of dbPaths) {
      if (!existingPaths.has(filePath)) {
        toDelete.push(sessionId);
      }
    }

    if (toDelete.length > 0) {
      await this.db.deleteSessions(toDelete);
    }

    return toDelete.length;
  }
}
