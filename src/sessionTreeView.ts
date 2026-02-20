import * as vscode from 'vscode';
import { ChatDatabase } from './database';
import { SessionSummary, TurnRow } from './types';

export type ViewMode = 'sessions' | 'recent';
export type SortBy = 'date' | 'turns' | 'name';
export type FilterType = 'all' | 'current' | 'workspace' | 'global' | 'transferred';

type TreeItem = CategoryItem | SessionItem | DetailItem | SessionHeaderItem | MessageItem | MessageDetailItem;

export class SessionTreeProvider implements vscode.TreeDataProvider<TreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<TreeItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  // sessions-mode state
  private _sessions: SessionSummary[] = [];

  // recent-mode state
  private _recentSessions: { summary: SessionSummary; turns: TurnRow[] }[] = [];
  private _recentLoading = false;
  private _recentLoadingDone = false;
  private _recentGeneration = 0;

  // view state
  private _viewMode: ViewMode = 'sessions';
  private _sortBy: SortBy = 'date';
  private _filterType: FilterType = 'all';
  private _filterDays = 0;
  private _currentWorkspaceName: string | undefined;

  constructor(private readonly db: ChatDatabase) {}

  get viewMode(): ViewMode { return this._viewMode; }
  get sortBy(): SortBy { return this._sortBy; }
  get filterType(): FilterType { return this._filterType; }
  get filterDays(): number { return this._filterDays; }

  setCurrentWorkspace(name: string | undefined): void {
    this._currentWorkspaceName = name;
  }

  setViewMode(mode: ViewMode): void {
    this._viewMode = mode;
    this.refresh();
  }

  setSortBy(sort: SortBy): void {
    this._sortBy = sort;
    this._sessions = [];
    this._recentSessions = [];
    this._recentLoadingDone = false;
    this._recentLoading = false;
    this._recentGeneration++;
    this._onDidChangeTreeData.fire();
  }

  setFilter(type: FilterType, days: number): void {
    this._filterType = type;
    this._filterDays = days;
    this._sessions = [];
    this._recentSessions = [];
    this._recentLoadingDone = false;
    this._recentLoading = false;
    this._recentGeneration++;
    this._onDidChangeTreeData.fire();
  }

  refresh(): void {
    this._sessions = [];
    this._recentSessions = [];
    this._recentLoading = false;
    this._recentLoadingDone = false;
    this._recentGeneration++;
    this._onDidChangeTreeData.fire();
  }

  async getChildren(element?: TreeItem): Promise<TreeItem[]> {
    if (!element) {
      if (this._viewMode === 'recent') {
        return this._getRecentRoot();
      }
      return this._getSessionsRoot();
    }

    if (element instanceof CategoryItem) {
      return element.sessions.map(s => new SessionItem(s));
    }
    if (element instanceof SessionItem) {
      return this._getSessionDetails(element.session);
    }
    if (element instanceof SessionHeaderItem) {
      return element.turns.map((turn, i) => new MessageItem(turn, i, element.turns.length));
    }
    if (element instanceof MessageItem) {
      return this._getTurnDetails(element.turn);
    }
    return [];
  }

  getTreeItem(element: TreeItem): vscode.TreeItem {
    return element;
  }

  private async _getSessionsRoot(): Promise<TreeItem[]> {
    if (this._sessions.length === 0) {
      const opts = this._buildListOpts();
      this._sessions = await this.db.listSessions(opts);
      this._applySortSessions(this._sessions);
    }

    if (this._sessions.length === 0) {
      return [new DetailItem('No sessions found', 'Check storage paths', '$(warning)')];
    }

    const grouped = new Map<string, SessionSummary[]>();
    for (const s of this._sessions) {
      let key: string;
      if (s.storageType === 'workspace') {
        key = s.workspacePath || 'Unknown Workspace';
      } else if (s.storageType === 'global') {
        key = 'Empty Window';
      } else {
        key = 'Transferred';
      }
      if (!grouped.has(key)) { grouped.set(key, []); }
      grouped.get(key)!.push(s);
    }

    const categories: CategoryItem[] = [];
    for (const [name, sessions] of grouped) {
      const icon = sessions[0].storageType === 'workspace' ? 'folder' :
        sessions[0].storageType === 'global' ? 'globe' : 'arrow-swap';
      categories.push(new CategoryItem(`${name} (${sessions.length})`, sessions, icon));
    }
    return categories;
  }

  private _buildListOpts(): { maxAgeDays?: number; storageType?: string; workspacePath?: string } {
    const opts: { maxAgeDays?: number; storageType?: string; workspacePath?: string } = {};
    if (this._filterType === 'current') {
      opts.workspacePath = this._currentWorkspaceName;
    } else if (this._filterType !== 'all') {
      opts.storageType = this._filterType;
    }
    if (this._filterDays > 0) { opts.maxAgeDays = this._filterDays; }
    return opts;
  }

  private _applySortSessions(sessions: SessionSummary[]): void {
    if (this._sortBy === 'date') { return; } // already sorted DESC by DB
    if (this._sortBy === 'turns') {
      sessions.sort((a, b) => b.requestCount - a.requestCount);
    } else {
      sessions.sort((a, b) => {
        const aName = (a.title || a.lastMessage || a.sessionId).toLowerCase();
        const bName = (b.title || b.lastMessage || b.sessionId).toLowerCase();
        return aName.localeCompare(bName);
      });
    }
  }

  private _getRecentRoot(): TreeItem[] {
    if (!this._recentLoading && !this._recentLoadingDone) {
      this._startRecentLoading();
    }
    const items: TreeItem[] = this._recentSessions.map(
      s => new SessionHeaderItem(s.summary, s.turns),
    );
    if (this._recentLoading) {
      items.push(new MessageDetailItem(
        'Loading…',
        `${this._recentSessions.length} sessions loaded`,
        'loading~spin',
      ));
    } else if (items.length === 0) {
      items.push(new MessageDetailItem('No sessions found', 'Refresh to scan', 'warning'));
    }
    return items;
  }

  private _startRecentLoading(): void {
    this._recentLoading = true;
    const generation = this._recentGeneration;
    this._loadRecentSessions(generation).then(() => {
      if (this._recentGeneration !== generation) { return; }
      this._recentLoading = false;
      this._recentLoadingDone = true;
      this._onDidChangeTreeData.fire();
    }).catch(() => {
      if (this._recentGeneration !== generation) { return; }
      this._recentLoading = false;
      this._onDidChangeTreeData.fire();
    });
  }

  private async _loadRecentSessions(generation: number): Promise<void> {
    const opts = { ...this._buildListOpts(), limit: 10 };
    const summaries = await this.db.listSessions(opts);
    if (this._recentGeneration !== generation) { return; }

    const BATCH_SIZE = 3;
    for (let i = 0; i < summaries.length; i += BATCH_SIZE) {
      if (this._recentGeneration !== generation) { return; }
      const batch = summaries.slice(i, i + BATCH_SIZE);
      const results = await Promise.all(
        batch.map(async (summary) => {
          const turns = await this.db.getSessionTurns(summary.sessionId);
          return turns.length > 0 ? { summary, turns } : null;
        }),
      );
      if (this._recentGeneration !== generation) { return; }
      for (const result of results) {
        if (result) { this._recentSessions.push(result); }
      }
      this._onDidChangeTreeData.fire();
    }
  }

  private _getSessionDetails(session: SessionSummary): DetailItem[] {
    const items: DetailItem[] = [];
    const date = new Date(session.creationDate);
    const rel = relativeTime(date);

    items.push(new DetailItem('Created', `${date.toLocaleDateString()} ${date.toLocaleTimeString()} (${rel})`, '$(calendar)'));
    items.push(new DetailItem('Turns', `${session.requestCount} exchanges`, '$(comment-discussion)'));
    items.push(new DetailItem('File size', formatBytes(session.fileSize), '$(file-binary)'));
    if (session.modelIds.length > 0) {
      items.push(new DetailItem('Models', session.modelIds.join(', '), '$(hubot)'));
    }
    if (session.agents.length > 0) {
      items.push(new DetailItem('Agents', session.agents.join(', '), '$(person)'));
    }
    if (session.totalTokens > 0) {
      items.push(new DetailItem('Tokens', session.totalTokens.toLocaleString(), '$(pulse)'));
    }
    if (session.hasVotes) {
      items.push(new DetailItem('Has votes', 'Yes', '$(thumbsup)'));
    }
    if (session.lastMessage) {
      items.push(new DetailItem('Last prompt', session.lastMessage, '$(quote)'));
    }
    items.push(new DetailItem('Session ID', session.sessionId, '$(key)'));
    items.push(new DetailItem('Storage', session.storageType, '$(database)'));
    return items;
  }

  private _getTurnDetails(turn: TurnRow): MessageDetailItem[] {
    const details: MessageDetailItem[] = [];
    if (turn.promptText) {
      const text = turn.promptText;
      details.push(new MessageDetailItem(
        'Prompt',
        text.length > 200 ? text.substring(0, 200) + '...' : text,
        'quote',
      ));
    }
    if (turn.model) { details.push(new MessageDetailItem('Model', turn.model, 'hubot')); }
    if (turn.agent) { details.push(new MessageDetailItem('Agent', turn.agent, 'person')); }
    if (turn.responseText) {
      const preview = turn.responseText.length > 300
        ? turn.responseText.substring(0, 300) + '...'
        : turn.responseText;
      details.push(new MessageDetailItem('Response', preview, 'markdown'));
    }
    if (turn.tokenTotal) {
      const tokens = [
        `total: ${turn.tokenTotal}`,
        turn.tokenPrompt ? `prompt: ${turn.tokenPrompt}` : null,
        turn.tokenCompletion ? `completion: ${turn.tokenCompletion}` : null,
      ].filter(Boolean).join(', ');
      details.push(new MessageDetailItem('Tokens', tokens, 'pulse'));
    }
    if (turn.durationMs) {
      details.push(new MessageDetailItem('Duration', `${(turn.durationMs / 1000).toFixed(1)}s`, 'clock'));
    }
    if (turn.vote) {
      details.push(new MessageDetailItem(
        'Feedback',
        turn.vote === 1 ? '👍 Upvoted' : '👎 Downvoted',
        'feedback',
      ));
    }
    if (turn.timestamp) {
      details.push(new MessageDetailItem('Time', new Date(turn.timestamp).toLocaleString(), 'calendar'));
    }
    return details;
  }
}

