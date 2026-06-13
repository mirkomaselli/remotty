// Fold puro di ChatEventEnvelope[] -> stato UI della conversazione.
// Deve essere replay-safe: rifare il fold da seq 0 produce lo stesso risultato.

import type {
  AgentQuestionInfo,
  ChatAttachment,
  ChatEventEnvelope,
  PermissionSuggestion,
  SessionMeta,
  SessionStatus,
} from '@remotty/shared';

export interface ToolResultInfo {
  content: string;
  isError: boolean;
}

export interface ToolPart {
  kind: 'tool';
  id: string;
  name: string;
  input: unknown;
  result: ToolResultInfo | null;
}

export interface TextPart {
  kind: 'text';
  text: string;
}

export type AssistantPart = TextPart | ToolPart;

export interface PendingPermission {
  requestId: string;
  toolName: string;
  displayName?: string;
  description?: string;
  input: unknown;
  suggestions: PermissionSuggestion[];
}

export interface PendingQuestion {
  requestId: string;
  questions: AgentQuestionInfo[];
}

export interface TurnResult {
  isError: boolean;
  durationMs: number;
  numTurns: number;
  totalCostUsd?: number;
}

export type ChatItem =
  | { role: 'user'; key: string; text: string; attachments: ChatAttachment[] }
  | { role: 'assistant'; key: string; parts: AssistantPart[] }
  | { role: 'result'; key: string; result: TurnResult }
  | { role: 'error'; key: string; message: string }
  | { role: 'notice'; key: string; text: string };

export interface ChatUiState {
  items: ChatItem[];
  /** Buffer del testo in streaming non ancora finalizzato da assistant_message. */
  pendingText: string;
  /** True finché assistant_message consecutivi si fondono nello stesso gruppo visivo. */
  groupOpen: boolean;
  status: SessionStatus;
  pendingPermissions: PendingPermission[];
  pendingQuestions: PendingQuestion[];
  lastSeq: number;
  meta: SessionMeta | null;
}

export function initialChatState(): ChatUiState {
  return {
    items: [],
    pendingText: '',
    groupOpen: false,
    status: 'created',
    pendingPermissions: [],
    pendingQuestions: [],
    lastSeq: 0,
    meta: null,
  };
}

function attachToolResult(
  items: ChatItem[],
  toolUseId: string,
  result: ToolResultInfo,
): ChatItem[] {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (!item || item.role !== 'assistant') continue;
    const idx = item.parts.findIndex((p) => p.kind === 'tool' && p.id === toolUseId);
    if (idx < 0) continue;
    const parts = item.parts.slice();
    const tool = parts[idx] as ToolPart;
    parts[idx] = { ...tool, result };
    const copy = items.slice();
    copy[i] = { ...item, parts };
    return copy;
  }
  return items; // tool_use mai visto (log troncato): ignora senza rompere il fold
}

export function applyEnvelope(state: ChatUiState, env: ChatEventEnvelope): ChatUiState {
  if (env.seq <= state.lastSeq) return state; // guardia anti-duplicati sul replay
  const ev = env.ev;
  const next: ChatUiState = { ...state, lastSeq: env.seq };

  switch (ev.type) {
    case 'status':
      next.status = ev.status;
      break;

    case 'meta':
      next.meta = ev.meta;
      next.status = ev.meta.status;
      break;

    case 'user_message':
      next.items = [
        ...state.items,
        {
          role: 'user',
          key: `u${env.seq}`,
          text: ev.text,
          attachments: ev.attachments ?? [],
        },
      ];
      next.pendingText = '';
      next.groupOpen = false;
      break;

    case 'text_delta':
      next.pendingText = state.pendingText + ev.text;
      break;

    case 'assistant_message': {
      const parts: AssistantPart[] = ev.blocks.map((b) =>
        b.type === 'text'
          ? { kind: 'text', text: b.text }
          : { kind: 'tool', id: b.id, name: b.name, input: b.input, result: null },
      );
      // Il messaggio finalizzato SOSTITUISCE il buffer di streaming.
      next.pendingText = '';
      const last = state.items[state.items.length - 1];
      if (state.groupOpen && last && last.role === 'assistant') {
        next.items = [
          ...state.items.slice(0, -1),
          { ...last, parts: [...last.parts, ...parts] },
        ];
      } else {
        next.items = [...state.items, { role: 'assistant', key: `a${env.seq}`, parts }];
      }
      next.groupOpen = true;
      break;
    }

    case 'tool_result':
      next.items = attachToolResult(state.items, ev.toolUseId, {
        content: ev.content,
        isError: ev.isError,
      });
      break;

    case 'permission_request':
      if (!state.pendingPermissions.some((p) => p.requestId === ev.requestId)) {
        next.pendingPermissions = [
          ...state.pendingPermissions,
          {
            requestId: ev.requestId,
            toolName: ev.toolName,
            displayName: ev.displayName,
            description: ev.description,
            input: ev.input,
            suggestions: ev.suggestions ?? [],
          },
        ];
      }
      break;

    case 'permission_resolved':
      next.pendingPermissions = state.pendingPermissions.filter(
        (p) => p.requestId !== ev.requestId,
      );
      break;

    case 'question_request':
      if (!state.pendingQuestions.some((question) => question.requestId === ev.requestId)) {
        next.pendingQuestions = [
          ...state.pendingQuestions,
          { requestId: ev.requestId, questions: ev.questions },
        ];
      }
      break;

    case 'question_resolved':
      next.pendingQuestions = state.pendingQuestions.filter(
        (question) => question.requestId !== ev.requestId,
      );
      break;

    case 'result':
      next.items = [
        ...state.items,
        {
          role: 'result',
          key: `r${env.seq}`,
          result: {
            isError: ev.isError,
            durationMs: ev.durationMs,
            numTurns: ev.numTurns,
            totalCostUsd: ev.totalCostUsd,
          },
        },
      ];
      next.pendingText = '';
      next.groupOpen = false;
      break;

    case 'error':
      next.items = [...state.items, { role: 'error', key: `e${env.seq}`, message: ev.message }];
      next.pendingText = '';
      next.groupOpen = false;
      break;

    case 'notice':
      next.items = [...state.items, { role: 'notice', key: `n${env.seq}`, text: ev.text }];
      next.groupOpen = false;
      break;
  }
  return next;
}

export function foldEvents(
  state: ChatUiState,
  envelopes: readonly ChatEventEnvelope[],
): ChatUiState {
  let s = state;
  for (const env of envelopes) s = applyEnvelope(s, env);
  return s;
}
