// The AI SDK turn's tools (ai-sdk-agent-harness design D3, "Tools"). The tool bodies are the MCP
// server's own `TOOL_BUILDERS`, reached through the `ToolSink` seam: `sdkTools` passes the turn's
// registration a collector that turns each `tool(name, description, shape, handler)` into an AI
// SDK `tool()`, every handler wrapped by the turn's `SdkToolGuard`. The guard:
//
// 1. refuses a call once the turn is not live (after abort, timeout or the turn's end), running
//    nothing;
// 2. counts calls: past 16 in one step the call gets a tool error and the turn continues (the
//    event prompt asks for one `create_event` per hit); past the per-turn cap (chat 32, generation
//    300) it sets `breached`, ends the turn (`onBreach` aborts its internal controller) and runs
//    nothing more;
// 3. runs one body at a time (the SDK starts parallel calls concurrently, A21);
// 4. translates the result: text passes through; an `isError` result becomes a tool error with
//    the body's own text (as on MCP); a thrown body error becomes the fixed "Tool failed." (the SDK
//    would otherwise send its message to the model, A22);
// 5. tracks each running body in its drain set, which the route awaits before it acts on a result
//    or releases the slot and lease.
//
// A tool error is delivered by throwing an `Error` whose message is one of the fixed texts above
// or the body's own validation text: the SDK sends a thrown error's message to the model as the
// tool error. Nothing here logs.

import { type Tool, tool } from 'ai';
import { z } from 'zod';
import type { SdkTurnRegistration, ToolSink, ToolSinkResult } from './aiMcpServer';

/** The soft per-step cap (D3). */
export const SDK_TOOL_CALLS_PER_STEP = 16;
/** The hard per-turn caps (D3): 200 events plus transcript pages and soft-capped retries. */
export const SDK_TOOL_CALLS_PER_TURN = Object.freeze({ chat: 32, generation: 300 });

export const TOOL_TURN_ENDED_TEXT = 'Turn ended.';
export const TOOL_STEP_CAP_TEXT = 'Too many tool calls in one step; continue in the next step.';
export const TOOL_FAILED_TEXT = 'Tool failed.';

export interface SdkToolGuardOptions {
  /** The per-turn call cap; the call past it breaches. */
  perTurnCap: number;
  /** Called once, on the breach: the turn aborts its internal controller. */
  onBreach: () => void;
}

/** One turn's tool-call guard. */
export class SdkToolGuard {
  private live = true;
  private breach = false;
  private step = 0;
  private total = 0;
  private readonly perStep = new Map<number, number>();
  /** The tail of the one-at-a-time chain; never rejects. */
  private lock: Promise<void> = Promise.resolve();
  private readonly inFlight = new Set<Promise<unknown>>();

  constructor(private readonly opts: SdkToolGuardOptions) {}

  /** Whether a per-turn cap was passed. */
  get breached(): boolean {
    return this.breach;
  }

  /** How many tool calls the turn has made (each counted when it arrives, run or refused). */
  get calls(): number {
    return this.total;
  }

  /** Whether calls may still run. */
  get isLive(): boolean {
    return this.live;
  }

  /** The bodies running now. */
  get running(): ReadonlySet<Promise<unknown>> {
    return this.inFlight;
  }

  /** The step now running (the turn sets it before each step). */
  setStep(step: number): void {
    this.step = step;
  }

  /** The turn is over: every later call is refused. Idempotent. */
  end(): void {
    this.live = false;
  }

  /** Resolves once no body is running. Call after `end()`, so no new body can start. */
  async drained(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.allSettled([...this.inFlight]);
  }

  /** Run one tool call's body under the guard; resolves with the text the model sees, or throws
   * an `Error` carrying the tool error's text. */
  async run(body: () => Promise<ToolSinkResult>): Promise<string> {
    if (!this.live) throw new Error(TOOL_TURN_ENDED_TEXT);
    this.total += 1;
    if (this.total > this.opts.perTurnCap) {
      if (!this.breach) {
        this.breach = true;
        this.end();
        this.opts.onBreach();
      }
      throw new Error(TOOL_TURN_ENDED_TEXT);
    }
    const inStep = (this.perStep.get(this.step) ?? 0) + 1;
    this.perStep.set(this.step, inStep);
    if (inStep > SDK_TOOL_CALLS_PER_STEP) throw new Error(TOOL_STEP_CAP_TEXT);

    const previous = this.lock;
    let release = (): void => {};
    this.lock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      if (!this.live) throw new Error(TOOL_TURN_ENDED_TEXT);
      const running = (async () => body())();
      this.inFlight.add(running);
      let result: ToolSinkResult;
      try {
        result = await running;
      } catch {
        throw new Error(TOOL_FAILED_TEXT);
      } finally {
        this.inFlight.delete(running);
      }
      const text = result.content.map((c) => c.text).join('\n');
      if (result.isError) throw new Error(text);
      return text;
    } finally {
      release();
    }
  }
}

/** The AI SDK tools for one turn: the registration's tool set, each body behind `guard`. */
export function sdkTools(
  registration: SdkTurnRegistration,
  guard: SdkToolGuard,
): Record<string, Tool> {
  const tools: Record<string, Tool> = {};
  const sink: ToolSink = {
    tool(name, description, shape, handler) {
      const inputSchema = z.object(shape);
      tools[name] = tool({
        description,
        inputSchema,
        execute: (input: z.output<typeof inputSchema>) => guard.run(() => handler(input)),
      });
    },
  };
  registration.registerTools(sink);
  return tools;
}
