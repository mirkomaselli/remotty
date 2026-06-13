import type {
  AgentQuestionInfo,
  ChatAttachment,
  ChatAttachmentInput,
  ChatClientMsg,
  PermissionSuggestion,
  UsageSummary,
} from '@remotty/shared';

const MAX_ATTACHMENTS = 6;
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const MAX_ATTACHMENTS_BYTES = 40 * 1024 * 1024;
import { BaseChatSession } from './base-session.js';
import type { BaseChatDeps } from './base-session.js';
import type { AppConfig } from '../config.js';
import type { OpenCodeServer } from '../opencode/server.js';

const MAX_TOOL_RESULT_BYTES = 16 * 1024;
const SSE_RETRY_MS = 1500;

// ===== Narrow views of the OpenCode wire shapes (v1.17.x, from its OpenAPI) ==

interface OcPartView {
  id?: string;
  messageID?: string;
  type?: string;
  text?: string;
  callID?: string;
  tool?: string;
  state?: {
    status?: string;
    input?: unknown;
    output?: string;
    error?: string;
  };
  time?: { start?: number; end?: number };
}

interface OcMessageView {
  id?: string;
  role?: string;
  cost?: number;
  tokens?: {
    input?: number;
    output?: number;
    cache?: { read?: number; write?: number };
  };
  time?: { created?: number; completed?: number };
  error?: { name?: string; data?: { message?: string } };
}

interface TrackedPart {
  kind: 'text' | 'tool' | 'other';
  messageID: string;
  text: string;
  finalized: boolean;
  toolEmitted: boolean;
  resultEmitted: boolean;
  callID: string;
  tool: string;
}

export interface OpenCodeSessionDeps extends BaseChatDeps {
  config: AppConfig;
  ocServer: OpenCodeServer;
}

/**
 * Bridges WS clients to a local `opencode serve` HTTP server.
 * Lazy: nothing starts until the first user_message,
 * which boots the shared opencode server, creates (or reuses) the OpenCode
 * session scoped to this cwd and opens the project SSE stream.
 *
 * Event mapping (OpenCode bus → ChatEvent), reducer-compatible:
 *  - text streaming → text_delta; the part is finalized as assistant_message
 *    (which replaces the client's streaming buffer) when it completes or when
 *    a tool part must be appended after it.
 *  - tool parts → assistant_message [tool_use] on first sight, tool_result on
 *    completed/error.
 *  - permission.asked → permission_request (reply via REST: once/always/reject).
 *  - session.idle → result (+status idle); session.error → error event.
 */
export class OpenCodeChatSession extends BaseChatSession {
  private readonly config: AppConfig;
  private readonly oc: OpenCodeServer;

  private readonly parts = new Map<string, TrackedPart>();
  private readonly partOrder: string[] = [];
  private readonly msgRole = new Map<string, string>();
  private readonly heldParts = new Map<string, OcPartView[]>();
  private readonly pendingPerms = new Set<string>();
  private readonly pendingQuestions = new Map<
    string,
    { questions: AgentQuestionInfo[]; api: 'legacy' | 'v2' }
  >();

  private sseStarted = false;
  private sseAbort: AbortController | null = null;
  private turnStartedAt: number | null = null;
  private turnHadError = false;
  private lastTokens: UsageSummary | undefined;

  constructor(deps: OpenCodeSessionDeps) {
    super(deps);
    this.config = deps.config;
    this.oc = deps.ocServer;
    void this.denyOrphanedPermissions();
    void this.rejectOrphanedQuestions();
  }

  handleClientMsg(msg: ChatClientMsg): void {
    switch (msg.type) {
      case 'user_message':
        if (
          typeof msg.text === 'string' &&
          (msg.text.trim().length > 0 || (Array.isArray(msg.attachments) && msg.attachments.length > 0))
        ) {
          if (this.pendingPerms.size > 0 || this.pendingQuestions.size > 0) {
            this.emit({
              type: 'error',
              message: 'Answer the pending request before sending another message.',
            });
            break;
          }
          let attachments: ChatAttachmentInput[];
          try {
            attachments = validateAttachments(msg.attachments);
          } catch (err) {
            this.emit({ type: 'error', message: errMessage(err) });
            break;
          }
          const attachmentMeta: ChatAttachment[] = attachments.map(({ name, mime, size }) => ({
            name,
            mime,
            size,
          }));
          this.emit({
            type: 'user_message',
            text: msg.text,
            ...(attachmentMeta.length > 0 ? { attachments: attachmentMeta } : {}),
          });
          this.setStatus('running');
          void this.runPrompt(msg.text, attachments);
        }
        break;
      case 'permission_response':
        void this.resolvePermission(msg);
        break;
      case 'question_response':
        void this.resolveQuestion(msg);
        break;
      case 'question_reject':
        void this.rejectQuestion(msg.requestId);
        break;
      case 'interrupt':
        void this.interrupt();
        break;
      case 'set_model':
        this.setModel(msg.model);
        break;
      case 'set_variant':
        this.setVariant(msg.variant);
        break;
      case 'set_agent':
        this.setAgent(msg.agent);
        break;
      case 'clear_context':
        void this.clearContext();
        break;
      case 'compact_context':
        void this.compactContext();
        break;
      default:
        break; // attach/ping handled by ws.ts
    }
  }

