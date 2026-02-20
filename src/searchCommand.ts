import * as vscode from 'vscode';
import { ChatDatabase } from './database';
import { SearchResult } from './types';
import { relativeTime } from './utils';

interface SearchResultItem extends vscode.QuickPickItem {
  result: SearchResult;
}

export function registerSearchCommand(
  context: vscode.ExtensionContext,
  db: ChatDatabase,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('sessionTrace.search', async () => {
      const quickPick = vscode.window.createQuickPick<SearchResultItem>();
      quickPick.placeholder = 'Search conversations (prompts, responses, titles)…';
      quickPick.matchOnDescription = true;
      quickPick.matchOnDetail = true;

      quickPick.show();

      let searchTimer: ReturnType<typeof setTimeout> | undefined;

      quickPick.onDidChangeValue((value) => {
        // Debounce to avoid hammering SQLite on every keystroke
        if (searchTimer) { clearTimeout(searchTimer); }
        if (!value.trim()) {
          quickPick.items = [];
          return;
        }
        searchTimer = setTimeout(async () => {
          quickPick.busy = true;
          try {
            const results = await db.search(value, { limit: 30 });
            quickPick.items = results.map((r) => {
              const timeAgo = relativeTime(r.timestamp);
              const label = r.promptText
                ? r.promptText.substring(0, 100).replace(/\n/g, ' ')
                : '(empty prompt)';
              const description = timeAgo;

              const parts: string[] = [];
              if (r.sessionTitle) {
                parts.push(r.sessionTitle.substring(0, 40));
              }
              if (r.workspacePath) {
                parts.push(`$(folder) ${r.workspacePath}`);
              } else if (r.storageType === 'global') {
                parts.push('$(globe) Empty Window');
              } else if (r.storageType === 'transferred') {
                parts.push('$(arrow-swap) Transferred');
              }
              parts.push(`Turn ${r.turnIndex + 1}`);
              if (r.model) {
                parts.push(r.model);
              }
              const detail = parts.join(' · ');

              return { label, description, detail, result: r };
            });
          } catch {
            // Gracefully handle FTS errors (e.g. bad query syntax)
          } finally {
            quickPick.busy = false;
          }
        }, 150);
      });

      quickPick.onDidAccept(async () => {
        const selected = quickPick.selectedItems[0];
        if (!selected) {
          return;
        }

        quickPick.dispose();

        const doc = await vscode.workspace.openTextDocument(
          vscode.Uri.file(selected.result.filePath)
        );
        await vscode.window.showTextDocument(doc, { preview: true });
      });

      quickPick.onDidHide(() => {
        if (searchTimer) { clearTimeout(searchTimer); }
        quickPick.dispose();
      });
    })
  );
}