function relativeTime(date: Date): string {
  const diff = Date.now() - date.getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) { return 'just now'; }
  if (minutes < 60) { return `${minutes}m ago`; }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) { return `${hours}h ago`; }
  const days = Math.floor(hours / 24);
  if (days < 30) { return `${days}d ago`; }
  return `${Math.floor(days / 30)}mo ago`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) { return `${bytes} B`; }
  if (bytes < 1048576) { return `${(bytes / 1024).toFixed(1)} KB`; }
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

class CategoryItem extends vscode.TreeItem {
  constructor(
    label: string,
    public readonly sessions: SessionSummary[],
    icon: string = 'folder'
  ) {
    super(label, vscode.TreeItemCollapsibleState.Expanded);
    this.iconPath = new vscode.ThemeIcon(icon);
    this.contextValue = 'category';
  }
}

export class SessionItem extends vscode.TreeItem {
  constructor(public readonly session: SessionSummary) {
    const label = session.title || session.lastMessage || session.sessionId.substring(0, 8);
    super(label, vscode.TreeItemCollapsibleState.Collapsed);

    const date = new Date(session.creationDate);
    const turns = session.requestCount;
    const model = session.modelIds[0] || '';

    this.description = `${turns} turns · ${model}`;
    this.tooltip = new vscode.MarkdownString([
      `**${label}**`,
      '',
      `- **Created**: ${date.toLocaleString()}`,
      `- **Turns**: ${turns}`,
      `- **Models**: ${session.modelIds.join(', ') || 'unknown'}`,
      `- **Agents**: ${session.agents.join(', ') || 'none'}`,
      `- **Tokens**: ${session.totalTokens.toLocaleString()}`,
      `- **File**: ${session.filePath}`,
    ].join('\n'));

    this.iconPath = new vscode.ThemeIcon(
      turns > 10 ? 'comment-unresolved' : 'comment',
      turns > 20
        ? new vscode.ThemeColor('charts.red')
        : turns > 5
          ? new vscode.ThemeColor('charts.yellow')
          : undefined
    );

    this.contextValue = 'session';
  }
}