  dispose(): void {
    this.disposed = true;
    this.sseAbort?.abort();
    // Best-effort: rimuovi anche la sessione lato OpenCode.
    const ocId = this.meta.opencodeSessionId;
    if (ocId) {
      void fetch(this.url(`/session/${encodeURIComponent(ocId)}`), { method: 'DELETE' }).catch(
        () => {},
      );
    }
    this.closeAllSockets();
  }

  // ===== Prompt flow =========================================================

  private async runPrompt(text: string, attachments: ChatAttachmentInput[]): Promise<void> {
    try {
      await this.oc.ensureStarted();
      if (!this.meta.opencodeSessionId) {
        await this.checkProvidersConfigured();
        const res = await this.ocFetch('POST', '/session', { title: this.meta.title });
        const session = (await res.json()) as { id?: string };
        if (!session.id) throw new Error('unexpected response from POST /session');
        this.meta.opencodeSessionId = session.id;
        this.onMetaChanged(this.meta);
      }
      this.ensureSse();
      this.turnStartedAt = Date.now();
      this.turnHadError = false;
      const model = this.selectedModel();
      await this.ensureAttachmentSupport(model, attachments);
      const parts: Array<Record<string, unknown>> = [];
      if (text.trim()) parts.push({ type: 'text', text });
      for (const attachment of attachments) {
        parts.push({
          type: 'file',
          mime: attachment.mime,
          filename: attachment.name,
          url: attachment.dataUrl,
        });
      }
      const body: Record<string, unknown> = { parts };
      if (model) body['model'] = model;
      const variant = await this.selectedVariant(model);
      if (variant) body['variant'] = variant;
      const agent = await this.selectedAgent();
      if (agent) body['agent'] = agent;
      await this.ocFetch(
        'POST',
        `/session/${encodeURIComponent(this.meta.opencodeSessionId)}/prompt_async`,
        body,
      );
    } catch (err) {
      this.emit({ type: 'error', message: errMessage(err) });
      this.setStatus('idle');
    }
  }

  private async ensureAttachmentSupport(
    model: { providerID: string; modelID: string } | null,
    attachments: ChatAttachmentInput[],
  ): Promise<void> {
    if (!model || attachments.length === 0) return;
    const needsImage = attachments.some((attachment) => attachment.mime.startsWith('image/'));
    const needsPdf = attachments.some((attachment) => attachment.mime === 'application/pdf');
    const needsAudio = attachments.some((attachment) => attachment.mime.startsWith('audio/'));
    const needsVideo = attachments.some((attachment) => attachment.mime.startsWith('video/'));
    if (!needsImage && !needsPdf && !needsAudio && !needsVideo) return;

    const res = await this.ocFetch('GET', '/config/providers');
    const data = (await res.json()) as {
      providers?: Array<{
        id?: string;
        models?: Record<
          string,
          {
            capabilities?: {
              input?: Partial<Record<'image' | 'pdf' | 'audio' | 'video', boolean>>;
            };
          }
        >;
      }>;
    };
    const entry = data.providers
      ?.find((provider) => provider.id === model.providerID)
      ?.models?.[model.modelID];
    if (!entry) return;
    const input = entry.capabilities?.input;
    const unsupported = [
      needsImage && input?.image !== true ? 'images' : null,
      needsPdf && input?.pdf !== true ? 'PDFs' : null,
      needsAudio && input?.audio !== true ? 'audio' : null,
      needsVideo && input?.video !== true ? 'video' : null,
    ].filter((value): value is string => value !== null);
    if (unsupported.length > 0) {
      throw new Error(
        `${model.providerID}/${model.modelID} does not support ${unsupported.join(
          ' or ',
        )}. Choose a compatible model before sending.`,
      );
    }
  }

  private async checkProvidersConfigured(): Promise<void> {
    try {
      const res = await this.ocFetch('GET', '/config/providers');
      const data = (await res.json()) as { providers?: unknown[] };
      if (Array.isArray(data.providers) && data.providers.length === 0) {
        throw new Error(
          'No provider configured in OpenCode. On the PC run "opencode auth login" ' +
            '(e.g. Anthropic → Claude Pro/Max) and try again.',
        );
      }
    } catch (err) {
      // Se è il NOSTRO errore rilancia; problemi di rete non bloccano il prompt
      // (fallirà comunque con un ProviderAuthError leggibile).
      if (err instanceof Error && err.message.startsWith('No provider')) throw err;
      this.logger.warn('check providers fallito:', errMessage(err));
    }
  }

  async interrupt(): Promise<void> {
    const ocId = this.meta.opencodeSessionId;
    if (!ocId) return;
    try {
      await this.ocFetch('POST', `/session/${encodeURIComponent(ocId)}/abort`);
    } catch (err) {
      this.logger.warn('abort fallito:', errMessage(err));
    }
  }

