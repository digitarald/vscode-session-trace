import * as vscode from 'vscode';
import * as fs from 'fs';
import { JsonlSessionReader } from './jsonlReader';
import { ChatDatabase } from './database';
import { ExtractedAnnotation, SerializableChatData, SessionSummary } from './types';
import { extractResponseParts } from './utils';

/**
 * Bridges JsonlSessionReader → ChatDatabase.
 * Provides incremental indexing using file mtime for change detection.
 */
export class Indexer {
  private inFlightReindex: Promise<{ indexed: number; skipped: number; pruned: number }> | null = null;

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
    // Coalesce overlapping reindex calls — second caller awaits the existing run
    if (this.inFlightReindex) { return this.inFlightReindex; }
    this.inFlightReindex = this.doReindex(progress);
    try { return await this.inFlightReindex; } finally { this.inFlightReindex = null; }
  }

  private async doReindex(
    progress?: vscode.Progress<{ message?: string; increment?: number }>,
  ): Promise<{ indexed: number; skipped: number; pruned: number }> {
    // 1. Lightweight discovery — readdir only, no file reads or stats
    progress?.report({ message: 'Discovering sessions…' });
    const files = await this.reader.discoverSessionFiles();

    // 2. Bulk staleness check — single DB query instead of N individual queries
    const knownMtimes = await this.db.getAllSessionMtimes();

    // 3. Stat each file and classify as stale or up-to-date
    const toIndex: { filePath: string; storageType: SessionSummary['storageType']; mtime: number; fileSize: number }[] = [];
    let skipped = 0;

    await Promise.all(files.map(async ({ filePath, storageType }) => {
      try {
        const stat = await fs.promises.stat(filePath);
        const known = knownMtimes.get(filePath);
        if (known === undefined || known < stat.mtimeMs) {
          toIndex.push({ filePath, storageType, mtime: stat.mtimeMs, fileSize: stat.size });
        } else {
          skipped++;
        }
      } catch {
        // File disappeared between discovery and stat
      }
    }));

    // 4. Parse and index changed/new files in batches
    const BATCH_SIZE = 8;
    let indexed = 0;

    for (let i = 0; i < toIndex.length; i += BATCH_SIZE) {
      const batch = toIndex.slice(i, i + BATCH_SIZE);
      progress?.report({
        message: `Indexing ${i + 1}–${Math.min(i + BATCH_SIZE, toIndex.length)} of ${toIndex.length}…`,
        increment: (batch.length / toIndex.length) * 100,
      });

      // Parse files in parallel (I/O-bound), then write to DB sequentially (single connection)
      const parsed = await Promise.all(batch.map(async ({ filePath, storageType, mtime, fileSize }) => {
        try {
          const result = await this.reader.parseSessionFile(filePath, storageType, { size: fileSize, mtimeMs: mtime });
          return result ? { result, mtime, filePath } : null;
        } catch (e) {
          console.warn(`Failed to parse ${filePath}:`, e);
          return null;
        }
      }));

      for (const entry of parsed) {
        if (!entry) { continue; }
        try {
          await this.indexSession(entry.result.summary, entry.result.data, entry.mtime);
          indexed++;
        } catch (e) {
          console.warn(`Failed to index ${entry.filePath}:`, e);
        }
      }

      // Yield to keep extension responsive
      await new Promise(resolve => setTimeout(resolve, 0));
    }

    // 5. Prune sessions whose JSONL files no longer exist
    progress?.report({ message: 'Pruning deleted sessions…' });
    this.db.beginIndexing();
    let pruned = 0;
    try {
      pruned = await this.pruneDeleted(files);
    } finally {
      this.db.endIndexing();
    }

    return { indexed, skipped, pruned };
  }

  /**
   * Full reindex: wipe the DB and rebuild from scratch.
   */
  async fullReindex(
    progress?: vscode.Progress<{ message?: string; increment?: number }>,
  ): Promise<{ indexed: number; skipped: number; pruned: number }> {
    if (this.inFlightReindex) {
      await this.inFlightReindex;
    }
    // Wipe all data in-place — no close/open gap that could leave the DB null
    await this.db.wipeData();
    // Reset guard so doReindex runs fresh after wipe
    this.inFlightReindex = null;
    return this.reindex(progress);
  }

  private async indexSession(summary: SessionSummary, data: SerializableChatData, mtime: number): Promise<void> {
    if (!data.requests) { return; }

    this.db.beginIndexing();
    let txStarted = false;
    try {
      await this.db.beginTransaction();
      txStarted = true;

      // Remove any stale session rows reusing the same file path
      await this.db.deleteSessionsByFilePath(summary.filePath, data.sessionId);

      // Upsert session with the mtime from the initial stat (avoids TOCTOU double-stat)
      await this.db.upsertSession(summary, mtime);

      // Clear existing turns so removed turns/annotations don't linger
      await this.db.deleteTurnsForSession(data.sessionId);

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

      await this.db.commit();
    } catch (e) {
      if (txStarted) {
        try { await this.db.rollback(); } catch { /* swallow rollback error to avoid masking primary failure */ }
      }
      throw e;
    } finally {
      this.db.endIndexing();
    }
  }

  private async pruneDeleted(
    currentSummaries: { filePath: string }[],
  ): Promise<number> {
    const existingPaths = new Set(currentSummaries.map(s => s.filePath));
    const dbPaths = await this.db.getAllSessionPaths(true);

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
