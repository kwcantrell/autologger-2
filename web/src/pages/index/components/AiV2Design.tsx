import clsx from 'clsx';
import {
  type FormEvent,
  type MutableRefObject,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from 'react';
import { API_ROOT } from '../../../api/client';
import { parseSseFrames } from './AiChat';
import { FEED_GLASS_BTN, FEED_GLASS_BTN_PRIMARY } from './FeedTable';

// AI v2 design rail (ai-v2-dashboards, tasks 4.1/4.2; design "UI design
// brief" — canvas + docked design rail topology; spec "AI v2 tab in the
// session workspace" + "Design question round trip" + "Previews reflect the
// rendered result"). This is the AI-chat sibling's proven shape (AiChat.tsx),
// adapted for a DIFFERENT wire contract: the design turn's SSE vocabulary is
// `delta` (assistant text) / `question` (pending AskUserQuestion, addressed
// only to this turn's own stream — never the session WS) / `done` (terminal
// success) / `error` ({ detail }, terminal failure) — no `tool` event.
// `parseSseFrames` is reused directly from AiChat.tsx rather than
// re-implemented: it is generic frame-splitting, not chat-specific.
//
// Controlled component: conversation/streaming/abort/pending-question state
// all live one level up (AiV2Panel, task 4.1) — mirroring AiPanel's hoisting
// of AiChat's state — so a top-level tab switch away from "AI v2" and back
// never unmounts this component, never aborts an in-flight design turn, and
// never clears the conversation or a pending question (spec "AI v2 tab in
// the session workspace": "switching tabs neither aborts an in-flight design
// turn nor clears the conversation").
//
// No agent-authored markup anywhere in this file (repo-wide invariant, spec
// "No agent-authored markup is ever rendered"): assistant text, question
// text, and option label/description are ALL rendered as plain React text
// children — never `dangerouslySetInnerHTML`, never interpolated into
// `href`/`src`/`style`.

export type AiV2Message =
  | { id: string; role: 'user'; text: string }
  | { id: string; role: 'assistant'; text: string }
  | { id: string; role: 'error'; detail: string };

/** One selectable option on a pending question. `widgetType` is the catalog
 * widget-type identifier the agent supplied on this option (echoed VERBATIM
 * on answer, never matched against `label`/`description` — spec "Previews
 * reflect the rendered result": "never an inference from agent-authored
 * display text"); `undefined` when the option carries none, in which case it
 * cannot be selected as an 'option' answer. `raw` is the preview-stripped
 * option record verbatim, so a later unit (4.4) can read whatever
 * catalog-preview-input fields it needs without this file knowing their
 * shape. */
export interface AiV2QuestionOption {
  label: string;
  description: string | undefined;
  widgetType: string | undefined;
  raw: Record<string, unknown>;
}

export interface AiV2Question {
  question: string;
  header: string;
  multiSelect: boolean;
  options: AiV2QuestionOption[];
}

export interface AiV2PendingQuestion {
  requestId: string;
  turnId: string;
  questions: AiV2Question[];
}

export type AiV2AnswerItem =
  | { kind: 'option'; widgetType: string }
  | { kind: 'text'; text: string };

export interface AiV2DesignProps {
  sessionId: string;
  messages: AiV2Message[];
  onMessagesChange: (updater: AiV2Message[] | ((prev: AiV2Message[]) => AiV2Message[])) => void;
  isStreaming: boolean;
  onStreamingChange: (streaming: boolean) => void;
  abortControllerRef: MutableRefObject<AbortController | null>;
  pendingQuestion: AiV2PendingQuestion | null;
  onPendingQuestionChange: (question: AiV2PendingQuestion | null) => void;
  /** Set by a caller (e.g. the canvas empty state's "Design with AI" CTA,
   * design D7a) to kick off a design turn with this exact message. Consumed
   * exactly once via `onPendingStartConsumed` — a controlled-input reset
   * pattern rather than an imperative ref handle, so the canvas seam and this
   * rail stay decoupled. */
  pendingStart?: string | null;
  onPendingStartConsumed?: () => void;
  /**
   * PREVIEW SLOT — the seam Unit 2 (task 4.4, real widget-component previews)
   * fills in. Renders the live preview for one question option through the
   * REAL widget component (spec "Previews reflect the rendered result":
   * preview and rendered widget must resolve to the SAME component — this
   * file never renders a preview itself). Receives the option's catalog
   * `widgetType` (`undefined` when the option carries none) and the option
   * record. Left `undefined` here (Unit 1's default): no preview renders at
   * all — never a fabricated stand-in — until Unit 2 wires it in.
   */
  renderOptionPreview?: (widgetType: string | undefined, option: AiV2QuestionOption) => ReactNode;
}

const CONNECTION_LOST_DETAIL = 'Connection to the design turn was lost before it finished.';

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

async function extractErrorDetail(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { detail?: unknown };
    if (typeof body.detail === 'string' && body.detail.trim()) return body.detail;
  } catch {
    // Non-JSON or empty body — fall back below.
  }
  return fallback;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function parseOption(raw: unknown): AiV2QuestionOption | null {
  if (!isRecord(raw)) return null;
  const label = typeof raw.label === 'string' && raw.label.trim() ? raw.label : 'Option';
  const description = typeof raw.description === 'string' ? raw.description : undefined;
  const widgetType =
    typeof raw.widgetType === 'string' && raw.widgetType.trim() ? raw.widgetType : undefined;
  return { label, description, widgetType, raw };
}

function parseQuestion(raw: unknown): AiV2Question | null {
  if (!isRecord(raw)) return null;
  const question = typeof raw.question === 'string' ? raw.question : '';
  const header = typeof raw.header === 'string' ? raw.header : '';
  const multiSelect = Boolean(raw.multiSelect);
  const rawOptions = Array.isArray(raw.options) ? raw.options : [];
  const options = rawOptions.map(parseOption).filter((o): o is AiV2QuestionOption => o !== null);
  return { question, header, multiSelect, options };
}

/** Defensive parse of the `question` SSE frame's JSON payload
 * (`{ requestId, turnId, questions: [...] }` — Phase-3 fix wave's flattened
 * shape). Returns `null` for anything unusable rather than throwing; a
 * question this can't parse is silently dropped and the turn's own timeout
 * backstop still ends it (spec "Subprocess and turn lifecycle") — never
 * surfaced here as a fabricated error. */
export function parsePendingQuestion(raw: unknown): AiV2PendingQuestion | null {
  if (!isRecord(raw)) return null;
  const requestId = typeof raw.requestId === 'string' ? raw.requestId : undefined;
  const turnId = typeof raw.turnId === 'string' ? raw.turnId : undefined;
  if (!requestId || !turnId) return null;
  const rawQuestions = Array.isArray(raw.questions) ? raw.questions : [];
  const questions = rawQuestions.map(parseQuestion).filter((q): q is AiV2Question => q !== null);
  if (questions.length === 0) return null;
  return { requestId, turnId, questions };
}

export function AiV2Design({
  sessionId,
  messages,
  onMessagesChange,
  isStreaming,
  onStreamingChange,
  abortControllerRef,
  pendingQuestion,
  onPendingQuestionChange,
  pendingStart,
  onPendingStartConsumed,
  renderOptionPreview,
}: AiV2DesignProps) {
  const [input, setInput] = useState('');
  const [notConfigured, setNotConfigured] = useState(false);
  const [draftAnswers, setDraftAnswers] = useState<Record<number, AiV2AnswerItem>>({});
  const [freeTextInputs, setFreeTextInputs] = useState<Record<number, string>>({});
  const [answering, setAnswering] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: keep the transcript pinned to the newest message as it grows
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, pendingQuestion]);

  // A new pending question (by requestId) resets any in-progress draft
  // answers/free-text so a stale selection from a previous question never
  // leaks into the next one's submission.
  // biome-ignore lint/correctness/useExhaustiveDependencies: deliberately keyed on requestId alone, not the whole pendingQuestion object, so a same-question re-render never re-triggers the reset
  useEffect(() => {
    setDraftAnswers({});
    setFreeTextInputs({});
  }, [pendingQuestion?.requestId]);

  async function sendMessage(rawText: string) {
    const text = rawText.trim();
    if (!text || isStreaming) return;

    setInput('');
    setNotConfigured(false);
    onMessagesChange((prev) => [...prev, { id: crypto.randomUUID(), role: 'user', text }]);
    onPendingQuestionChange(null);

    const controller = new AbortController();
    abortControllerRef.current = controller;
    onStreamingChange(true);

    try {
      const res = await fetch(`${API_ROOT}/sessions/${sessionId}/ai/v2/design`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text }),
        signal: controller.signal,
      });

      // Spec "Configuration-gated AI v2 endpoints": 503 means the deployment
      // has no AI_V2_ENABLED/key configured — an in-place explainer, not the
      // generic error path below.
      if (res.status === 503) {
        setNotConfigured(true);
        return;
      }

      if (!res.ok || !res.body) {
        const detail = await extractErrorDetail(res, `Design turn request failed (${res.status}).`);
        onMessagesChange((prev) => [...prev, { id: crypto.randomUUID(), role: 'error', detail }]);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parsed = parseSseFrames(buffer);
        buffer = parsed.rest;

        for (const frame of parsed.frames) {
          if (frame.event === 'delta') {
            const payload = safeJsonParse(frame.data) as { text?: unknown } | undefined;
            if (!payload || typeof payload.text !== 'string') continue;
            const delta = payload.text;
            onMessagesChange((prev) => {
              const last = prev[prev.length - 1];
              if (last?.role === 'assistant') {
                return [...prev.slice(0, -1), { ...last, text: last.text + delta }];
              }
              return [...prev, { id: crypto.randomUUID(), role: 'assistant', text: delta }];
            });
          } else if (frame.event === 'question') {
            // Delivered ONLY on this turn's own SSE stream (spec "Design
            // question round trip": "A question SHALL be delivered only to
            // the client that initiated that turn") — never read off the
            // session WebSocket.
            const question = parsePendingQuestion(safeJsonParse(frame.data));
            if (question) onPendingQuestionChange(question);
          } else if (frame.event === 'done') {
            onPendingQuestionChange(null);
          } else if (frame.event === 'error') {
            const payload = safeJsonParse(frame.data) as { detail?: unknown } | undefined;
            const detail =
              typeof payload?.detail === 'string' ? payload.detail : 'Design turn failed.';
            onPendingQuestionChange(null);
            onMessagesChange((prev) => [
              ...prev,
              { id: crypto.randomUUID(), role: 'error', detail },
            ]);
          }
          // Any other event type is ignored outright (forward compatibility,
          // mirrors AiChat's "Client ignores unknown event types").
        }
      }
    } catch {
      if (controller.signal.aborted) {
        // Stop was clicked: a client-aborted stream is NOT guaranteed a
        // terminal event (spec). `isStreaming` flipping back to false below
        // is the stopped-state UI signal; nothing is rendered as a failure.
      } else {
        onMessagesChange((prev) => [
          ...prev,
          { id: crypto.randomUUID(), role: 'error', detail: CONNECTION_LOST_DETAIL },
        ]);
      }
    } finally {
      onStreamingChange(false);
      abortControllerRef.current = null;
    }
  }

  // Controlled "start a turn from outside" seam (e.g. the canvas empty
  // state's "Design with AI" CTA) — consumed exactly once per value.
  // biome-ignore lint/correctness/useExhaustiveDependencies: sendMessage/onPendingStartConsumed intentionally omitted — this effect fires only on pendingStart changing, not on every render
  useEffect(() => {
    if (pendingStart) {
      onPendingStartConsumed?.();
      void sendMessage(pendingStart);
    }
  }, [pendingStart]);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    void sendMessage(input);
  }

  function handleStop() {
    abortControllerRef.current?.abort();
  }

  async function submitAnswers(answers: AiV2AnswerItem[]) {
    if (!pendingQuestion) return;
    setAnswering(true);
    try {
      const res = await fetch(`${API_ROOT}/sessions/${sessionId}/ai/v2/answer`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          turnId: pendingQuestion.turnId,
          requestId: pendingQuestion.requestId,
          answers,
        }),
      });
      if (!res.ok) {
        const detail = await extractErrorDetail(res, `Answer submission failed (${res.status}).`);
        onMessagesChange((prev) => [...prev, { id: crypto.randomUUID(), role: 'error', detail }]);
        return;
      }
      // The turn's own SSE stream (still open from sendMessage's reader
      // loop) carries whatever the agent does next; this rail only clears
      // the pending-question view.
      onPendingQuestionChange(null);
    } catch {
      onMessagesChange((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: 'error',
          detail: 'Could not reach the server to submit your answer.',
        },
      ]);
    } finally {
      setAnswering(false);
    }
  }

  function answerQuestion(questionIndex: number, answer: AiV2AnswerItem) {
    const next = { ...draftAnswers, [questionIndex]: answer };
    setDraftAnswers(next);
    if (!pendingQuestion) return;
    const answers: AiV2AnswerItem[] = [];
    for (let i = 0; i < pendingQuestion.questions.length; i += 1) {
      const a = next[i];
      if (!a) return; // not every question answered yet — wait for the rest
      answers.push(a);
    }
    void submitAnswers(answers);
  }

  return (
    <div className="flex flex-1 flex-col min-h-0" data-testid="aiv2-design-rail">
      {notConfigured ? (
        <div
          className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-v5-muted"
          data-testid="aiv2-design-not-configured"
        >
          <p className="m-0 text-sm">
            AI v2 isn't configured on this deployment. Ask an operator to set{' '}
            <code>AI_V2_ENABLED=1</code> and an <code>AI_V2_API_KEY</code> (or run loopback with the
            operator login) to enable it.
          </p>
        </div>
      ) : (
        <>
          <div
            ref={scrollRef}
            className="flex flex-1 flex-col gap-2 overflow-y-auto p-4 min-h-0"
            aria-live="polite"
            data-testid="aiv2-design-messages"
          >
            {messages.length === 0 && !pendingQuestion && (
              <p className="m-0 text-sm text-v5-muted">
                Ask for a starting dashboard and the agent proposes one from this session's
                aggregates; you adjust it directly from there.
              </p>
            )}
            {messages.map((message) => (
              <AiV2MessageRow key={message.id} message={message} />
            ))}
            {pendingQuestion && (
              <div className="flex flex-col gap-3" data-testid="aiv2-question-pending">
                {pendingQuestion.questions.map((question, qi) => (
                  <QuestionCard
                    // biome-ignore lint/suspicious/noArrayIndexKey: pendingQuestion.questions is a fixed 1-4 array replaced wholesale per requestId, never reordered
                    key={qi}
                    question={question}
                    disabled={answering}
                    selected={draftAnswers[qi]}
                    freeText={freeTextInputs[qi] ?? ''}
                    onSelectOption={(widgetType) =>
                      answerQuestion(qi, { kind: 'option', widgetType })
                    }
                    onFreeTextChange={(value) =>
                      setFreeTextInputs((prev) => ({ ...prev, [qi]: value }))
                    }
                    onSubmitFreeText={() => {
                      const text = (freeTextInputs[qi] ?? '').trim();
                      if (!text) return;
                      answerQuestion(qi, { kind: 'text', text });
                    }}
                    renderOptionPreview={renderOptionPreview}
                  />
                ))}
              </div>
            )}
          </div>
          <form
            onSubmit={handleSubmit}
            className="flex shrink-0 items-end gap-2 border-t border-v5-border p-3"
          >
            <textarea
              className="flex-1 resize-none rounded-v5-sm border border-v5-border bg-transparent px-3 py-2 text-sm text-v5-text [font-family:inherit] focus:border-[rgba(56,189,248,0.5)] focus:outline-none"
              rows={2}
              value={input}
              placeholder={
                messages.length === 0 && !pendingQuestion
                  ? 'Ask for a starting dashboard…'
                  : 'Ask for a change: "add a question-density widget"…'
              }
              disabled={isStreaming}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void sendMessage(input);
                }
              }}
            />
            {isStreaming ? (
              <button type="button" className={FEED_GLASS_BTN} onClick={handleStop}>
                Stop
              </button>
            ) : (
              <button
                type="submit"
                className={clsx(FEED_GLASS_BTN, FEED_GLASS_BTN_PRIMARY)}
                disabled={!input.trim()}
              >
                Send
              </button>
            )}
          </form>
        </>
      )}
    </div>
  );
}