  // ===== Model selection =====================================================

  private setModel(model: string | null): void {
    if (model !== null && !parseModel(model)) {
      this.emit({ type: 'error', message: 'Invalid model format (expected provider/model)' });
      return;
    }
    this.meta.opencodeModel = model;
    // Le variants sono specifiche del modello: non riutilizzarne una sul nuovo modello.
    this.meta.opencodeVariant = null;
    this.onMetaChanged(this.meta);
    this.emit({ type: 'meta', meta: this.meta });
  }

  private setVariant(variant: string | null): void {
    if (
      variant !== null &&
      (variant.length === 0 || variant.length > 64 || !/^[a-zA-Z0-9._-]+$/.test(variant))
    ) {
      this.emit({ type: 'error', message: 'Invalid model variant' });
      return;
    }
    if (variant !== null && !this.selectedModel()) {
      this.emit({ type: 'error', message: 'Select a model before choosing a variant' });
      return;
    }
    this.meta.opencodeVariant = variant;
    this.onMetaChanged(this.meta);
    this.emit({ type: 'meta', meta: this.meta });
  }

  private setAgent(agent: string | null): void {
    if (
      agent !== null &&
      (agent.length === 0 || agent.length > 128 || !/^[a-zA-Z0-9._-]+$/.test(agent))
    ) {
      this.emit({ type: 'error', message: 'Invalid OpenCode agent' });
      return;
    }
    this.meta.opencodeAgent = agent;
    this.onMetaChanged(this.meta);
    this.emit({ type: 'meta', meta: this.meta });
  }

  /** Modello da inviare col prompt: scelta utente → env REMOTTY_OPENCODE_MODEL → default OpenCode. */
  private selectedModel(): { providerID: string; modelID: string } | null {
    const raw = this.meta.opencodeModel ?? this.config.opencodeModel;
    return raw ? parseModel(raw) : null;
  }

  /** Verifica la variant contro i dati correnti di OpenCode prima di ogni prompt. */
  private async selectedVariant(
    model: { providerID: string; modelID: string } | null,
  ): Promise<string | null> {
    const variant = this.meta.opencodeVariant;
    if (!variant) return null;
    if (!model) {
      this.meta.opencodeVariant = null;
      this.onMetaChanged(this.meta);
      this.emit({ type: 'meta', meta: this.meta });
      return null;
    }
    const res = await this.ocFetch('GET', '/config/providers');
    const data = (await res.json()) as {
      providers?: Array<{
        id?: string;
        models?: Record<string, { id?: string; variants?: Record<string, { disabled?: boolean }> }>;
      }>;
    };
    const provider = (data.providers ?? []).find((p) => p.id === model.providerID);
    const entry = Object.entries(provider?.models ?? {}).find(
      ([modelId, value]) => (value.id ?? modelId) === model.modelID,
    )?.[1];
    if (!entry?.variants?.[variant] || entry.variants[variant]?.disabled === true) {
      this.meta.opencodeVariant = null;
      this.onMetaChanged(this.meta);
      this.emit({ type: 'meta', meta: this.meta });
      throw new Error(`Model variant "${variant}" is not available for the selected model`);
    }
    return variant;
  }

  /** Verifica che l'agente esista ancora e sia utilizzabile come agente principale. */
  private async selectedAgent(): Promise<string | null> {
    const selected = this.meta.opencodeAgent;
    if (!selected) return null;
    const res = await this.ocFetch('GET', '/agent');
    const agents = (await res.json()) as Array<{
      name?: string;
      mode?: string;
      hidden?: boolean;
    }>;
    const valid = agents.some(
      (agent) =>
        agent.name === selected &&
        agent.hidden !== true &&
        (agent.mode === 'primary' || agent.mode === 'all'),
    );
    if (!valid) {
      this.meta.opencodeAgent = null;
      this.onMetaChanged(this.meta);
      this.emit({ type: 'meta', meta: this.meta });
      throw new Error(`OpenCode agent "${selected}" is not available as a primary agent`);
    }
    return selected;
  }

  /** Primo default dalla mappa `default` di /config/providers (serve a summarize). */
  private async defaultModel(): Promise<{ providerID: string; modelID: string } | null> {
    try {
      const res = await this.ocFetch('GET', '/config/providers');
      const data = (await res.json()) as {
        providers?: Array<{ id?: string }>;
        default?: Record<string, string>;
      };
      for (const p of data.providers ?? []) {
        if (typeof p.id !== 'string') continue;
        const modelID = data.default?.[p.id];
        if (modelID) return { providerID: p.id, modelID };
      }
      return null;
    } catch {
      return null;
    }
  }

  // ===== Context clear / compact =============================================

