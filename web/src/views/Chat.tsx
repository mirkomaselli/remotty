import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type {
  ChatAttachmentInput,
  OpencodeAgentEntry,
  OpencodeAgentsResponse,
  OpencodeModelEntry,
  OpencodeModelsResponse,
  OpencodePermissionLevel,
} from '@remotty/shared';
import { ChatSocket } from '../lib/chat-socket';
import { useStore, type ConnState } from '../store';
import {
  initialChatState,
  type ChatItem,
  type PendingPermission,
  type PendingQuestion,
} from '../lib/chat-reducer';
import { api } from '../lib/api';
import { useWakeLock } from '../lib/use-wake-lock';
import {
  basename,
  fmtCost,
  fmtDuration,
  stringifyInput,
  STATUS_DOT,
} from '../lib/format';
import Markdown from '../components/Markdown';
import Sheet from '../components/Sheet';
import ToolCard from '../components/ToolCard';
import {
  IconArrowDown,
  IconCheck,
  IconChevronLeft,
  IconFile,
  IconKebab,
  IconPaperclip,
  IconSend,
  IconStop,
  IconTrash,
  IconX,
} from '../components/icons';

const EMPTY = initialChatState();
const MAX_ATTACHMENTS = 6;
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const MAX_ATTACHMENTS_BYTES = 40 * 1024 * 1024;

interface PendingAttachment extends ChatAttachmentInput {
  id: string;
}