function AiV2MessageRow({ message }: { message: AiV2Message }) {
  if (message.role === 'error') {
    return (
      <div className="text-sm text-v5-danger" data-testid="aiv2-design-error">
        {message.detail}
      </div>
    );
  }
  return (
    <div className="text-sm text-v5-text">
      <span className="mr-1 font-semibold text-v5-muted">
        {message.role === 'user' ? 'You:' : 'Agent:'}
      </span>
      {/* Plain text only — no markup rendering (spec "No agent-authored
          markup is ever rendered"); whitespace-pre-wrap preserves the
          assistant's line breaks/spacing without interpreting any markup. */}
      <span className="whitespace-pre-wrap [overflow-wrap:anywhere]">{message.text}</span>
    </div>
  );
}

interface QuestionCardProps {
  question: AiV2Question;
  disabled: boolean;
  selected: AiV2AnswerItem | undefined;
  freeText: string;
  onSelectOption: (widgetType: string) => void;
  onFreeTextChange: (value: string) => void;
  onSubmitFreeText: () => void;
  renderOptionPreview?: (widgetType: string | undefined, option: AiV2QuestionOption) => ReactNode;
}

/** Option cards + free-text fallback for one pending question (modelled on
 * the design mockup's `QuestionView`/`.qcard`). Selecting an option — or
 * submitting free text — answers that question; the surrounding rail waits
 * until every question in the pending set has an answer, then POSTs them all
 * together (spec: "one answer per question, matched by array position"). */