  /**
   * Clear VERO: nuova sessione OpenCode al posto della vecchia (che viene
   * eliminata). Il prossimo prompt riparte con zero contesto; la cronologia
   * della UI resta, separata da un marker.
   */
  private async clearContext(): Promise<void> {
    if (
      this.meta.status === 'running' ||
      this.meta.status === 'waiting_permission' ||
      this.meta.status === 'waiting_input'
    ) {
      this.emit({ type: 'error', message: 'Wait for the turn to finish before clearing the context.' });
      return;
    }
    const oldId = this.meta.opencodeSessionId;
    try {
      if (oldId) {
        await this.oc.ensureStarted();
        const res = await this.ocFetch('POST', '/session', { title: this.meta.title });
        const session = (await res.json()) as { id?: string };
        if (!session.id) throw new Error('unexpected response from POST /session');
        this.meta.opencodeSessionId = session.id;
        this.onMetaChanged(this.meta);
        this.resetPartTracking();
        void this.ocFetch('DELETE', `/session/${encodeURIComponent(oldId)}`).catch(() => {});
        this.emit({ type: 'meta', meta: this.meta });
      }
      this.emit({ type: 'notice', text: 'Context cleared: the conversation starts over from scratch.' });
    } catch (err) {
      this.emit({ type: 'error', message: `Context clear failed: ${errMessage(err)}` });
    }
  }

  /** Compatta il contesto in un riassunto (POST /summarize, ex /compact). */
  private async compactContext(): Promise<void> {
    if (
      this.meta.status === 'running' ||
      this.meta.status === 'waiting_permission' ||
      this.meta.status === 'waiting_input'
    ) {
      this.emit({ type: 'error', message: 'Wait for the turn to finish before compacting the context.' });
      return;
    }
    const ocId = this.meta.opencodeSessionId;
    if (!ocId) {
      this.emit({ type: 'notice', text: 'Nothing to compact: the context is empty.' });
      return;
    }
    try {
      await this.oc.ensureStarted();
      // summarize richiede providerID/modelID espliciti.
      const model = this.selectedModel() ?? (await this.defaultModel());
      if (!model) throw new Error('no model available for summarization');
      this.ensureSse();
      this.emit({ type: 'notice', text: 'Compacting the context…' });
      this.turnStartedAt = Date.now();
      this.turnHadError = false;
      this.setStatus('running');
      await this.ocFetch('POST', `/session/${encodeURIComponent(ocId)}/summarize`, {
        providerID: model.providerID,
        modelID: model.modelID,
      });
    } catch (err) {
      this.emit({ type: 'error', message: `Compaction failed: ${errMessage(err)}` });
      this.setStatus('idle');
    }
  }

  /** Dopo lo swap di sessione gli ID di messaggi/parti vecchi non valgono più. */
  private resetPartTracking(): void {
    this.parts.clear();
    this.partOrder.length = 0;
    this.msgRole.clear();
    this.heldParts.clear();
  }

  // ===== Permissions =========================================================

  private async resolvePermission(
    msg: Extract<ChatClientMsg, { type: 'permission_response' }>,
  ): Promise<void> {
    if (typeof msg.requestId !== 'string') return;
    if (!this.pendingPerms.has(msg.requestId)) {
      // Richiesta stantia (es. orfana di un riavvio): fai convergere la UI.
      this.emit({ type: 'permission_resolved', requestId: msg.requestId, behavior: 'deny' });
      return;
    }
    const ocId = this.meta.opencodeSessionId;
    if (!ocId) return;
    const wantsAlways =
      Array.isArray(msg.updatedPermissions) &&
      msg.updatedPermissions.some(
        (p) => (p as { type?: string } | null)?.type === 'opencode_always',
      );
    const response =
      msg.behavior === 'allow' ? (wantsAlways ? 'always' : 'once') : 'reject';
    try {
      await this.ocFetch(
        'POST',
        `/session/${encodeURIComponent(ocId)}/permissions/${encodeURIComponent(msg.requestId)}`,
        { response },
      );
      this.pendingPerms.delete(msg.requestId);
      this.emit({
        type: 'permission_resolved',
        requestId: msg.requestId,
        behavior: msg.behavior === 'allow' ? 'allow' : 'deny',
      });
      this.maybeResumeRunning();
    } catch (err) {
      // OpenCode sta ancora aspettando: lascia la richiesta pendente.
      this.emit({ type: 'error', message: `Permission response failed: ${errMessage(err)}` });
    }
  }

  /** Vedi ChatSession.denyOrphanedPermissions — più il reject lato OpenCode. */
  private async denyOrphanedPermissions(): Promise<void> {
    try {
      const events = await this.log.readAfter(0);
      const unresolved = new Set<string>();
      for (const { ev } of events) {
        if (ev.type === 'permission_request') unresolved.add(ev.requestId);
        else if (ev.type === 'permission_resolved') unresolved.delete(ev.requestId);
      }
      const ocId = this.meta.opencodeSessionId;
      for (const requestId of unresolved) {
        if (this.pendingPerms.has(requestId)) continue;
        this.emit({ type: 'permission_resolved', requestId, behavior: 'deny' });
        if (ocId) {
          void this.ocFetch(
            'POST',
            `/session/${encodeURIComponent(ocId)}/permissions/${encodeURIComponent(requestId)}`,
            { response: 'reject' },
          ).catch(() => {});
        }
      }
    } catch (err) {
      this.logger.warn('orphaned-permission reconciliation failed:', err);
    }
  }

