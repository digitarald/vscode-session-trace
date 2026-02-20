/**
 * Type definitions for VS Code's serialized chat session data.
 * Based on ISerializableChatData v3 from chatModel.ts in microsoft/vscode.
 *
 * The .jsonl files use an operation log format where:
 * - Line 1 is the full initial session state
 * - Subsequent lines are incremental mutations
 */

/** Top-level session structure (v3) */
export interface SerializableChatData {
  version: number;
  sessionId: string;
  creationDate: number;
  customTitle?: string;
  initialLocation?: number; // ChatAgentLocation enum
  responderUsername?: string;
  requests: SerializableChatRequest[];
  pendingRequests?: SerializableChatRequest[];
  inputState?: string; // JSON-stringified input state
  hasPendingEdits?: boolean;
  repoData?: unknown;
}

/** A single request/response exchange */
export interface SerializableChatRequest {
  requestId?: string;
  timestamp?: number;
  message: SerializableParsedChatRequest;
  variableData?: SerializableVariableData;
  response: SerializableChatResponsePart[];
  result?: SerializableChatResult;
  agent?: SerializableChatAgent;
  confirmation?: string;
  shouldBeRemovedOnSend?: boolean;
  vote?: number; // 1 = up, 2 = down
  voteDownReason?: string;
  followups?: SerializableChatFollowup[];
  usage?: ChatTokenUsage;
  modelId?: string;
}

/** Parsed user message */
export interface SerializableParsedChatRequest {
  text: string;
  parts?: unknown[];
}

/** Variable/context data attached to a request */
export interface SerializableVariableData {
  variables?: SerializableChatVariable[];
}

export interface SerializableChatVariable {
  id: string;
  name: string;
  value?: unknown;
  range?: { start: number; endExclusive: number };
  fullName?: string;
  icon?: unknown;
}

/** Response content parts - discriminated by "kind" */
export interface SerializableChatResponsePart {
  kind: string;
  content?: unknown;
  [key: string]: unknown;
}

/** Result metadata */
export interface SerializableChatResult {
  errorDetails?: { message: string; responseIsIncomplete?: boolean };
  timings?: { totalElapsed: number };
  metadata?: Record<string, unknown>;
}

/** Agent/participant info */
export interface SerializableChatAgent {
  id?: string;
  agentId?: string;
  metadata?: { description?: string };
}

/** Followup suggestions */
export interface SerializableChatFollowup {
  kind: string;
  message?: string;
  title?: string;
}

/** Token usage */
export interface ChatTokenUsage {
  totalTokens?: number;
  promptTokens?: number;
  completionTokens?: number;
}

// --- Operation log mutation types ---

/** Path into a nested object structure, e.g. ["requests", 0, "response"] */
export type ObjectPath = (string | number)[];

/** Discriminated union of operation log entries in .jsonl files */
export type MutationEntry =
  | { kind: 0; v: unknown }                                       // Initial snapshot
  | { kind: 1; k: ObjectPath; v: unknown }                         // Set property
  | { kind: 2; k: ObjectPath; v?: unknown[]; i?: number }          // Push / splice array
  | { kind: 3; k: ObjectPath };                                    // Delete property

/** Session index entry (from StorageService) */
export interface ChatSessionIndexEntry {
  sessionId: string;
  title?: string;
  lastMessageDate: number;
  timing: {
    created: number;
    lastRequestStarted?: number;
    lastRequestEnded?: number;
  };
  initialLocation?: number;
  isExternal?: boolean;
  isEmpty?: boolean;
  hasPendingEdits?: boolean;
}

/** Session index (stored in LevelDB) */
export interface ChatSessionIndex {
  version: number;
  entries: Record<string, ChatSessionIndexEntry>;
}

/** Flat entry for full-text search indexing (one per turn) */
export interface SearchableEntry {
  sessionId: string;
  filePath: string;
  sessionTitle: string;
  generatedTitle: string;
  turnIndex: number;
  promptText: string;
  responseText: string;
  agent: string;
  model: string;
  timestamp: number;
  storageType: string;
  workspacePath: string;
}

/** Summary info we extract for tree display */
export interface SessionSummary {
  sessionId: string;
  filePath: string;
  title?: string;
  creationDate: number;
  requestCount: number;
  lastMessage?: string;
  modelIds: string[];
  agents: string[];
  totalTokens: number;
  hasVotes: boolean;
  fileSize: number;
  storageType: 'workspace' | 'global' | 'transferred';
  workspacePath: string;
}

// --- SQLite database types ---

/** A turn row as stored in the `turns` table. */
export interface TurnRow {
  id?: number;
  sessionId: string;
  turnIndex: number;
  promptText: string;
  responseText: string;
  agent: string;
  model: string;
  timestamp: number;
  durationMs: number;
  tokenTotal: number;
  tokenPrompt: number;
  tokenCompletion: number;
  vote: number | null;
}

/** An annotation row as stored in the `annotations` table. */
export interface AnnotationRow {
  id?: number;
  turnId: number;
  kind: string;
  name: string;
  uri: string;
  detail: string;
}

/** A structured annotation extracted from a response part during indexing. */
export interface ExtractedAnnotation {
  kind: string;
  name: string;
  uri: string;
  detail: string;
}

/** Result of extracting response parts: flattened text + structured annotations. */
export interface ExtractedResponse {
  text: string;
  annotations: ExtractedAnnotation[];
}

/** Search result returned by the database FTS query. */
export interface SearchResult {
  sessionId: string;
  filePath: string;
  sessionTitle: string;
  workspacePath: string;
  storageType: string;
  turnIndex: number;
  promptText: string;
  responseText: string;
  agent: string;
  model: string;
  timestamp: number;
  durationMs: number;
  rank: number;
}
