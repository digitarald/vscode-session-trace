import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { SerializableChatData, MutationEntry, SessionSummary } from './types';

/**
 * Discovers and reads .jsonl chat session files from VS Code's storage directories.
 *
 * The User data directory is derived from `ExtensionContext.globalStorageUri`
 * (navigating up two levels from `.../User/globalStorage/<extensionId>`).
 * This works across all platforms and with custom `--user-data-dir` configurations.
 *
 * Probed sub-paths:
 *   User/workspaceStorage/{hash}/chatSessions/*.jsonl
 *   User/globalStorage/emptyWindowChatSessions/*.jsonl
 *   User/globalStorage/transferredChatSessions/*.jsonl
 */
export class JsonlSessionReader {
  private storageDirs: { path: string; type: SessionSummary['storageType'] }[] = [];
  private readonly userDir: string;
  private discoveryPromise: Promise<void> | null = null;

  constructor(context: vscode.ExtensionContext) {
    // globalStorageUri = .../User/globalStorage/<publisher.extensionId>
    // Navigate up two levels to reach the User directory
    this.userDir = vscode.Uri.joinPath(context.globalStorageUri, '..', '..').fsPath;
  }

  /**
   * Ensure storage paths are discovered (lazy, async, runs once).
   */
  private async ensureDiscovered(): Promise<void> {
    if (this.storageDirs.length > 0) {
      return;
    }
    if (this.discoveryPromise) {
      return this.discoveryPromise;
    }
    this.discoveryPromise = this.discoverStoragePaths();
    await this.discoveryPromise;
  }

  /**
   * Find all VS Code storage directories that may contain chatSessions.
   * Uses the User directory derived from ExtensionContext.globalStorageUri.
   */
  private async discoverStoragePaths(): Promise<void> {
    const base = this.userDir;
    const dirs: { path: string; type: SessionSummary['storageType'] }[] = [];

    // Global storage paths
    const emptyWindow = path.join(base, 'globalStorage', 'emptyWindowChatSessions');
    if (await this.pathExists(emptyWindow)) {
      dirs.push({ path: emptyWindow, type: 'global' });
    }

    const transferred = path.join(base, 'globalStorage', 'transferredChatSessions');
    if (await this.pathExists(transferred)) {
      dirs.push({ path: transferred, type: 'transferred' });
    }

    // Workspace storage paths — enumerate all workspace hashes
    const workspaceStorage = path.join(base, 'workspaceStorage');
    if (await this.pathExists(workspaceStorage)) {
      try {
        const entries = await fs.promises.readdir(workspaceStorage, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory() && !entry.isSymbolicLink()) {
            const chatDir = path.join(workspaceStorage, entry.name, 'chatSessions');
            if (await this.pathExists(chatDir)) {
              dirs.push({ path: chatDir, type: 'workspace' });
            }
          }
        }
      } catch {
        // Permission denied or similar
      }
    }

