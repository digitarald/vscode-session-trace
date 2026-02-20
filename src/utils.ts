import * as path from 'path';
import { SerializableChatResponsePart, ExtractedAnnotation, ExtractedResponse } from './types';

/**
 * Extract both flattened searchable text and structured annotations from response parts.
 * This is the primary extraction function used during indexing.
 */
export function extractResponseParts(parts: SerializableChatResponsePart[]): ExtractedResponse {
  const texts: string[] = [];
  const annotations: ExtractedAnnotation[] = [];

  for (const part of parts) {
    switch (part.kind) {
      case 'markdownContent': {
        const content = part.content;
        if (typeof content === 'string') {
          texts.push(content);
        } else if (content && typeof content === 'object' && 'value' in content) {
          texts.push((content as { value: string }).value);
        }
        break;
      }
      case 'inlineReference': {
        const ref = part.inlineReference as { name?: string; uri?: string } | undefined;
        const name = ref?.name || '';
        const uri = ref?.uri ? String(ref.uri) : '';
        if (name) { texts.push(name); }
        if (uri) { texts.push(uri); }
        annotations.push({ kind: 'file_ref', name, uri, detail: '' });
        break;
      }
      case 'toolInvocationSerialized': {
        const rec = part as Record<string, unknown>;
        // VS Code uses toolId (newer) or toolName (older) for the tool name
        const toolName = String(rec.toolId || rec.toolName || '');
        // invocationMessage is the user-visible description; input is legacy
        const detail = String(rec.invocationMessage || rec.input || '');
        if (toolName) { texts.push(toolName); }
        if (detail) { texts.push(detail); }
        // Always keep tool annotations even with empty detail
        if (toolName) {
          annotations.push({
            kind: 'tool',
            name: toolName,
            uri: '',
            detail: detail.substring(0, 500),
          });
        }
        break;
      }
      case 'textEditGroup': {
        const uri = extractUri(part.uri);
        if (uri) { texts.push(uri); }
        annotations.push({
          kind: 'file_edit',
          name: uri ? path.basename(uri) : '',
          uri,
          detail: '',
        });
        break;
      }
      case 'codeblockUri': {
        const uri = extractUri(part.uri);
        if (uri) { texts.push(uri); }
        annotations.push({
          kind: 'codeblock',
          name: uri ? path.basename(uri) : '',
          uri,
          detail: '',
        });
        break;
      }
      case 'thinking': {
        const thought = part.content;
        let text = '';
        if (typeof thought === 'string') {
          text = thought;
        } else if (thought && typeof thought === 'object' && 'value' in thought) {
          text = (thought as { value: string }).value;
        }
        if (text) { texts.push(text); }
        annotations.push({
          kind: 'thinking',
          name: '',
          uri: '',
          detail: text.substring(0, 500),
        });
        break;
      }
      case 'confirmationWidget': {
        const title = part.title;
        if (typeof title === 'string') { texts.push(title); }
        break;
      }
    }
  }

  return {
    text: texts.join('\n').trim(),
    annotations: annotations.filter(a => a.name || a.uri || a.detail),
  };
}

export function relativeTime(ts: number): string {
  if (!ts) { return ''; }
  const diff = Date.now() - ts;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) { return 'just now'; }
  if (minutes < 60) { return `${minutes}m ago`; }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) { return `${hours}h ago`; }
  const days = Math.floor(hours / 24);
  if (days < 7) { return `${days}d ago`; }
  if (days < 30) { return `${Math.floor(days / 7)}w ago`; }
  return `${Math.floor(days / 30)}mo ago`;
}

/** Escape HTML special characters to prevent injection inside <details> blocks. */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function extractUri(raw: unknown): string {
  if (typeof raw === 'string') { return raw; }
  if (raw && typeof raw === 'object' && 'path' in raw) {
    return (raw as { path: string }).path;
  }
  return '';
}