  private maybeResumeRunning(): void {
    if (this.pendingPerms.size > 0) {
      this.setStatus('waiting_permission');
      return;
    }
    if (this.pendingQuestions.size > 0) {
      this.setStatus('waiting_input');
      return;
    }
    if (
      this.meta.status === 'waiting_permission' ||
      this.meta.status === 'waiting_input'
    ) {
      this.setStatus('running');
    }
  }

  // ===== Questions ===========================================================

  private async resolveQuestion(
    msg: Extract<ChatClientMsg, { type: 'question_response' }>,
  ): Promise<void> {
    if (typeof msg.requestId !== 'string') return;
    const pending = this.pendingQuestions.get(msg.requestId);
    if (!pending) {
      this.emit({
        type: 'question_resolved',
        requestId: msg.requestId,
        outcome: 'rejected',
      });
      return;
    }
    if (
      !Array.isArray(msg.answers) ||
      msg.answers.length !== pending.questions.length ||
      !msg.answers.every(
        (answer) =>
          Array.isArray(answer) &&
          answer.length > 0 &&
          answer.every((value) => typeof value === 'string' && value.trim().length > 0),
      )
    ) {
      this.emit({ type: 'error', message: 'Invalid answers for the pending question' });
      return;
    }
    const answers = msg.answers.map((answer) => answer.map((value) => value.trim()));
    try {
      await this.questionRequest(pending.api, msg.requestId, 'reply', { answers });
      this.pendingQuestions.delete(msg.requestId);
      this.emit({
        type: 'question_resolved',
        requestId: msg.requestId,
        outcome: 'answered',
        answers,
      });
      this.maybeResumeRunning();
    } catch (err) {
      this.emit({ type: 'error', message: `Question response failed: ${errMessage(err)}` });
    }
  }

  private async rejectQuestion(requestId: string): Promise<void> {
    if (typeof requestId !== 'string') return;
    const pending = this.pendingQuestions.get(requestId);
    if (!pending) {
      this.emit({ type: 'question_resolved', requestId, outcome: 'rejected' });
      return;
    }
    try {
      await this.questionRequest(pending.api, requestId, 'reject');
      this.pendingQuestions.delete(requestId);
      this.emit({ type: 'question_resolved', requestId, outcome: 'rejected' });
      this.maybeResumeRunning();
    } catch (err) {
      this.emit({ type: 'error', message: `Question rejection failed: ${errMessage(err)}` });
    }
  }

  private async rejectOrphanedQuestions(): Promise<void> {
    try {
      const events = await this.log.readAfter(0);
      const unresolved = new Set<string>();
      for (const { ev } of events) {
        if (ev.type === 'question_request') unresolved.add(ev.requestId);
        else if (ev.type === 'question_resolved') unresolved.delete(ev.requestId);
      }
      for (const requestId of unresolved) {
        this.emit({ type: 'question_resolved', requestId, outcome: 'rejected' });
        void this.questionRequest('legacy', requestId, 'reject').catch(() => {});
      }
    } catch (err) {
      this.logger.warn('orphaned-question reconciliation failed:', err);
    }
  }

  private async questionRequest(
    api: 'legacy' | 'v2',
    requestId: string,
    action: 'reply' | 'reject',
    body?: { answers: string[][] },
  ): Promise<void> {
    const ocId = this.meta.opencodeSessionId;
    if (!ocId) throw new Error('OpenCode session is not available');
    const path =
      api === 'v2'
        ? `/api/session/${encodeURIComponent(ocId)}/question/${encodeURIComponent(requestId)}/${action}`
        : `/question/${encodeURIComponent(requestId)}/${action}`;
    await this.ocFetch('POST', path, body, api !== 'v2');
  }

  // ===== SSE =================================================================

  private ensureSse(): void {
    if (this.sseStarted) return;
    this.sseStarted = true;
    void this.sseLoop();
  }

