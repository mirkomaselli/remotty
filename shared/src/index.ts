// @remotty/shared — protocol contract between server and web.
// Keep this file dependency-free. Every wire shape lives here.

// ===== Entities ==============================================================

export type SessionKind = 'chat' | 'terminal';

export type SessionStatus =
  | 'created' // chat: no query started yet; terminal: not yet spawned
  | 'running' // agent is working / pty alive
  | 'waiting_permission' // chat only: a permission_request is pending
  | 'waiting_input' // chat only: the agent asked the user one or more questions
  | 'idle' // chat only: turn finished, waiting for next user message
  | 'exited' // terminal process or chat process ended
  | 'error';

export type ChatAgentId = 'opencode'; // future: 'codex', ...

export interface SessionMeta {
  id: string;
  kind: SessionKind;
  title: string;
  cwd: string;
  createdAt: string; // ISO
  updatedAt: string; // ISO
  status: SessionStatus;
  // chat-only
  agent?: ChatAgentId;
  opencodeSessionId?: string | null;
  /** OpenCode: modello scelto dall'utente ('providerID/modelID'), null = default. */
  opencodeModel?: string | null;
  /** OpenCode: variant del modello (es. high/max), null = default del modello. */
  opencodeVariant?: string | null;
  /** OpenCode: agente primario scelto dall'utente, null = default OpenCode (build). */
  opencodeAgent?: string | null;
  totalCostUsd?: number;
  numTurns?: number;
  // terminal-only
  command?: string; // empty/undefined => OS default shell
  exitCode?: number | null;
}

export interface ProjectInfo {
  path: string;
  name: string;
  isGitRepo: boolean;
  lastUsedAt: string; // ISO
}

export interface DirEntry {
  name: string;
  path: string;
  isGitRepo: boolean;
}

export interface BrowseResult {
  path: string;
  parent: string | null;
  dirs: DirEntry[];
}

export interface ServerConfig {
  version: string;
  platform: NodeJS.Platform | string;
  homeDir: string;
  defaultRoots: string[];
  authRequired: boolean;
  clis: { opencode: boolean };
}

export type CreateSessionRequest =
  | { kind: 'terminal'; cwd: string; title?: string; command?: string }
  | {
      kind: 'chat';
      cwd: string;
      title?: string;
      agent: ChatAgentId;
    };

// ===== Chat WS protocol ======================================================

export interface PermissionSuggestion {
  // Opaque pass-through of the agent's permission suggestion entries
  // (e.g. { type: 'opencode_always', patterns: ['git status'] }).
  type: string;
  [key: string]: unknown;
}

export interface AgentQuestionOption {
  label: string;
  description: string;
}

export interface AgentQuestionInfo {
  question: string;
  header: string;
  options: AgentQuestionOption[];
  multiple: boolean;
  custom: boolean;
}

export interface ChatAttachment {
  name: string;
  mime: string;
  size: number;
}

export interface ChatAttachmentInput extends ChatAttachment {
  /** Base64 data URL, forwarded to OpenCode but never persisted in the event log. */
  dataUrl: string;
}

export type ChatClientMsg =
  | { type: 'attach'; afterSeq: number }
  | { type: 'user_message'; text: string; attachments?: ChatAttachmentInput[] }
  | {
      type: 'permission_response';
      requestId: string;
      behavior: 'allow' | 'deny';
      message?: string;
      updatedInput?: unknown;
      updatedPermissions?: unknown[];
    }
  | { type: 'question_response'; requestId: string; answers: string[][] }
  | { type: 'question_reject'; requestId: string }
  | { type: 'interrupt' }
  /** OpenCode: 'providerID/modelID', null = torna al default. */
  | { type: 'set_model'; model: string | null }
  /** OpenCode: variant dichiarata dal modello, null = default del modello. */
  | { type: 'set_variant'; variant: string | null }
  /** OpenCode: agente primario, null = default OpenCode. */
  | { type: 'set_agent'; agent: string | null }
  /** Clear vero: il contesto dell'agente riparte da zero (la cronologia UI resta). */
  | { type: 'clear_context' }
  /** Compatta il contesto in un riassunto (equivalente di /compact). */
  | { type: 'compact_context' }
  | { type: 'ping' };

export type AssistantBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown };

export interface UsageSummary {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

export type ChatEvent =
  | { type: 'status'; status: SessionStatus }
  | { type: 'meta'; meta: SessionMeta }
  | { type: 'user_message'; text: string; attachments?: ChatAttachment[] }
  | { type: 'text_delta'; text: string }
  | { type: 'assistant_message'; blocks: AssistantBlock[] }
  | { type: 'tool_result'; toolUseId: string; content: string; isError: boolean }
  | {
      type: 'permission_request';
      requestId: string;
      toolName: string;
      displayName?: string;
      description?: string;
      input: unknown;
      suggestions?: PermissionSuggestion[];
    }
  | { type: 'permission_resolved'; requestId: string; behavior: 'allow' | 'deny' }
  | { type: 'question_request'; requestId: string; questions: AgentQuestionInfo[] }
  | {
      type: 'question_resolved';
      requestId: string;
      outcome: 'answered' | 'rejected';
      answers?: string[][];
    }
  | {
      type: 'result';
      subtype: string;
      isError: boolean;
      durationMs: number;
      numTurns: number;
      totalCostUsd?: number;
      usage?: UsageSummary;
    }
  | { type: 'error'; message: string }
  /** Marker informativo nel thread (es. "contesto ripulito"). */
  | { type: 'notice'; text: string };

export interface ChatEventEnvelope {
  seq: number;
  ev: ChatEvent;
}

/** Non-sequenced server frames (not persisted, not replayed). */
export type ChatServerControlMsg =
  | { type: 'attached'; lastSeq: number; meta: SessionMeta }
  | { type: 'pong' };

export type ChatServerMsg = ChatEventEnvelope | ChatServerControlMsg;

export function isChatEnvelope(m: ChatServerMsg): m is ChatEventEnvelope {
  return typeof (m as ChatEventEnvelope).seq === 'number';
}

// ===== Terminal WS protocol (binary, 1-byte opcode prefix) ==================

export const TERM_OP = {
  // client -> server
  INPUT: 0x30, // '0' + utf8 keyboard input
  RESIZE: 0x31, // '1' + JSON {cols, rows}
  // server -> client
  OUTPUT: 0x30, // '0' + raw pty bytes
  SNAPSHOT: 0x32, // '2' + utf8 replay buffer (once, right after attach)
  EXIT: 0x33, // '3' + JSON {exitCode}
} as const;

export interface TermResizePayload {
  cols: number;
  rows: number;
}

export interface TermExitPayload {
  exitCode: number | null;
}

// ===== REST misc =============================================================

export interface ChatEventsPage {
  events: ChatEventEnvelope[];
  lastSeq: number;
}

export interface OpencodeModelEntry {
  id: string;
  name: string;
  /** Variants abilitate dichiarate da OpenCode per questo modello. */
  variants: string[];
  input: {
    text: boolean;
    audio: boolean;
    image: boolean;
    video: boolean;
    pdf: boolean;
  };
}

export interface OpencodeProviderInfo {
  id: string;
  name: string;
  /** modelID di default del provider (dalla mappa `default` di OpenCode). */
  defaultModelID?: string;
  models: OpencodeModelEntry[];
}

export interface OpencodeModelsResponse {
  providers: OpencodeProviderInfo[];
}

export type OpencodePermissionLevel = 'allow' | 'ask' | 'deny' | 'mixed' | 'unknown';

export interface OpencodeAgentEntry {
  name: string;
  description?: string;
  mode: 'primary' | 'all';
  native: boolean;
  permissions: {
    edit: OpencodePermissionLevel;
    bash: OpencodePermissionLevel;
  };
}

export interface OpencodeAgentsResponse {
  agents: OpencodeAgentEntry[];
}

export interface PushConfigResponse {
  supported: boolean;
  publicKey: string;
}

export interface PushSubscriptionInput {
  endpoint: string;
  expirationTime?: number | null;
  keys: {
    p256dh: string;
    auth: string;
  };
}

export interface PushDiagnosticInput {
  stage: string;
  secureContext: boolean;
  standalone: boolean;
  permission?: 'default' | 'denied' | 'granted' | 'unavailable';
  errorName?: string;
  errorMessage?: string;
}

export interface PairingConfig {
  version: 1;
  serverUrl: string;
  token: string;
}

export interface HealthResponse {
  ok: boolean;
  version: string;
}
