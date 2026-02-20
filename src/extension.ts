import * as vscode from 'vscode';
import * as path from 'path';
import { JsonlSessionReader } from './jsonlReader';
import { ChatDatabase } from './database';
import { Indexer } from './indexer';
import { SessionTreeProvider, SessionItem, SortBy, FilterType } from './sessionTreeView';
import { registerSearchCommand } from './searchCommand';
import { SessionTraceSearchTool } from './sessionTraceSearchTool';

let db: ChatDatabase;

export async function activate(context: vscode.ExtensionContext) {
  const outputChannel = vscode.window.createOutputChannel('Session Trace');
  context.subscriptions.push(outputChannel);

  // --- JSONL disk reader ---
  const reader = new JsonlSessionReader(context);
  const stats = await reader.getStorageStats();
  outputChannel.appendLine(`User dir: ${stats.userDir}`);
  outputChannel.appendLine(`Found ${stats.totalDirs} chatSessions directories:`);
  for (const p of stats.paths) {
    outputChannel.appendLine(`  ${p}`);
  }

  // --- SQLite database ---
  const storagePath = context.globalStorageUri.fsPath;
  await vscode.workspace.fs.createDirectory(context.globalStorageUri);
  const dbPath = path.join(storagePath, 'chat-history.sqlite');
  db = new ChatDatabase(dbPath);
  await db.open();
  context.subscriptions.push({ dispose: () => { db.close(); } });

  // --- Indexer ---
  const indexer = new Indexer(reader, db);

  // --- Tree view ---
  const sessionTree = new SessionTreeProvider(db);
  const treeView = vscode.window.createTreeView('sessionTrace.jsonlSessions', {
    treeDataProvider: sessionTree,
    showCollapseAll: true,
  });
  context.subscriptions.push(treeView);
  await vscode.commands.executeCommand('setContext', 'sessionTraceViewMode', 'sessions');

  // Seed and track current workspace name for filtering
  const updateWorkspace = () =>
    sessionTree.setCurrentWorkspace(vscode.workspace.workspaceFolders?.[0]?.name);
  updateWorkspace();
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(updateWorkspace));

  // Background reindex on activation
  const indexDone = vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Session Trace', cancellable: false },
    async (progress) => {
      const result = await indexer.reindex(progress);
      outputChannel.appendLine(`Indexed ${result.indexed} sessions, skipped ${result.skipped}, pruned ${result.pruned}`);
      const dbStats = await db.getStats();
      outputChannel.appendLine(`DB stats: ${dbStats.sessions} sessions, ${dbStats.turns} turns, ${dbStats.annotations} annotations`);
      // Refresh views after indexing
      sessionTree.refresh();
    },
  );
  indexDone.then(undefined, (err) => {
    outputChannel.appendLine(`Reindex failed: ${err}`);
  });
  vscode.window.withProgress({ location: { viewId: 'sessionTrace.jsonlSessions' } }, () => indexDone).then(undefined, () => {});

  // --- LM tool for agent search ---
  const searchTool = new SessionTraceSearchTool(db);
  context.subscriptions.push(
    vscode.lm.registerTool(
      'sessionTrace_searchConversations',
      searchTool,
    ),
  );

  // --- Commands ---
  context.subscriptions.push(
    vscode.commands.registerCommand('sessionTrace.refresh', async () => {
      const refreshDone = vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Session Trace', cancellable: false },
        async (progress) => {
          const result = await indexer.reindex(progress);
          outputChannel.appendLine(`Re-indexed ${result.indexed}, skipped ${result.skipped}, pruned ${result.pruned}`);
        },
      );
      vscode.window.withProgress({ location: { viewId: 'sessionTrace.jsonlSessions' } }, () => refreshDone).then(undefined, () => {});
      try {
        await refreshDone;
        vscode.window.showInformationMessage('Chat sessions refreshed');
      } finally {
        sessionTree.refresh();
      }
    }),

    vscode.commands.registerCommand('sessionTrace.openSession', async (item: SessionItem) => {
      const filePath = item.session.filePath;
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
      await vscode.window.showTextDocument(doc, { preview: true });
    }),

    vscode.commands.registerCommand('sessionTrace.copySessionJson', async (item: SessionItem) => {
      const session = await reader.readFullSession(item.session.filePath);
      if (session) {
        await vscode.env.clipboard.writeText(JSON.stringify(session, null, 2));
        vscode.window.showInformationMessage(
          `Copied session "${item.session.title || item.session.sessionId}" to clipboard`
        );
      } else {
        vscode.window.showErrorMessage('Failed to read session data');
      }
    }),

    vscode.commands.registerCommand('sessionTrace.showSessionDetail', async (item: SessionItem) => {
      const session = await reader.readFullSession(item.session.filePath);
      if (!session) {
        vscode.window.showErrorMessage('Failed to read session');
        return;
      }

      // Show a quick summary in an untitled document
      const lines: string[] = [
        `# Chat Session: ${session.customTitle || session.sessionId}`,
        '',
        `- **Session ID**: ${session.sessionId}`,
        `- **Created**: ${new Date(session.creationDate).toLocaleString()}`,
        `- **Turns**: ${session.requests.length}`,
        `- **Version**: ${session.version}`,
        '',
        '---',
        '',
      ];

      for (let i = 0; i < session.requests.length; i++) {
        const req = session.requests[i];
        lines.push(`## Turn ${i + 1}`);
        lines.push('');
        lines.push(`**User** (${req.modelId || 'unknown model'}):`);
        lines.push('');
        lines.push(`> ${req.message?.text || '(empty)'}`);
        lines.push('');

        if (req.agent?.id || req.agent?.agentId) {
          lines.push(`*Agent*: ${req.agent.id || req.agent.agentId}`);
        }

        if (req.variableData?.variables && req.variableData.variables.length > 0) {
          lines.push(`*Context variables*: ${req.variableData.variables.map(v => v.name).join(', ')}`);
        }

        // Extract text from response parts
        const responseParts: string[] = [];
        for (const part of req.response || []) {
          if (part.kind === 'markdownContent' && part.content) {
            const content = typeof part.content === 'string'
              ? part.content
              : (part.content as { value?: string })?.value || '';
            if (content) {
              responseParts.push(content.substring(0, 500));
            }
          } else if (part.kind === 'toolInvocationSerialized') {
            responseParts.push(`[Tool: ${(part as Record<string, unknown>).toolName || 'unknown'}]`);
          } else if (part.kind === 'thinking') {
            responseParts.push(`[Thinking...]`);
          }
        }

        if (responseParts.length > 0) {
          lines.push('');
          lines.push('**Assistant**:');
          lines.push('');
          lines.push(responseParts.join('\n\n'));
        }

        if (req.usage) {
          lines.push('');
          lines.push(`*Tokens*: ${req.usage.totalTokens?.toLocaleString() || '?'} (prompt: ${req.usage.promptTokens?.toLocaleString() || '?'}, completion: ${req.usage.completionTokens?.toLocaleString() || '?'})`);
        }

        if (req.vote) {
          lines.push(`*Vote*: ${req.vote === 1 ? '👍' : '👎'}${req.voteDownReason ? ` (${req.voteDownReason})` : ''}`);
        }

        lines.push('');
        lines.push('---');
        lines.push('');
      }

      // Show raw JSONL line count
      const rawLines = await reader.readRawLines(item.session.filePath);
      lines.push(`## Storage Info`);
      lines.push('');
      lines.push(`- **JSONL lines**: ${rawLines.length} (1 initial + ${rawLines.length - 1} mutations)`);
      lines.push(`- **File**: ${item.session.filePath}`);
      lines.push(`- **Storage type**: ${item.session.storageType}`);

      const doc = await vscode.workspace.openTextDocument({
        content: lines.join('\n'),
        language: 'markdown',
      });
      await vscode.window.showTextDocument(doc, { preview: true });
    }),

  );

  // --- View-mode / sort / filter commands ---
  const updateViewDescription = () => {
    const typeLabels: Record<FilterType, string> = {
      all: '',
      current: 'This workspace',
      workspace: 'All workspaces',
      global: 'Empty Window',
      transferred: 'Transferred',
    };
    const typePart = sessionTree.filterType !== 'all' ? typeLabels[sessionTree.filterType] : '';
    const daysPart = sessionTree.filterDays > 0 ? `last ${sessionTree.filterDays}d` : '';
    const sortPart = sessionTree.sortBy !== 'date'
      ? (sessionTree.sortBy === 'turns' ? 'by turns' : 'by name')
      : '';
    const desc = [typePart, daysPart, sortPart].filter(Boolean).join(' · ');
    treeView.description = desc || undefined;
  };

  type OptionItem = vscode.QuickPickItem & (
    | { action: 'sort'; sort: SortBy }
    | { action: 'filter-type'; type: FilterType }
    | { action: 'filter-days'; days: number }
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('sessionTrace.viewAsRecent', () => {
      sessionTree.setViewMode('recent');
      vscode.commands.executeCommand('setContext', 'sessionTraceViewMode', 'recent');
      updateViewDescription();
    }),

    vscode.commands.registerCommand('sessionTrace.viewAsSessions', () => {
      sessionTree.setViewMode('sessions');
      vscode.commands.executeCommand('setContext', 'sessionTraceViewMode', 'sessions');
      updateViewDescription();
    }),

    vscode.commands.registerCommand('sessionTrace.viewOptions', async () => {
      // Prefix label with check mark (and padding to align non-checked items)
      const check = (active: boolean) => active ? '$(check) ' : '\u00a0\u00a0\u00a0\u00a0';
      const s = sessionTree.sortBy;
      const f = sessionTree.filterType;
      const d = sessionTree.filterDays;
      const hasWorkspace = !!vscode.workspace.workspaceFolders?.length;

      const items: (OptionItem | vscode.QuickPickItem)[] = [
        { kind: vscode.QuickPickItemKind.Separator, label: 'Sort' },
        { label: `${check(s === 'date')}$(calendar) Date (newest first)`,           action: 'sort', sort: 'date' },
        { label: `${check(s === 'turns')}$(comment-discussion) Turns (most first)`, action: 'sort', sort: 'turns' },
        { label: `${check(s === 'name')}$(sort-precedence) Name (A–Z)`,             action: 'sort', sort: 'name' },
        { kind: vscode.QuickPickItemKind.Separator, label: 'Workspace' },
        { label: `${check(f === 'all')}$(list-flat) All sessions`,                  action: 'filter-type', type: 'all' },
        ...(hasWorkspace ? [{ label: `${check(f === 'current')}$(folder-active) This workspace (${vscode.workspace.workspaceFolders![0].name})`, action: 'filter-type' as const, type: 'current' as FilterType }] : []),
        { label: `${check(f === 'workspace')}$(folder) All workspaces`,            action: 'filter-type', type: 'workspace' },
        { label: `${check(f === 'global')}$(globe) Empty Window`,                   action: 'filter-type', type: 'global' },
        { label: `${check(f === 'transferred')}$(arrow-swap) Transferred`,          action: 'filter-type', type: 'transferred' },
        { kind: vscode.QuickPickItemKind.Separator, label: 'Time range' },
        { label: `${check(d === 0)}$(history) All time`,    action: 'filter-days', days: 0 },
        { label: `${check(d === 7)}$(watch) Last 7 days`,   action: 'filter-days', days: 7 },
        { label: `${check(d === 30)}$(watch) Last 30 days`, action: 'filter-days', days: 30 },
        { label: `${check(d === 90)}$(watch) Last 90 days`, action: 'filter-days', days: 90 },
      ];

      const rawPick = await vscode.window.showQuickPick(items, {
        placeHolder: 'Sort or filter sessions…',
        matchOnDescription: false,
      });

      if (!rawPick || rawPick.kind === vscode.QuickPickItemKind.Separator) { return; }
      const pick = rawPick as OptionItem;

      if (pick.action === 'sort') {
        sessionTree.setSortBy(pick.sort);
        updateViewDescription();
      } else if (pick.action === 'filter-type') {
        sessionTree.setFilter(pick.type, sessionTree.filterDays);
        updateViewDescription();
      } else {
        sessionTree.setFilter(sessionTree.filterType, pick.days);
        updateViewDescription();
      }
    }),
  );

  // --- Search ---
  registerSearchCommand(context, db);

  outputChannel.appendLine('Session Trace activated');
}

export function deactivate() {
  return db?.close();
}