export default function Chat() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const chat = useStore((s) => s.chats[id]) ?? EMPTY;
  const sessions = useStore((s) => s.sessions);
  const [conn, setConn] = useState<ConnState>('connecting');
  const [menuOpen, setMenuOpen] = useState(false);
  const [modelSheetOpen, setModelSheetOpen] = useState(false);
  const [agentSheetOpen, setAgentSheetOpen] = useState(false);
  const [models, setModels] = useState<OpencodeModelsResponse | null>(null);
  const [modelsErr, setModelsErr] = useState<string | null>(null);
  const [agents, setAgents] = useState<OpencodeAgentsResponse | null>(null);
  const [agentsErr, setAgentsErr] = useState<string | null>(null);
  // undefined = nessuna scelta ottimistica in corso (null è un valore valido: "default").
  const [optimisticModel, setOptimisticModel] = useState<string | null | undefined>(undefined);
  const [optimisticVariant, setOptimisticVariant] = useState<string | null | undefined>(undefined);
  const [optimisticAgent, setOptimisticAgent] = useState<string | null | undefined>(undefined);
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [readingAttachments, setReadingAttachments] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const sockRef = useRef<ChatSocket | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const atBottomRef = useRef(true);

  const meta = chat.meta ?? sessions.find((x) => x.id === id) ?? null;
  const title = meta?.title || (meta ? basename(meta.cwd) : 'Chat');
  const running = chat.status === 'running';
  const currentModel =
    optimisticModel !== undefined ? optimisticModel : (meta?.opencodeModel ?? null);
  const currentVariant =
    optimisticVariant !== undefined ? optimisticVariant : (meta?.opencodeVariant ?? null);
  const currentAgent =
    optimisticAgent !== undefined ? optimisticAgent : (meta?.opencodeAgent ?? null);
  const currentModelEntry = findModel(models, currentModel);
  const attachmentCompatibilityError = getAttachmentCompatibilityError(
    currentModel,
    currentModelEntry,
    attachments,
  );
  const busy =
    running ||
    chat.status === 'waiting_permission' ||
    chat.status === 'waiting_input' ||
    conn !== 'open';

  useWakeLock(
    running || chat.status === 'waiting_permission' || chat.status === 'waiting_input',
  );

  // Socket per sessione: attach con l'ultimo seq visto, fold nello store.
  useEffect(() => {
    if (!id) return;
    const sock = new ChatSocket(
      id,
      () => useStore.getState().chats[id]?.lastSeq ?? 0,
      (e) => {
        const st = useStore.getState();
        if (e.type === 'envelope') st.chatFold(id, [e.env]);
        else if (e.type === 'attached') st.chatAttached(id, e.meta);
        else setConn(e.state);
      },
    );
    sockRef.current = sock;
    return () => {
      sock.close();
      sockRef.current = null;
    };
  }, [id]);

  // Il server è la fonte di verità: azzera l'ottimismo quando arriva la meta persistita.
  useEffect(() => setOptimisticModel(undefined), [meta?.opencodeModel]);
  useEffect(() => setOptimisticVariant(undefined), [meta?.opencodeVariant]);
  useEffect(() => setOptimisticAgent(undefined), [meta?.opencodeAgent]);

  // Auto-scroll in fondo se l'utente non ha scrollato verso l'alto.
  useEffect(() => {
    if (atBottomRef.current) scrollToBottom();
  }, [
    chat.items,
    chat.pendingText,
    chat.pendingPermissions.length,
    chat.pendingQuestions.length,
  ]);

  const scrollToBottom = (): void => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  };

  const onScroll = (): void => {
    const el = scrollRef.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    atBottomRef.current = near;
    setAtBottom(near);
  };

  const send = (): void => {
    const t = text.trim();
    if (
      (!t && attachments.length === 0) ||
      attachmentCompatibilityError ||
      !sockRef.current
    ) {
      return;
    }
    if (!sockRef.current.userMessage(t, attachments)) return; // socket chiuso: non perdere il testo
    setText('');
    setAttachments([]);
    setAttachmentError(null);
    const ta = taRef.current;
    if (ta) ta.style.height = 'auto';
    atBottomRef.current = true;
  };

  const addAttachments = async (files: FileList | null): Promise<void> => {
    if (!files?.length) return;
    setAttachmentError(null);
    const available = MAX_ATTACHMENTS - attachments.length;
    if (available <= 0) {
      setAttachmentError(`You can attach up to ${MAX_ATTACHMENTS} files.`);
      return;
    }
    const selected = Array.from(files).slice(0, available);
    if (files.length > available) {
      setAttachmentError(`Only the first ${available} files were added.`);
    }
    const currentBytes = attachments.reduce((sum, item) => sum + item.size, 0);
    let acceptedBytes = currentBytes;
    const accepted: File[] = [];
    for (const file of selected) {
      if (file.size > MAX_ATTACHMENT_BYTES) {
        setAttachmentError(`${file.name} exceeds the 20 MB file limit.`);
        continue;
      }
      if (acceptedBytes + file.size > MAX_ATTACHMENTS_BYTES) {
        setAttachmentError('Attachments exceed the 40 MB total limit.');
        continue;
      }
      acceptedBytes += file.size;
      accepted.push(file);
    }
    if (accepted.length === 0) return;
    setReadingAttachments(true);
    try {
      const next = await Promise.all(
        accepted.map(async (file, index): Promise<PendingAttachment> => {
          const mime = file.type || 'application/octet-stream';
          const rawDataUrl = await readFileAsDataUrl(file);
          const dataUrl = rawDataUrl.replace(/^data:[^;]*;/, `data:${mime};`);
          return {
            id: `${Date.now()}-${index}-${file.name}`,
            name: file.name,
            mime,
            size: file.size,
            dataUrl,
          };
        }),
      );
      setAttachments((current) => [...current, ...next]);
    } catch {
      setAttachmentError('Failed to read one or more files.');
    } finally {
      setReadingAttachments(false);
    }
  };

  const loadModels = (): void => {
    if (models || !meta) return;
    setModelsErr(null);
    api.opencodeModels(meta.cwd).then(
      (response) => setModels(response),
      (error) => setModelsErr(error instanceof Error ? error.message : 'Failed to load models'),
    );
  };

  const openModelSheet = (): void => {
    setModelSheetOpen(true);
    loadModels();
  };

  const selectModel = (value: string | null): void => {
    if (!sockRef.current?.setModel(value)) return;
    setOptimisticModel(value);
    setOptimisticVariant(null);
    const entry = findModel(models, value);
    if (!entry || entry.variants.length === 0) setModelSheetOpen(false);
  };

  const selectVariant = (value: string | null): void => {
    if (!sockRef.current?.setVariant(value)) return;
    setOptimisticVariant(value);
    setModelSheetOpen(false);
  };

  const openAgentSheet = (): void => {
    setMenuOpen(false);
    setAgentSheetOpen(true);
    if (agents || !meta) return;
    setAgentsErr(null);
    api.opencodeAgents(meta.cwd).then(
      (response) => setAgents(response),
      (error) => setAgentsErr(error instanceof Error ? error.message : 'Failed to load agents'),
    );
  };

  const selectAgent = (value: string | null): void => {
    if (!sockRef.current?.setAgent(value)) return;
    setOptimisticAgent(value);
    setAgentSheetOpen(false);
  };

  const compactCtx = (): void => {
    setMenuOpen(false);
    sockRef.current?.compactContext();
  };

  const clearCtx = (): void => {
    setMenuOpen(false);
    if (!window.confirm('Clear the context? The agent starts over from scratch (the history stays visible).'))
      return;
    sockRef.current?.clearContext();
  };

  const remove = async (): Promise<void> => {
    setMenuOpen(false);
    if (!window.confirm('Delete this session?')) return;
    try {
      await api.deleteSession(id);
      useStore.getState().removeSession(id);
      navigate('/', { replace: true });
    } catch {
      /* lascia la sessione: l'utente può riprovare */
    }
  };

  const pending = chat.pendingPermissions[0];
  const pendingQuestion = chat.pendingQuestions[0];

  return (
    <div className="flex h-dvh flex-col pt-safe">
      {/* Header sticky */}
      <header className="z-20 flex items-center gap-1 border-b border-white/5 bg-app/95 px-1 py-1.5 backdrop-blur">
        <button
          onClick={() => navigate('/')}
          className="grid h-11 w-11 shrink-0 place-items-center rounded-full text-zinc-300 active:bg-white/5"
          aria-label="Back"
        >
          <IconChevronLeft />
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span
              className={`h-2 w-2 shrink-0 rounded-full ${STATUS_DOT[chat.status]} ${
                running ? 'animate-pulse' : ''
              }`}
            />
            <span className="truncate text-sm font-semibold text-zinc-100">{title}</span>
          </div>
          {meta && <div className="truncate text-[11px] text-zinc-500">{meta.cwd}</div>}
        </div>
        <button
          onClick={openModelSheet}
          className="max-w-40 shrink-0 truncate rounded-full border border-white/10 bg-raised px-3 py-1.5 text-[11px] font-medium text-zinc-300 active:bg-white/5"
        >
          {modelShortLabel(currentModel)}
          {currentVariant ? ` · ${currentVariant}` : ''}
        </button>
        <button
          onClick={() => setMenuOpen((v) => !v)}
          className="grid h-11 w-11 shrink-0 place-items-center rounded-full text-zinc-400 active:bg-white/5"
          aria-label="Menu"
        >
          <IconKebab className="h-4.5 w-4.5" />
        </button>

        {menuOpen && (
          <div className="absolute top-14 right-2 z-30 overflow-hidden rounded-xl border border-white/10 bg-raised shadow-xl">
            <button
              onClick={openAgentSheet}
              disabled={conn !== 'open'}
              className="flex min-h-11 w-52 items-center justify-between gap-3 px-4 text-sm text-zinc-200 active:bg-white/5 disabled:opacity-40"
            >
              <span>Agent</span>
              <span className="max-w-28 truncate text-xs text-zinc-500">
                {currentAgent ?? 'default'}
              </span>
            </button>
            <button
              onClick={compactCtx}
              disabled={busy}
              className="flex min-h-11 w-52 items-center px-4 text-sm text-zinc-200 active:bg-white/5 disabled:opacity-40"
            >
              Compact context
            </button>
            <button
              onClick={clearCtx}
              disabled={busy}
              className="flex min-h-11 w-52 items-center px-4 text-sm text-zinc-200 active:bg-white/5 disabled:opacity-40"
            >
              Clear context
            </button>
            <button
              onClick={() => void remove()}
              className="flex min-h-11 w-52 items-center gap-2.5 px-4 text-sm text-red-400 active:bg-white/5"
            >
              <IconTrash className="h-4 w-4" />
              Delete
            </button>
          </div>
        )}
      </header>

      {menuOpen && <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} />}

      {conn !== 'open' && (
        <div className="bg-amber-400/10 px-4 py-1 text-center text-[11px] text-amber-300">
          {conn === 'connecting' ? 'connecting…' : 'reconnecting…'}
        </div>
      )}

      {/* Thread */}
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="relative min-h-0 flex-1 overflow-y-auto px-4 py-3"
      >
        <div className="mx-auto max-w-2xl space-y-3">
          {chat.items.map((item) => (
            <ChatItemView key={item.key} item={item} />
          ))}
          {chat.pendingText && (
            <div className="max-w-full">
              <Markdown text={chat.pendingText} />
              <span className="ml-0.5 inline-block h-4 w-2 animate-pulse rounded-sm bg-accent/70 align-text-bottom" />
            </div>
          )}
          {running && !chat.pendingText && (
            <div className="flex items-center gap-2 text-xs text-zinc-500">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
              working…
            </div>
          )}
        </div>
      </div>

      {!atBottom && (
        <div className="pointer-events-none relative z-10">
          <button
            onClick={() => {
              atBottomRef.current = true;
              scrollToBottom();
            }}
            className="pointer-events-auto absolute -top-12 right-4 flex items-center gap-1.5 rounded-full border border-white/10 bg-raised px-3 py-2 text-xs text-zinc-200 shadow-lg"
          >
            <IconArrowDown className="h-3.5 w-3.5" />
            latest messages
          </button>
        </div>
      )}

      {/* Richiesta permesso: sheet fisso sopra il composer */}
      {pending && (
        <PermissionPrompt
          pending={pending}
          onAllow={(updatedPermissions) =>
            sockRef.current?.permissionResponse(pending.requestId, 'allow', {
              updatedInput: pending.input,
              ...(updatedPermissions ? { updatedPermissions } : {}),
            })
          }
          onDeny={() =>
            sockRef.current?.permissionResponse(pending.requestId, 'deny', {
              message: 'Denied by user',
            })
          }
        />
      )}

      {pendingQuestion && !pending && (
        <QuestionPrompt
          key={pendingQuestion.requestId}
          pending={pendingQuestion}
          onSubmit={(answers) =>
            sockRef.current?.questionResponse(pendingQuestion.requestId, answers)
          }
          onReject={() => sockRef.current?.rejectQuestion(pendingQuestion.requestId)}
        />
      )}

      {/* Selettore modello OpenCode */}
      <Sheet
        open={modelSheetOpen}
        title="Model & reasoning"
        onClose={() => setModelSheetOpen(false)}
      >
        {modelsErr && (
          <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
            {modelsErr}
          </div>
        )}
        {!modelsErr && !models && (
          <div className="py-6 text-center text-sm text-zinc-500">loading models…</div>
        )}
        {models && (
          <div className="space-y-4">
            <ModelRow
              label="OpenCode default"
              sub="use the configured default model"
              selected={currentModel === null}
              onClick={() => selectModel(null)}
            />
            {models.providers.map((p) => (
              <div key={p.id}>
                <div className="mb-1.5 text-[11px] font-semibold tracking-wide text-zinc-500 uppercase">
                  {p.name}
                </div>
                <div className="divide-y divide-white/5 overflow-hidden rounded-xl border border-white/5">
                  {p.models.map((m) => (
                    <div key={m.id}>
                      <ModelRow
                        label={m.name}
                        sub={
                          m.id +
                          (p.defaultModelID === m.id ? ' · default' : '') +
                          modelInputLabel(m)
                        }
                        selected={currentModel === `${p.id}/${m.id}`}
                        onClick={() => selectModel(`${p.id}/${m.id}`)}
                      />
                      {currentModel === `${p.id}/${m.id}` && m.variants.length > 0 && (
                        <VariantPicker
                          variants={m.variants}
                          selected={currentVariant}
                          onSelect={selectVariant}
                        />
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ))}
            {models.providers.length === 0 && (
              <div className="py-4 text-center text-sm text-zinc-500">
                No provider configured: run «opencode auth login» on the PC.
              </div>
            )}
          </div>
        )}
      </Sheet>

      {/* Selettore agente primario OpenCode */}
      <Sheet
        open={agentSheetOpen}
        title="Agent"
        onClose={() => setAgentSheetOpen(false)}
      >
        {agentsErr && (
          <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
            {agentsErr}
          </div>
        )}
        {!agentsErr && !agents && (
          <div className="py-6 text-center text-sm text-zinc-500">loading agents…</div>
        )}
        {agents && (
          <div className="overflow-hidden rounded-xl border border-white/5">
            <AgentRow
              agent={null}
              selected={currentAgent === null}
              onClick={() => selectAgent(null)}
            />
            {agents.agents.map((agent) => (
              <AgentRow
                key={agent.name}
                agent={agent}
                selected={currentAgent === agent.name}
                onClick={() => selectAgent(agent.name)}
              />
            ))}
          </div>
        )}
      </Sheet>

      {/* Composer */}
      <div
        className="border-t border-white/5 bg-surface px-3 pt-2"
        style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 0.5rem)' }}
      >
        <div className="mx-auto max-w-2xl">
          {attachmentError && (
            <div className="mb-2 text-xs text-red-300">{attachmentError}</div>
          )}
          {attachmentCompatibilityError && (
            <button
              onClick={openModelSheet}
              className="mb-2 w-full rounded-xl border border-amber-400/20 bg-amber-400/10 px-3 py-2 text-left text-xs leading-relaxed text-amber-200"
            >
              {attachmentCompatibilityError} Tap to choose a compatible model.
            </button>
          )}
          {attachments.length > 0 && (
            <div className="mb-2 flex gap-2 overflow-x-auto pb-1">
              {attachments.map((attachment) => (
                <div
                  key={attachment.id}
                  className="relative flex h-16 min-w-32 max-w-48 items-center gap-2 rounded-xl border border-white/10 bg-raised p-2 pr-7"
                >
                  {attachment.mime.startsWith('image/') ? (
                    <img
                      src={attachment.dataUrl}
                      alt=""
                      className="h-11 w-11 shrink-0 rounded-lg object-cover"
                    />
                  ) : (
                    <span className="grid h-11 w-11 shrink-0 place-items-center rounded-lg bg-white/5 text-zinc-400">
                      <IconFile className="h-5 w-5" />
                    </span>
                  )}
                  <span className="min-w-0">
                    <span className="block truncate text-xs font-medium text-zinc-200">
                      {attachment.name}
                    </span>
                    <span className="block text-[10px] text-zinc-500">
                      {formatFileSize(attachment.size)}
                    </span>
                  </span>
                  <button
                    onClick={() =>
                      setAttachments((current) =>
                        current.filter((item) => item.id !== attachment.id),
                      )
                    }
                    className="absolute top-1 right-1 grid h-6 w-6 place-items-center rounded-full text-zinc-500 active:bg-white/10"
                    aria-label={`Remove ${attachment.name}`}
                  >
                    <IconX className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="flex items-end gap-2">
            <input
              ref={fileRef}
              type="file"
              multiple
              className="hidden"
              onChange={(event) => {
                void addAttachments(event.target.files);
                event.target.value = '';
              }}
            />
            <button
              onClick={() => {
                loadModels();
                fileRef.current?.click();
              }}
              disabled={busy || readingAttachments || attachments.length >= MAX_ATTACHMENTS}
              className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl border border-white/5 bg-raised text-zinc-300 active:bg-white/5 disabled:opacity-30"
              aria-label="Attach files"
            >
              <IconPaperclip className="h-5 w-5" />
            </button>
            <textarea
              ref={taRef}
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                const el = e.target;
                el.style.height = 'auto';
                el.style.height = `${Math.min(el.scrollHeight, 144)}px`; // ~6 righe
              }}
              rows={1}
              placeholder={attachments.length > 0 ? 'Add a message…' : 'Type a message…'}
              enterKeyHint="enter"
              className="max-h-36 min-h-11 flex-1 resize-none rounded-2xl border border-white/5 bg-raised px-4 py-2.5 text-[15px] leading-relaxed text-zinc-100 placeholder:text-zinc-600 focus:border-accent/40 focus:outline-none"
            />
            {running ? (
            <button
              onClick={() => sockRef.current?.interrupt()}
              className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-red-500/90 text-white active:opacity-80"
              aria-label="Stop"
            >
              <IconStop className="h-5 w-5" />
            </button>
          ) : (
            <button
              onClick={send}
              disabled={
                (!text.trim() && attachments.length === 0) ||
                readingAttachments ||
                !!attachmentCompatibilityError ||
                conn !== 'open' ||
                chat.status === 'waiting_permission' ||
                chat.status === 'waiting_input'
              }
              className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-accent text-black active:opacity-80 disabled:opacity-30"
              aria-label="Send"
            >
              <IconSend className="h-5 w-5" />
            </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function findModel(models: OpencodeModelsResponse | null, value: string | null) {
  if (!models || !value) return null;
  const slash = value.indexOf('/');
  if (slash <= 0) return null;
  const providerID = value.slice(0, slash);
  const modelID = value.slice(slash + 1);
  return (
    models.providers
      .find((provider) => provider.id === providerID)
      ?.models.find((model) => model.id === modelID) ?? null
  );
}

function getAttachmentCompatibilityError(
  model: string | null,
  entry: OpencodeModelEntry | null,
  attachments: PendingAttachment[],
): string | null {
  if (!model || attachments.length === 0) return null;
  const required = new Set<string>();
  if (attachments.some((item) => item.mime.startsWith('image/'))) required.add('image');
  if (attachments.some((item) => item.mime === 'application/pdf')) required.add('pdf');
  if (attachments.some((item) => item.mime.startsWith('audio/'))) required.add('audio');
  if (attachments.some((item) => item.mime.startsWith('video/'))) required.add('video');
  if (required.size === 0) return null;
  if (!entry) return `Checking attachment support for ${model}.`;
  const unsupported = [...required].filter(
    (kind) => !entry.input[kind as keyof OpencodeModelEntry['input']],
  );
  if (unsupported.length === 0) return null;
  return `${entry.name} does not support ${unsupported.join(' or ')} input.`;
}

function modelInputLabel(model: OpencodeModelEntry): string {
  const supported = [
    model.input.image ? 'image' : null,
    model.input.pdf ? 'PDF' : null,
    model.input.audio ? 'audio' : null,
    model.input.video ? 'video' : null,
  ].filter((value): value is string => value !== null);
  return supported.length > 0 ? ` · ${supported.join(' + ')}` : '';
}

function modelShortLabel(model: string | null): string {
  if (!model) return 'auto';
  const slash = model.indexOf('/');
  return slash >= 0 ? model.slice(slash + 1) : model;
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('read failed'));
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsDataURL(file);
  });
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function ModelRow({
  label,
  sub,
  selected,
  onClick,
}: {
  label: string;
  sub?: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="flex min-h-12 w-full items-center gap-3 border-b border-white/5 bg-raised px-4 py-2 text-left last:border-b-0 active:bg-white/5"
    >
      <span className="min-w-0 flex-1">
        <span
          className={`block truncate text-sm ${selected ? 'font-semibold text-accent' : 'text-zinc-200'}`}
        >
          {label}
        </span>
        {sub && <span className="block truncate text-[11px] text-zinc-500">{sub}</span>}
      </span>
      {selected && <IconCheck className="h-4 w-4 shrink-0 text-accent" />}
    </button>
  );
}

function VariantPicker({
  variants,
  selected,
  onSelect,
}: {
  variants: string[];
  selected: string | null;
  onSelect: (variant: string | null) => void;
}) {
  return (
    <div className="border-t border-white/5 bg-black/15 px-4 py-3">
      <div className="mb-2 text-[11px] font-medium text-zinc-400">Reasoning effort</div>
      <div className="flex flex-wrap gap-2">
        <VariantChip label="Auto" selected={selected === null} onClick={() => onSelect(null)} />
        {variants.map((variant) => (
          <VariantChip
            key={variant}
            label={variant}
            selected={selected === variant}
            onClick={() => onSelect(variant)}
          />
        ))}
      </div>
    </div>
  );
}

function VariantChip({
  label,
  selected,
  onClick,
}: {
  label: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`min-h-9 rounded-full border px-3 text-xs font-medium capitalize ${
        selected
          ? 'border-accent/60 bg-accent/15 text-accent'
          : 'border-white/10 bg-raised text-zinc-300 active:bg-white/5'
      }`}
    >
      {label}
    </button>
  );
}

function AgentRow({
  agent,
  selected,
  onClick,
}: {
  agent: OpencodeAgentEntry | null;
  selected: boolean;
  onClick: () => void;
}) {
  const name = agent?.name ?? 'OpenCode default';
  const description =
    agent?.description ??
    'Use the default primary agent configured by OpenCode (normally build).';
  return (
    <button
      onClick={onClick}
      className="w-full border-b border-white/5 bg-raised px-4 py-3 text-left last:border-b-0 active:bg-white/5"
    >
      <span className="flex items-center gap-3">
        <span className="min-w-0 flex-1">
          <span
            className={`block text-sm font-semibold ${
              selected ? 'text-accent' : 'text-zinc-200'
            }`}
          >
            {name}
          </span>
          <span className="mt-0.5 block text-xs leading-relaxed text-zinc-500">
            {description}
          </span>
          {agent && (
            <span className="mt-2 flex flex-wrap gap-1.5">
              <PermissionBadge label="edit" level={agent.permissions.edit} />
              <PermissionBadge label="bash" level={agent.permissions.bash} />
              {!agent.native && (
                <span className="rounded-full bg-sky-400/10 px-2 py-0.5 text-[10px] font-medium text-sky-300">
                  custom
                </span>
              )}
            </span>
          )}
        </span>
        {selected && <IconCheck className="h-4 w-4 shrink-0 text-accent" />}
      </span>
    </button>
  );
}

function PermissionBadge({
  label,
  level,
}: {
  label: string;
  level: OpencodePermissionLevel;
}) {
  const colors: Record<OpencodePermissionLevel, string> = {
    allow: 'bg-emerald-400/10 text-emerald-300',
    ask: 'bg-amber-400/10 text-amber-300',
    deny: 'bg-red-400/10 text-red-300',
    mixed: 'bg-violet-400/10 text-violet-300',
    unknown: 'bg-white/5 text-zinc-400',
  };
  return (
    <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${colors[level]}`}>
      {label}: {level}
    </span>
  );
}

function ChatItemView({ item }: { item: ChatItem }) {
  switch (item.role) {
    case 'user':
      return (
        <div className="flex justify-end">
          <div className="max-w-[85%] space-y-2 rounded-2xl rounded-br-md bg-accent px-4 py-2.5 text-[15px] leading-relaxed text-emerald-950">
            {item.attachments.length > 0 && (
              <div className="space-y-1">
                {item.attachments.map((attachment, index) => (
                  <div
                    key={`${attachment.name}-${index}`}
                    className="flex items-center gap-2 rounded-lg bg-black/10 px-2 py-1.5 text-xs"
                  >
                    <IconFile className="h-4 w-4 shrink-0" />
                    <span className="min-w-0 flex-1 truncate">{attachment.name}</span>
                    <span className="shrink-0 opacity-60">{formatFileSize(attachment.size)}</span>
                  </div>
                ))}
              </div>
            )}
            {item.text && <div className="whitespace-pre-wrap break-words">{item.text}</div>}
          </div>
        </div>
      );
    case 'assistant':
      return (
        <div className="space-y-2">
          {item.parts.map((p, i) =>
            p.kind === 'text' ? (
              <Markdown key={i} text={p.text} />
            ) : (
              <ToolCard key={p.id} part={p} />
            ),
          )}
        </div>
      );
    case 'result':
      return (
        <div
          className={`py-1 text-center text-[11px] ${
            item.result.isError ? 'text-red-400' : 'text-zinc-600'
          }`}
        >
          {typeof item.result.totalCostUsd === 'number'
            ? `${fmtCost(item.result.totalCostUsd)} · `
            : ''}
          {fmtDuration(item.result.durationMs)} · {item.result.numTurns}{' '}
          {item.result.numTurns === 1 ? 'turn' : 'turns'}
        </div>
      );
    case 'error':
      return (
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm break-words text-red-300">
          {item.message}
        </div>
      );
    case 'notice':
      return (
        <div className="flex items-center gap-3 py-1 text-[11px] text-zinc-500">
          <span className="h-px flex-1 bg-white/10" />
          <span className="max-w-[80%] text-center">{item.text}</span>
          <span className="h-px flex-1 bg-white/10" />
        </div>
      );
  }
}

function PermissionPrompt({
  pending,
  onAllow,
  onDeny,
}: {
  pending: PendingPermission;
  onAllow: (updatedPermissions?: unknown[]) => void;
  onDeny: () => void;
}) {
  // opencode_always = "Consenti sempre" di OpenCode.
  const alwaysSuggestions = pending.suggestions.filter((s) => s.type === 'opencode_always');
  return (
    <div className="border-t border-amber-400/20 bg-[#15120a] px-4 py-3">
      <div className="mx-auto max-w-2xl">
        <div className="mb-1.5 flex items-center gap-2">
          <span className="h-2 w-2 animate-pulse rounded-full bg-amber-400" />
          <span className="text-sm font-semibold text-amber-200">
            Permission requested: {pending.displayName ?? pending.toolName}
          </span>
        </div>
        {pending.description && (
          <div className="mb-1.5 text-xs text-zinc-400">{pending.description}</div>
        )}
        <pre className="mb-3 max-h-36 overflow-auto rounded-lg bg-black/40 p-2 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap break-all text-zinc-300">
          {stringifyInput(pending.input)}
        </pre>
        <div className="flex gap-2">
          <button
            onClick={() => onAllow()}
            className="min-h-11 flex-1 rounded-xl bg-accent text-sm font-semibold text-black active:opacity-80"
          >
            Allow
          </button>
          <button
            onClick={onDeny}
            className="min-h-11 flex-1 rounded-xl border border-white/10 bg-raised text-sm font-semibold text-zinc-200 active:bg-white/5"
          >
            Deny
          </button>
        </div>
        {alwaysSuggestions.length > 0 && (
          <div className="mt-2 space-y-1.5">
            {alwaysSuggestions.map((s, i) => (
              <button
                key={i}
                onClick={() => onAllow([s])}
                className="min-h-11 w-full rounded-xl border border-accent/30 bg-accent/10 px-3 text-sm font-medium text-emerald-200 active:bg-accent/20"
              >
                {suggestionLabel(s)}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function QuestionPrompt({
  pending,
  onSubmit,
  onReject,
}: {
  pending: PendingQuestion;
  onSubmit: (answers: string[][]) => void;
  onReject: () => void;
}) {
  const [selected, setSelected] = useState<string[][]>(() =>
    pending.questions.map(() => []),
  );
  const [custom, setCustom] = useState<string[]>(() => pending.questions.map(() => ''));

  const toggleOption = (questionIndex: number, label: string, multiple: boolean): void => {
    setSelected((current) =>
      current.map((answer, index) => {
        if (index !== questionIndex) return answer;
        if (!multiple) return [label];
        return answer.includes(label)
          ? answer.filter((value) => value !== label)
          : [...answer, label];
      }),
    );
    if (!multiple) {
      setCustom((current) =>
        current.map((value, index) => (index === questionIndex ? '' : value)),
      );
    }
  };

  const answers = pending.questions.map((question, index) => {
    const freeText = custom[index]?.trim() ?? '';
    if (!question.multiple && freeText) return [freeText];
    return freeText ? [...(selected[index] ?? []), freeText] : (selected[index] ?? []);
  });
  const complete = answers.every((answer) => answer.length > 0);

  return (
    <div className="max-h-[58dvh] overflow-y-auto border-t border-sky-400/20 bg-[#09131a] px-4 py-3">
      <div className="mx-auto max-w-2xl">
        <div className="mb-3 flex items-center gap-2">
          <span className="h-2 w-2 animate-pulse rounded-full bg-sky-400" />
          <span className="text-sm font-semibold text-sky-200">Agent needs your input</span>
        </div>

        <div className="space-y-4">
          {pending.questions.map((question, questionIndex) => (
            <fieldset key={questionIndex}>
              <legend className="mb-2 w-full">
                <span className="block text-[11px] font-semibold tracking-wide text-sky-300 uppercase">
                  {question.header}
                </span>
                <span className="mt-0.5 block text-sm leading-relaxed text-zinc-200">
                  {question.question}
                </span>
                {question.multiple && (
                  <span className="mt-0.5 block text-[11px] text-zinc-500">
                    Select one or more options
                  </span>
                )}
              </legend>

              {question.options.length > 0 && (
                <div className="space-y-1.5">
                  {question.options.map((option) => {
                    const checked = selected[questionIndex]?.includes(option.label) ?? false;
                    return (
                      <button
                        key={option.label}
                        type="button"
                        onClick={() =>
                          toggleOption(questionIndex, option.label, question.multiple)
                        }
                        className={`flex min-h-11 w-full items-start gap-3 rounded-xl border px-3 py-2.5 text-left ${
                          checked
                            ? 'border-sky-400/50 bg-sky-400/10'
                            : 'border-white/10 bg-raised active:bg-white/5'
                        }`}
                      >
                        <span
                          className={`mt-0.5 grid h-4 w-4 shrink-0 place-items-center border ${
                            question.multiple ? 'rounded' : 'rounded-full'
                          } ${
                            checked
                              ? 'border-sky-400 bg-sky-400 text-black'
                              : 'border-zinc-600'
                          }`}
                        >
                          {checked && <IconCheck className="h-3 w-3" />}
                        </span>
                        <span className="min-w-0">
                          <span className="block text-sm font-medium text-zinc-200">
                            {option.label}
                          </span>
                          {option.description && (
                            <span className="mt-0.5 block text-xs leading-relaxed text-zinc-500">
                              {option.description}
                            </span>
                          )}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}

              {question.custom && (
                <input
                  value={custom[questionIndex] ?? ''}
                  onChange={(event) => {
                    const value = event.target.value;
                    setCustom((current) =>
                      current.map((item, index) => (index === questionIndex ? value : item)),
                    );
                    if (!question.multiple && value.trim()) {
                      setSelected((current) =>
                        current.map((item, index) => (index === questionIndex ? [] : item)),
                      );
                    }
                  }}
                  placeholder="Type a custom answer…"
                  className="mt-2 min-h-11 w-full rounded-xl border border-white/10 bg-raised px-3 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-sky-400/50 focus:outline-none"
                />
              )}
            </fieldset>
          ))}
        </div>

        <div className="mt-4 flex gap-2">
          <button
            onClick={() => onSubmit(answers)}
            disabled={!complete}
            className="min-h-11 flex-1 rounded-xl bg-sky-400 text-sm font-semibold text-sky-950 active:opacity-80 disabled:opacity-30"
          >
            Submit
          </button>
          <button
            onClick={onReject}
            className="min-h-11 flex-1 rounded-xl border border-white/10 bg-raised text-sm font-semibold text-zinc-200 active:bg-white/5"
          >
            Reject
          </button>
        </div>
      </div>
    </div>
  );
}

function suggestionLabel(s: { type: string; [key: string]: unknown }): string {
  const patterns = Array.isArray(s['patterns'])
    ? (s['patterns'] as unknown[]).filter((x): x is string => typeof x === 'string')
    : [];
  return patterns.length > 0 ? `Always allow (${patterns.join(', ')})` : 'Always allow';
}
