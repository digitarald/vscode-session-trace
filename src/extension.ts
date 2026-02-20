import * as vscode from 'vscode';
import * as path from 'path';
import { JsonlSessionReader } from './jsonlReader';
import { ChatDatabase } from './database';
import { Indexer } from './indexer';
import { SessionTreeProvider, SessionItem, SortBy, FilterType } from './sessionTreeView';
import { registerSearchCommand } from './searchCommand';
import { relativeTime, escapeHtml } from './utils';
import { SearchChatSessionsTool } from './searchChatSessionsTool';

let db: ChatDatabase;

const escapeMarkdownInline = (value: string): string =>
  escapeHtml(value).replace(/[`|*_]/g, '\\$&');

const formatCodeSpan = (value: string): string => {
  const safe = value.replace(/[\r\n]+/g, ' ');
  const matches = safe.match(/`+/g) ?? [''];
  const maxTicks = matches.reduce((max, current) => Math.max(max, current.length), 0);
  const ticks = '`'.repeat(maxTicks + 1);
  return `${ticks}${safe}${ticks}`;
};

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

  // updateViewDescription is defined later but we need to set it after indexing;
  // defer so the description reflects defaults on first paint
  queueMicrotask(() => updateViewDescription?.());

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
  const searchTool = new SearchChatSessionsTool(db);
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

    vscode.commands.registerCommand('sessionTrace.openSessionMarkdown', async (item: SessionItem) => {
      let session: Awaited<ReturnType<typeof reader.readFullSession>>;
      let rawLines: Awaited<ReturnType<typeof reader.readRawLines>>;
      try {
        [session, rawLines] = await Promise.all([
          reader.readFullSession(item.session.filePath),
          reader.readRawLines(item.session.filePath),
        ]);
      } catch (err) {
        vscode.window.showErrorMessage(`Failed to read session: ${err}`);
        return;
      }
      if (!session) {
        vscode.window.showErrorMessage('Failed to read session');
        return;
      }

      const rawTitle = (session.customTitle || session.sessionId).replace(/[\r\n]+/g, ' ');
      const title = escapeHtml(rawTitle);
      const creationDate = new Date(session.creationDate);
      const allModelsRaw = [...new Set(session.requests.map(r => r.modelId).filter(Boolean))].join(', ');
      const allAgentsRaw = [...new Set(session.requests.map(r => r.agent?.id || r.agent?.agentId).filter(Boolean))].join(', ');
      const allModels = allModelsRaw ? escapeHtml(allModelsRaw).replace(/\|/g, '\\|') : '—';
      const allAgents = allAgentsRaw ? escapeHtml(allAgentsRaw).replace(/\|/g, '\\|') : '—';
      const totalTokens = session.requests.reduce((sum, r) => sum + (r.usage?.totalTokens ?? 0), 0);

      const normalizeFileEdit = (raw: string): { key: string; label: string } | null => {
        const trimmed = raw.trim();
        if (!trimmed) { return null; }
        if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) {
          try {
            const parsed = vscode.Uri.parse(trimmed);
            const fsPath = parsed.fsPath || parsed.path || trimmed;
            return { key: fsPath, label: path.basename(fsPath) };
          } catch {
            return null;
          }
        }
        let decoded = trimmed;
        try { decoded = decodeURIComponent(trimmed); } catch { /* ignore */ }
        const cleaned = decoded.replace(/\\/g, '/');
        return { key: cleaned, label: path.posix.basename(cleaned) || cleaned };
      };


      const lines: string[] = [
        `# 💬 ${title}`,
        '',
        '| | |',
        '|---|---|',
        `| **Created** | ${creationDate.toLocaleString()} *(${relativeTime(session.creationDate)})* |`,
        `| **Turns** | ${session.requests.length} |`,
        `| **Models** | ${allModels} |`,
        `| **Agents** | ${allAgents} |`,
        ...(totalTokens > 0 ? [`| **Tokens** | ${totalTokens.toLocaleString()} |`] : []),
        '',
        '---',
        '',
      ];

      const total = session.requests.length;
      for (let i = 0; i < total; i++) {
        const req = session.requests[i];
        const model = req.modelId || '';
        const agentId = req.agent?.id || req.agent?.agentId || '';
        const turnLabel = `Turn ${i + 1} of ${total}`;
        lines.push(`## ${turnLabel}`);
        lines.push('');

        // User prompt
        lines.push('**👤 User**');
        lines.push('');
        const promptText = escapeHtml(req.message?.text || '*(empty)*');
        // Indent each line of the prompt as a blockquote; preserve blank lines within the block
        for (const promptLine of promptText.split('\n')) {
          lines.push(promptLine ? `> ${promptLine}` : '>');
        }
        lines.push('');

        // Check for context variables
        if (req.variableData?.variables && req.variableData.variables.length > 0) {
          const vars = req.variableData.variables.map(v => formatCodeSpan(v.name)).join(', ');
          lines.push(`*Context: ${vars}*`);
          lines.push('');
        }

        // Assistant response
        const assistantLabelRaw = [model, agentId ? `@${agentId}` : ''].filter(Boolean).join(' · ');
        const assistantLabel = escapeHtml(assistantLabelRaw).replace(/_/g, '\\_');
        lines.push(`**🤖 Assistant**${assistantLabel ? ` *(${assistantLabel})*` : ''}`);
        lines.push('');

        // Collect parts for separate sections
        const tools: Array<{ name: string; detail: string }> = [];
        const thinkingBlocks: string[] = [];
        const fileEdits: string[] = [];
        const fileEditKeys = new Set<string>();
        const pushFileEdit = (raw: string) => {
          const normalized = normalizeFileEdit(raw);
          if (!normalized || fileEditKeys.has(normalized.key)) { return; }
          fileEditKeys.add(normalized.key);
          fileEdits.push(escapeMarkdownInline(normalized.label));
        };
        const markdownChunks: string[] = [];

        for (const part of req.response || []) {
          switch (part.kind) {
            case 'markdownContent': {
              const content = part.content;
              const text = typeof content === 'string'
                ? content
                : (content as { value?: string } | null)?.value || '';
              if (text) { markdownChunks.push(escapeHtml(text)); }
              break;
            }
            case 'toolInvocationSerialized': {
              const rec = part as Record<string, unknown>;
              const name = String(rec.toolId || rec.toolName || '');
              const detail = String(rec.invocationMessage || rec.input || '');
              if (name) { tools.push({ name, detail }); }
              break;
            }
            case 'thinking': {
              const content = part.content;
              const text = typeof content === 'string'
                ? content
                : (content as { value?: string } | null)?.value || '';
              if (text) { thinkingBlocks.push(text); }
              break;
            }
            case 'textEditGroup':
            case 'codeblockUri': {
              const uri = part.uri;
              let uriStr = '';
              if (typeof uri === 'string') { uriStr = uri; }
              else if (uri && typeof uri === 'object' && 'path' in uri) { uriStr = (uri as { path: string }).path; }
              if (uriStr) { pushFileEdit(uriStr); }
              break;
            }
          }
        }
        if (markdownChunks.length > 0) {
          lines.push(markdownChunks.join('\n\n'));
          lines.push('');
        } else {
          lines.push('*(no text response)*');
          lines.push('');
        }

        if (tools.length > 0) {
          lines.push(`<details>`);
          lines.push(`<summary>🔧 Tools Used (${tools.length})</summary>`);
          lines.push('');
          for (const t of tools) {
            const safeName = escapeMarkdownInline(t.name);
            const safeDetail = t.detail ? escapeMarkdownInline(t.detail) : '';
            lines.push(safeDetail ? `- **${safeName}** — ${safeDetail}` : `- **${safeName}**`);
          }
          lines.push('');
          lines.push('</details>');
          lines.push('');
        }

        if (thinkingBlocks.length > 0) {
          lines.push('<details>');
          lines.push('<summary>💭 Thinking</summary>');
          lines.push('');
          lines.push(thinkingBlocks.map(b => escapeHtml(b)).join('\n\n'));
          lines.push('');
          lines.push('</details>');
          lines.push('');
        }

        if (fileEdits.length > 0) {
          lines.push(`*📁 File edits: ${fileEdits.join(', ')}*`);
          lines.push('');
        }

        // Per-turn stats as table
        const hasStats = req.usage?.totalTokens || req.result?.timings?.totalElapsed;
        if (hasStats) {
          lines.push('| Tokens | Prompt | Completion | Duration |');
          lines.push('|--------|--------|------------|----------|');
          const tok = req.usage?.totalTokens?.toLocaleString() ?? '—';
          const prompt = req.usage?.promptTokens?.toLocaleString() ?? '—';
          const completion = req.usage?.completionTokens?.toLocaleString() ?? '—';
          const duration = req.result?.timings?.totalElapsed
            ? `${(req.result.timings.totalElapsed / 1000).toFixed(1)}s`
            : '—';
          lines.push(`| ${tok} | ${prompt} | ${completion} | ${duration} |`);
          lines.push('');
        }

        if (req.vote) {
          lines.push(req.vote === 1
            ? '👍 Upvoted'
            : `👎 Downvoted${req.voteDownReason ? ` — ${escapeHtml(req.voteDownReason)}` : ''}`);
          lines.push('');
        }

        if (req.result?.errorDetails?.message) {
          const errLines = req.result.errorDetails.message.split('\n');
          for (const errLine of errLines) {
            lines.push(errLine ? `> ⚠️ **Error**: ${escapeHtml(errLine)}` : '>');
          }
          lines.push('');
        }

        lines.push('---');
        lines.push('');
      }

      lines.push('## 📦 Storage');
      lines.push('');
      lines.push(`- **JSONL lines**: ${rawLines.length} (1 initial + ${Math.max(0, rawLines.length - 1)} mutations)`);
      lines.push(`- **File**: ${formatCodeSpan(item.session.filePath)}`);
      lines.push(`- **Storage type**: ${item.session.storageType}`);
      lines.push(`- **Session ID**: ${formatCodeSpan(session.sessionId)}`);

      const doc = await vscode.workspace.openTextDocument({
        content: lines.join('\n'),
        language: 'markdown',
      });
      await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: true });
      await vscode.commands.executeCommand('markdown.showPreview', doc.uri);
    }),

    vscode.commands.registerCommand('sessionTrace.showSessionDetail', async (item: SessionItem) => {
      const session = await reader.readFullSession(item.session.filePath);
      if (!session) {
        vscode.window.showErrorMessage('Failed to read session');
        return;
      }

      // Show a quick summary in an untitled document
      const sessionTitle = escapeHtml(session.customTitle || session.sessionId);
      const lines: string[] = [
        `# Chat Session: ${sessionTitle}`,
        '',
        `- **Session ID**: ${formatCodeSpan(session.sessionId)}`,
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
        const userModel = req.modelId || 'unknown model';
        lines.push(`**User** (${escapeMarkdownInline(userModel)}):`);
        lines.push('');
        const promptText = escapeHtml(req.message?.text || '(empty)');
        for (const promptLine of promptText.split('\n')) {
          lines.push(promptLine ? `> ${promptLine}` : '>');
        }
        lines.push('');

        if (req.agent?.id || req.agent?.agentId) {
          const agentLabel = (req.agent.id || req.agent.agentId)!;
          lines.push(`*Agent*: ${escapeMarkdownInline(agentLabel)}`);
        }

        if (req.variableData?.variables && req.variableData.variables.length > 0) {
          const vars = req.variableData.variables.map(v => formatCodeSpan(v.name)).join(', ');
          lines.push(`*Context variables*: ${vars}`);
        }

        // Extract text from response parts
        const responseParts: string[] = [];
        for (const part of req.response || []) {
          if (part.kind === 'markdownContent' && part.content) {
            const content = typeof part.content === 'string'
              ? part.content
              : (part.content as { value?: string })?.value || '';
            if (content) {
              responseParts.push(escapeHtml(content.substring(0, 500)));
            }
          } else if (part.kind === 'toolInvocationSerialized') {
            const toolName = String((part as Record<string, unknown>).toolName || 'unknown');
            responseParts.push(`[Tool: ${escapeMarkdownInline(toolName)}]`);
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
          const downReason = req.voteDownReason ? ` (${escapeMarkdownInline(req.voteDownReason)})` : '';
          lines.push(`*Vote*: ${req.vote === 1 ? '👍' : '👎'}${downReason}`);
        }

        lines.push('');
        lines.push('---');
        lines.push('');
      }

      // Show raw JSONL line count
      const rawLines = await reader.readRawLines(item.session.filePath);
      lines.push(`## Storage Info`);
      lines.push('');
      lines.push(`- **JSONL lines**: ${rawLines.length} (1 initial + ${Math.max(0, rawLines.length - 1)} mutations)`);
      lines.push(`- **File**: ${formatCodeSpan(item.session.filePath)}`);
      lines.push(`- **Storage type**: ${escapeMarkdownInline(item.session.storageType)}`);

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