class DetailItem extends vscode.TreeItem {
  constructor(label: string, value: string, icon: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = value;
    this.iconPath = new vscode.ThemeIcon(icon.replace('$(', '').replace(')', ''));
    this.contextValue = 'detail';
  }
}

class SessionHeaderItem extends vscode.TreeItem {
  constructor(
    public readonly summary: SessionSummary,
    public readonly turns: TurnRow[],
  ) {
    const title = summary.title || summary.lastMessage || summary.sessionId.substring(0, 8);
    super(title, vscode.TreeItemCollapsibleState.Collapsed);

    const date = new Date(summary.creationDate);
    const turnCount = turns.length;
    this.description = `${turnCount} turns · ${relativeTime(date)}`;
    this.tooltip = new vscode.MarkdownString([
      `**${title}**`,
      '',
      `Created: ${date.toLocaleString()}`,
      `Turns: ${turnCount}`,
      `Session ID: ${summary.sessionId}`,
    ].join('\n'));
    this.iconPath = new vscode.ThemeIcon('comment-discussion');
    this.contextValue = 'sessionHeader';
  }
}

class MessageItem extends vscode.TreeItem {
  constructor(public readonly turn: TurnRow, index: number, total: number) {
    const prompt = turn.promptText || '(empty prompt)';
    const label = prompt.length > 80 ? prompt.substring(0, 80) + '...' : prompt;
    super(label, vscode.TreeItemCollapsibleState.Collapsed);

    this.description = `#${index + 1}/${total}`;
    this.iconPath = new vscode.ThemeIcon(
      turn.responseText ? 'arrow-swap' : 'arrow-right',
      turn.vote
        ? new vscode.ThemeColor(turn.vote === 1 ? 'charts.green' : 'charts.red')
        : undefined,
    );
    this.contextValue = 'message';
  }
}

class MessageDetailItem extends vscode.TreeItem {
  constructor(label: string, value: string, icon: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = value;
    this.iconPath = new vscode.ThemeIcon(icon);
    this.contextValue = 'messageDetail';
    this.tooltip = value;
  }
}