function QuestionCard({
  question,
  disabled,
  selected,
  freeText,
  onSelectOption,
  onFreeTextChange,
  onSubmitFreeText,
  renderOptionPreview,
}: QuestionCardProps) {
  return (
    <div
      className="flex flex-col gap-2 rounded-v5-sm border border-[rgba(56,189,248,0.22)] bg-[rgba(56,189,248,0.05)] p-3"
      data-testid="aiv2-question-card"
    >
      {/* Agent-authored question text — plain text only. */}
      <p className="m-0 text-sm font-semibold text-v5-text">{question.question}</p>
      <div className="flex flex-col gap-2">
        {question.options.map((option, oi) => {
          const isSelected =
            selected?.kind === 'option' && selected.widgetType === option.widgetType;
          const selectable = Boolean(option.widgetType) && !disabled;
          return (
            <button
              // biome-ignore lint/suspicious/noArrayIndexKey: question.options is a fixed list replaced wholesale with its parent question
              key={oi}
              type="button"
              disabled={!selectable}
              aria-pressed={isSelected}
              onClick={() => {
                if (option.widgetType) onSelectOption(option.widgetType);
              }}
              className={clsx(
                'flex flex-col gap-1 rounded-v5-sm border p-2 text-left text-sm transition-colors',
                isSelected
                  ? 'border-[rgba(56,189,248,0.55)] bg-[rgba(56,189,248,0.07)]'
                  : 'border-v5-border-strong bg-[rgba(255,255,255,0.03)]',
                !selectable && 'cursor-not-allowed opacity-55',
              )}
            >
              {/* Agent-authored label/description — plain text only, never
                  interpolated into markup, href, src, or style. */}
              <span className="font-medium text-v5-text">{option.label}</span>
              {option.description && (
                <span className="text-xs text-v5-muted">{option.description}</span>
              )}
              {!option.widgetType && (
                <span className="text-xs text-v5-danger">
                  No catalog widget type on this option — it can't be selected.
                </span>
              )}
              {renderOptionPreview && (
                <div
                  className="pointer-events-none rounded-v5-sm border border-v5-border bg-[rgba(7,11,20,0.55)] p-2"
                  data-testid="aiv2-option-preview-slot"
                >
                  {renderOptionPreview(option.widgetType, option)}
                </div>
              )}
            </button>
          );
        })}
      </div>
      <div className="flex items-center gap-2">
        <span className="text-xs text-v5-muted">Or describe it:</span>
        <input
          type="text"
          value={freeText}
          disabled={disabled}
          placeholder="e.g. minutes, not percentages"
          onChange={(e) => onFreeTextChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              onSubmitFreeText();
            }
          }}
          className="min-w-0 flex-1 rounded-v5-sm border border-v5-border bg-transparent px-2 py-1 text-xs text-v5-text focus:border-[rgba(56,189,248,0.5)] focus:outline-none"
        />
      </div>
    </div>
  );
}