  private async sseLoop(): Promise<void> {
    while (!this.disposed) {
      const ctl = new AbortController();
      this.sseAbort = ctl;
      try {
        const res = await fetch(this.url('/event'), {
          signal: ctl.signal,
          headers: { accept: 'text/event-stream' },
        });
        if (!res.ok || !res.body) throw new Error(`SSE HTTP ${res.status}`);
        this.logger.info('SSE OpenCode connesso');
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        let dataLines: string[] = [];
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let nl: number;
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).replace(/\r$/, '');
            buf = buf.slice(nl + 1);
            if (line === '') {
              if (dataLines.length > 0) {
                this.dispatchSse(dataLines.join('\n'));
                dataLines = [];
              }
              continue;
            }
            if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
          }
        }
      } catch (err) {
        if (!this.disposed) this.logger.warn('SSE drop:', errMessage(err));
      } finally {
        this.sseAbort = null;
      }
      if (this.disposed) return;
      await sleep(SSE_RETRY_MS);
    }
  }

  private dispatchSse(json: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      return;
    }
    // /event manda Event direttamente; /global/event lo incapsula in {payload}.
    const raw = parsed as { type?: string; properties?: unknown; payload?: unknown };
    const event = (
      raw.payload && typeof raw.payload === 'object' ? raw.payload : raw
    ) as { type?: string; properties?: Record<string, unknown> };
    if (typeof event.type !== 'string' || !event.properties) return;
    try {
      this.handleOcEvent(event.type, event.properties);
    } catch (err) {
      this.logger.error('mapping evento OpenCode fallito:', err);
    }
  }

  private handleOcEvent(type: string, p: Record<string, unknown>): void {
    const ocId = this.meta.opencodeSessionId;
    const sid = p['sessionID'];
    if (typeof sid === 'string' && sid !== ocId) return; // altra sessione del progetto

    switch (type) {
      case 'message.updated': {
        const info = p['info'] as OcMessageView | undefined;
        if (!info?.id || typeof info.role !== 'string') break;
        this.msgRole.set(info.id, info.role);
        const held = this.heldParts.get(info.id);
        if (held) {
          this.heldParts.delete(info.id);
          if (info.role === 'assistant') for (const part of held) this.handlePart(part);
        }
        if (info.role !== 'assistant') break;
        this.lastTokens = mapTokens(info.tokens);
        if (info.error) this.turnHadError = true;
        if (info.time?.completed) this.finalizeOpenTextParts(info.id);
        break;
      }

      case 'message.part.updated': {
        const part = p['part'] as OcPartView | undefined;
        if (part) this.handlePart(part);
        break;
      }

      case 'message.part.delta': {
        const partID = p['partID'];
        const field = p['field'];
        const delta = p['delta'];
        if (typeof partID !== 'string' || field !== 'text' || typeof delta !== 'string') break;
        const t = this.parts.get(partID);
        // Delta per parti sconosciute (ruolo non ancora noto / reasoning): ignora —
        // il successivo part.updated porta comunque il testo completo.
        if (!t || t.kind !== 'text' || t.finalized) break;
        t.text += delta;
        this.emit({ type: 'text_delta', text: delta });
        break;
      }

      case 'permission.asked': {
        const id = p['id'];
        if (typeof id !== 'string') break;
        if (this.pendingPerms.has(id)) break;
        this.pendingPerms.add(id);
        const always = Array.isArray(p['always'])
          ? (p['always'] as unknown[]).filter((x): x is string => typeof x === 'string')
          : [];
        const suggestions: PermissionSuggestion[] =
          always.length > 0 ? [{ type: 'opencode_always', patterns: always }] : [];
        const metadata =
          p['metadata'] && typeof p['metadata'] === 'object'
            ? (p['metadata'] as Record<string, unknown>)
            : {};
        this.emit({
          type: 'permission_request',
          requestId: id,
          toolName: typeof p['permission'] === 'string' ? p['permission'] : 'permission',
          input: { ...metadata, patterns: p['patterns'] },
          ...(suggestions.length > 0 ? { suggestions } : {}),
        });
        this.setStatus('waiting_permission');
        break;
      }

      case 'permission.replied': {
        const requestID = p['requestID'];
        if (typeof requestID !== 'string') break;
        // Se abbiamo risposto noi via REST l'abbiamo già rimossa (dedupe).
        if (!this.pendingPerms.delete(requestID)) break;
        this.emit({
          type: 'permission_resolved',
          requestId: requestID,
          behavior: p['reply'] === 'reject' ? 'deny' : 'allow',
        });
        this.maybeResumeRunning();
        break;
      }

      case 'question.asked':
      case 'question.v2.asked': {
        const id = p['id'];
        const questions = parseQuestions(p['questions']);
        if (typeof id !== 'string' || questions.length === 0) break;
        if (this.pendingQuestions.has(id)) break;
        this.pendingQuestions.set(id, {
          questions,
          api: type === 'question.v2.asked' ? 'v2' : 'legacy',
        });
        this.emit({ type: 'question_request', requestId: id, questions });
        this.setStatus('waiting_input');
        break;
      }

      case 'question.replied':
      case 'question.v2.replied': {
        const requestID = p['requestID'];
        if (typeof requestID !== 'string') break;
        if (!this.pendingQuestions.delete(requestID)) break;
        const answers = parseAnswers(p['answers']);
        this.emit({
          type: 'question_resolved',
          requestId: requestID,
          outcome: 'answered',
          ...(answers ? { answers } : {}),
        });
        this.maybeResumeRunning();
        break;
      }

      case 'question.rejected':
      case 'question.v2.rejected': {
        const requestID = p['requestID'];
        if (typeof requestID !== 'string') break;
        if (!this.pendingQuestions.delete(requestID)) break;
        this.emit({ type: 'question_resolved', requestId: requestID, outcome: 'rejected' });
        this.maybeResumeRunning();
        break;
      }

      case 'session.idle': {
        if (this.pendingPerms.size > 0 || this.pendingQuestions.size > 0) {
          this.maybeResumeRunning();
          break;
        }
        this.finalizeOpenTextParts();
        const durationMs = this.turnStartedAt ? Date.now() - this.turnStartedAt : 0;
        this.turnStartedAt = null;
        this.meta.numTurns = (this.meta.numTurns ?? 0) + 1;
        this.onMetaChanged(this.meta);
        this.emit({
          type: 'result',
          subtype: this.turnHadError ? 'error' : 'success',
          isError: this.turnHadError,
          durationMs,
          numTurns: this.meta.numTurns,
          totalCostUsd: this.meta.totalCostUsd,
          usage: this.lastTokens,
        });
        this.setStatus('idle');
        break;
      }

      case 'session.updated': {
        const info = p['info'] as { cost?: number } | undefined;
        if (typeof info?.cost === 'number') {
          this.meta.totalCostUsd = info.cost; // costo cumulativo della sessione
          this.onMetaChanged(this.meta);
        }
        break;
      }

      case 'session.error': {
        const error = p['error'] as { name?: string; data?: { message?: string } } | undefined;
        const message =
          error?.name === 'MessageAbortedError'
            ? 'Interrupted'
            : error?.data?.message || error?.name || 'OpenCode error';
        this.turnHadError = true;
        this.emit({ type: 'error', message });
        // session.idle di norma segue; se non arriva, non restare bloccati su running.
        if (this.pendingPerms.size === 0 && this.pendingQuestions.size === 0) {
          this.setStatus('idle');
        }
        break;
      }

      default:
        break;
    }
  }

  // ===== Part tracking =======================================================

  private handlePart(part: OcPartView): void {
    const messageID = part.messageID;
    const partID = part.id;
    if (!messageID || !partID) return;
    const role = this.msgRole.get(messageID);
    if (role === undefined) {
      // Ruolo non ancora noto: trattieni e riprocessa al message.updated.
      const held = this.heldParts.get(messageID) ?? [];
      held.push(part);
      this.heldParts.set(messageID, held);
      return;
    }
    if (role !== 'assistant') return;

    if (part.type === 'text') {
      let t = this.parts.get(partID);
      if (!t) {
        t = {
          kind: 'text',
          messageID,
          text: '',
          finalized: false,
          toolEmitted: false,
          resultEmitted: false,
          callID: '',
          tool: '',
        };
        this.parts.set(partID, t);
        this.partOrder.push(partID);
      }
      if (!t.finalized && typeof part.text === 'string' && part.text !== t.text) {
        // part.updated porta il testo completo: emetti solo il suffisso nuovo.
        if (part.text.length > t.text.length && part.text.startsWith(t.text)) {
          this.emit({ type: 'text_delta', text: part.text.slice(t.text.length) });
        }
        t.text = part.text;
      }
      if (part.time?.end) this.finalizeTextPart(t);
      return;
    }

    if (part.type === 'tool') {
      let t = this.parts.get(partID);
      if (!t) {
        t = {
          kind: 'tool',
          messageID,
          text: '',
          finalized: false,
          toolEmitted: false,
          resultEmitted: false,
          callID: part.callID || partID,
          tool: part.tool || 'tool',
        };
        this.parts.set(partID, t);
        this.partOrder.push(partID);
      }
      const state = part.state ?? {};
      const status = state.status ?? '';
      const ready =
        status === 'running' ||
        status === 'completed' ||
        status === 'error' ||
        (status === 'pending' && state.input !== undefined);
      if (!t.toolEmitted && ready) {
        // Il reducer sostituisce il buffer di streaming con assistant_message:
        // chiudi prima il testo in corso, poi emetti il blocco tool.
        this.finalizeOpenTextParts(messageID);
        this.emit({
          type: 'assistant_message',
          blocks: [{ type: 'tool_use', id: t.callID, name: t.tool, input: state.input ?? {} }],
        });
        t.toolEmitted = true;
      }
      if (t.toolEmitted && !t.resultEmitted && status === 'completed') {
        this.emit({
          type: 'tool_result',
          toolUseId: t.callID,
          content: cap(state.output ?? ''),
          isError: false,
        });
        t.resultEmitted = true;
      }
      if (t.toolEmitted && !t.resultEmitted && status === 'error') {
        this.emit({
          type: 'tool_result',
          toolUseId: t.callID,
          content: cap(state.error ?? 'tool error'),
          isError: true,
        });
        t.resultEmitted = true;
      }
      return;
    }

    // reasoning / step-start / snapshot / patch / …: non renderizzati.
    if (!this.parts.has(partID)) {
      this.parts.set(partID, {
        kind: 'other',
        messageID,
        text: '',
        finalized: true,
        toolEmitted: false,
        resultEmitted: false,
        callID: '',
        tool: '',
      });
    }
  }

  private finalizeTextPart(t: TrackedPart): void {
    if (t.finalized) return;
    t.finalized = true;
    if (t.text.length === 0) return;
    this.emit({ type: 'assistant_message', blocks: [{ type: 'text', text: t.text }] });
  }

  /** Finalizza i text part aperti (di un messaggio, o tutti), in ordine di arrivo. */
  private finalizeOpenTextParts(messageID?: string): void {
    for (const id of this.partOrder) {
      const t = this.parts.get(id);
      if (!t || t.kind !== 'text' || t.finalized) continue;
      if (messageID && t.messageID !== messageID) continue;
      this.finalizeTextPart(t);
    }
  }

  // ===== HTTP helpers ========================================================

  private url(path: string): string {
    const sep = path.includes('?') ? '&' : '?';
    return `${this.oc.baseUrl}${path}${sep}directory=${encodeURIComponent(this.meta.cwd)}`;
  }

  private async ocFetch(
    method: string,
    path: string,
    body?: unknown,
    scoped = true,
  ): Promise<Response> {
    const res = await fetch(scoped ? this.url(path) : `${this.oc.baseUrl}${path}`, {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json' } : {},
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) {
      let detail = '';
      try {
        detail = (await res.text()).slice(0, 300);
      } catch {
        // ignore
      }
      throw new Error(`OpenCode ${method} ${path} → HTTP ${res.status}${detail ? `: ${detail}` : ''}`);
    }
    return res;
  }
}