    this.storageDirs = dirs;
  }

  private async pathExists(p: string): Promise<boolean> {
    try {
      await fs.promises.access(p);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * List all .jsonl session files across all storage directories.
   */
  async listAllSessions(maxAgeDays: number = 7): Promise<SessionSummary[]> {
    await this.ensureDiscovered();
    const summaries: SessionSummary[] = [];
    const cutoff = maxAgeDays > 0 ? Date.now() - maxAgeDays * 86400000 : 0;
    const BATCH_SIZE = 8;

    for (const dir of this.storageDirs) {
      try {
        const files = (await fs.promises.readdir(dir.path)).filter(f => f.endsWith('.jsonl') || f.endsWith('.json'));
        for (let i = 0; i < files.length; i += BATCH_SIZE) {
          const batch = files.slice(i, i + BATCH_SIZE);
          const results = await Promise.all(
            batch.map(async (file) => {
              const filePath = path.join(dir.path, file);
              try {
                return await this.parseSessionFile(filePath, dir.type);
              } catch (e) {
                // Skip unparseable files
                console.warn(`Failed to parse ${filePath}:`, e);
                return null;
              }
            })
          );

          for (const summary of results) {
            if (summary && summary.requestCount > 0 && summary.creationDate >= cutoff) {
              summaries.push(summary);
            }
          }

          // Yield between batches to keep the extension responsive.
          await this.yieldToEventLoop();
        }
      } catch {
        // Directory access error
      }
    }

    // Sort by creation date, newest first
    summaries.sort((a, b) => b.creationDate - a.creationDate);
    return summaries;
  }

  /**
   * Unwrap the operation log format.
   * JSONL lines use `{ kind: 0, v: { ...sessionData } }` for the initial state.
   * kind=0 is the full session snapshot; subsequent lines are mutations.
   */
  private unwrapOperationLog(parsed: unknown): SerializableChatData | null {
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }

    const obj = parsed as Record<string, unknown>;

    // Operation log format: { kind: number, v: object }
    if ('kind' in obj && 'v' in obj) {
      if (obj.kind === 0 && typeof obj.v === 'object' && obj.v !== null) {
        return obj.v as SerializableChatData;
      }
      // Non-initial mutations — skip for summary purposes
      return null;
    }

    // Legacy flat format: the object IS the session data
    if ('sessionId' in obj) {
      return obj as unknown as SerializableChatData;
    }

    return null;
  }

  /**
   * Parse a session .jsonl file, replaying mutations for accurate counts.
   */
  private async parseSessionFile(
    filePath: string,
    storageType: SessionSummary['storageType']
  ): Promise<SessionSummary | null> {
    const [stat, data] = await Promise.all([
      fs.promises.stat(filePath),
      this.readFullSession(filePath),
    ]);

    if (!data || !data.requests) {
      return null;
    }

    const modelIds = new Set<string>();
    const agents = new Set<string>();
    let totalTokens = 0;
    let hasVotes = false;
    let lastMessage: string | undefined;

    for (const req of data.requests) {
      if (req.modelId) {
        modelIds.add(req.modelId);
      }
      if (req.agent?.id || req.agent?.agentId) {
        agents.add(req.agent.id || req.agent.agentId || '');
      }
      if (req.usage?.totalTokens) {
        totalTokens += req.usage.totalTokens;
      }
      if (req.vote) {
        hasVotes = true;
      }
      if (req.message?.text) {
        lastMessage = req.message.text;
      }
    }

    return {
      sessionId: data.sessionId,
      filePath,
      title: data.customTitle,
      creationDate: data.creationDate || stat.mtimeMs,
      requestCount: data.requests.length,
      lastMessage: lastMessage?.substring(0, 120),
      modelIds: [...modelIds],
      agents: [...agents],
      totalTokens,
      hasVotes,
      fileSize: stat.size,
      storageType,
      workspacePath: storageType === 'workspace' ? await this.resolveWorkspacePath(filePath) : '',
    };
  }

  /**
   * Read the full session data from a .jsonl file,
   * replaying the mutation log to reconstruct final state.
   */
  async readFullSession(filePath: string): Promise<SerializableChatData | null> {
    let lines: string[];
    try {
      lines = await this.readAllNonEmptyLines(filePath);
    } catch {
      return null;
    }

    if (lines.length === 0) {
      return null;
    }

    // Parse the first line as the initial snapshot
    let state: SerializableChatData | null = null;
    try {
      const first = JSON.parse(lines[0]);
      state = this.unwrapOperationLog(first);
    } catch {
      // Try legacy single-JSON format
      try {
        const content = await fs.promises.readFile(filePath, 'utf-8');
        return this.unwrapOperationLog(JSON.parse(content));
      } catch {
        return null;
      }
    }

    if (!state) {
      return null;
    }

    // Apply subsequent mutation lines
    for (let i = 1; i < lines.length; i++) {
      try {
        const entry = JSON.parse(lines[i]) as MutationEntry;
        this.applyMutation(state, entry);
      } catch {
        // Skip malformed mutation lines
      }
    }

    return state;
  }

  /**
   * Apply a single mutation entry to the session state object.
   */
  private applyMutation(state: unknown, entry: MutationEntry): void {
    if (typeof state !== 'object' || state === null) { return; }
    const stateObj = state as Record<string, unknown>;

    if (entry.kind === 0) {
      // Another initial snapshot (compaction) — replace state contents
      if (typeof entry.v === 'object' && entry.v !== null) {
        const v = entry.v as Record<string, unknown>;
        for (const key of Object.keys(stateObj)) {
          delete stateObj[key];
        }
        Object.assign(stateObj, v);
      }
      return;
    }

    if (entry.kind === 1) {
      // Set: traverse path and set value
      const { k, v } = entry;
      if (!k || k.length === 0) { return; }
      const parent = this.traversePath(state, k.slice(0, -1));
      if (parent && typeof parent === 'object') {
        (parent as Record<string | number, unknown>)[k[k.length - 1]] = v;
      }
      return;
    }

    if (entry.kind === 2) {
      // Push/splice: traverse to target array
      const { k, v, i } = entry;
      if (!k || k.length === 0) { return; }
      const target = this.traversePath(state, k);
      if (!Array.isArray(target)) { return; }
      if (typeof i === 'number') {
        target.splice(i);
      }
      if (v && Array.isArray(v)) {
        target.push(...v);
      }
      return;
    }

    if (entry.kind === 3) {
      // Delete: traverse path and delete property
      const { k } = entry;
      if (!k || k.length === 0) { return; }
      const parent = this.traversePath(state, k.slice(0, -1));
      if (parent && typeof parent === 'object') {
        const lastKey = k[k.length - 1];
        if (Array.isArray(parent) && typeof lastKey === 'number') {
          parent.splice(lastKey, 1);
        } else {
          delete (parent as Record<string | number, unknown>)[lastKey];
        }
      }
    }
  }

  /**
   * Walk into a nested object following a path of keys.
   */
  private traversePath(obj: unknown, path: (string | number)[]): unknown {
    let current = obj;
    for (const key of path) {
      if (current == null || typeof current !== 'object') {
        return undefined;
      }
      current = (current as Record<string | number, unknown>)[key];
    }
    return current;
  }

  /**
   * Read all non-empty lines from a JSONL file.
   */
  private async readAllNonEmptyLines(filePath: string): Promise<string[]> {
    const content = await fs.promises.readFile(filePath, 'utf-8');
    return content.split('\n').filter(l => l.trim().length > 0);
  }

  /**
   * Read raw JSONL lines for inspection.
   */
  async readRawLines(filePath: string): Promise<string[]> {
    return this.readAllNonEmptyLines(filePath);
  }



  /**
   * Resolve workspace folder path from workspace.json next to the chatSessions dir.
   * Returns a short folder name or storage type label.
   */
  private async resolveWorkspacePath(sessionFilePath: string): Promise<string> {
    const chatSessionsDir = path.dirname(sessionFilePath);
    const workspaceHashDir = path.dirname(chatSessionsDir);
    const workspaceJsonPath = path.join(workspaceHashDir, 'workspace.json');
    try {
      const content = await fs.promises.readFile(workspaceJsonPath, 'utf-8');
      const data = JSON.parse(content);
      if (data.folder && typeof data.folder === 'string') {
        // "file:///Users/user/project" → "project"
        const folderUrl = new URL(data.folder);
        return path.basename(folderUrl.pathname);
      }
    } catch {
      // Not a workspace storage dir (global/transferred) or unreadable
    }
    return '';
  }

  /**
   * Get storage directory stats for the welcome view.
   */
  async getStorageStats(): Promise<{ totalDirs: number; userDir: string; paths: string[] }> {
    await this.ensureDiscovered();
    return {
      totalDirs: this.storageDirs.length,
      userDir: this.userDir,
      paths: this.storageDirs.map(d => d.path),
    };
  }

  private async yieldToEventLoop(): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, 0));
  }
}