// ===== helpers ===============================================================

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function parseModel(model: string): { providerID: string; modelID: string } | null {
  const slash = model.indexOf('/');
  if (slash <= 0 || slash >= model.length - 1) return null;
  return { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) };
}

function parseQuestions(value: unknown): AgentQuestionInfo[] {
  if (!Array.isArray(value)) return [];
  const questions: AgentQuestionInfo[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const question = raw as Record<string, unknown>;
    if (typeof question['question'] !== 'string' || typeof question['header'] !== 'string') {
      continue;
    }
    const options = Array.isArray(question['options'])
      ? question['options']
          .filter(
            (option): option is Record<string, unknown> =>
              !!option &&
              typeof option === 'object' &&
              typeof (option as Record<string, unknown>)['label'] === 'string' &&
              typeof (option as Record<string, unknown>)['description'] === 'string',
          )
          .map((option) => ({
            label: option['label'] as string,
            description: option['description'] as string,
          }))
      : [];
    questions.push({
      question: question['question'],
      header: question['header'],
      options,
      multiple: question['multiple'] === true,
      custom: question['custom'] === true,
    });
  }
  return questions;
}

function parseAnswers(value: unknown): string[][] | null {
  if (
    !Array.isArray(value) ||
    !value.every(
      (answer) =>
        Array.isArray(answer) && answer.every((item) => typeof item === 'string'),
    )
  ) {
    return null;
  }
  return value as string[][];
}

function validateAttachments(value: unknown): ChatAttachmentInput[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('Invalid attachments');
  if (value.length > MAX_ATTACHMENTS) {
    throw new Error(`Too many attachments (maximum ${MAX_ATTACHMENTS})`);
  }

  let total = 0;
  return value.map((raw) => {
    if (!raw || typeof raw !== 'object') throw new Error('Invalid attachment');
    const item = raw as Record<string, unknown>;
    const name = typeof item['name'] === 'string' ? item['name'].trim() : '';
    const mime = typeof item['mime'] === 'string' ? item['mime'].trim().toLowerCase() : '';
    const size = item['size'];
    const dataUrl = item['dataUrl'];
    if (!name || name.length > 255) throw new Error('Invalid attachment name');
    if (!/^[\w.+-]+\/[\w.+-]+$/.test(mime)) throw new Error(`Invalid MIME type for ${name}`);
    if (
      typeof size !== 'number' ||
      !Number.isSafeInteger(size) ||
      size < 0 ||
      size > MAX_ATTACHMENT_BYTES
    ) {
      throw new Error(`${name} exceeds the 20 MB attachment limit`);
    }
    if (
      typeof dataUrl !== 'string' ||
      !dataUrl.startsWith(`data:${mime};base64,`) ||
      dataUrl.length > Math.ceil((MAX_ATTACHMENT_BYTES * 4) / 3) + 256
    ) {
      throw new Error(`Invalid attachment data for ${name}`);
    }
    total += size;
    if (total > MAX_ATTACHMENTS_BYTES) {
      throw new Error('Attachments exceed the 40 MB total limit');
    }
    return { name, mime, size, dataUrl };
  });
}

function mapTokens(t: OcMessageView['tokens']): UsageSummary | undefined {
  if (!t) return undefined;
  return {
    inputTokens: t.input,
    outputTokens: t.output,
    cacheReadTokens: t.cache?.read,
    cacheCreationTokens: t.cache?.write,
  };
}

function cap(text: string): string {
  if (text.length > MAX_TOOL_RESULT_BYTES) {
    return `${text.slice(0, MAX_TOOL_RESULT_BYTES)}\n…[troncato]`;
  }
  return text;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
