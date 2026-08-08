#!/usr/bin/env node
// ai-v2-dashboards (task 6.2) — a REAL, protocol-faithful fake agent for the
// Agent SDK's `pathToClaudeCodeExecutable` transport, standing in for the
// `claude` CLI so a hermetic e2e can drive a real design turn (real HTTP,
// real SSE, real `canUseTool`/pending-question round trip, real
// `propose_dashboard` MCP tool call) with ZERO Anthropic spend.
//
// This is NOT the same seam as `ai-v2-sdk-spawn-recorder.mjs` (task 0.9),
// which only records argv and exits — the SDK never gets a working turn out
// of it, so it can only prove no-spawn/spawn, never a completed turn. This
// fixture instead speaks the SDK's own bidirectional stdio control protocol
// (confirmed empirically against the pinned `@anthropic-ai/claude-agent-sdk`
// via a scratch probe — see the task-6.2 report for the transcript):
//
//   PARENT (this repo's server process, running the SDK's `query()`) <-> CHILD (this file, spawned as `node <this file> <cli-flags>` because pathToClaudeCodeExecutable ends in .mjs):
//     1. Parent -> child: `{"type":"control_request", request:{subtype:"initialize", ...}}`.
//        Child replies `{"type":"control_response", response:{subtype:"success", request_id, response:{commands:[],agents:[],output_style,available_output_styles,models:[],account:{...}}}}`
//        — the SDKControlInitializeResponse shape (sdk.d.ts); a loose stub
//        satisfies it at runtime (the SDK's own internal code never appears
//        to validate these fields beyond destructuring them for its own
//        state).
//     2. Parent -> child: `{"type":"user", message:{role:"user", content:[...]}}` — the initial design-turn prompt.
//     3. Child -> parent: `{"type":"assistant", message:{role:"assistant", content:[{type:"text", text}]}}` (relayed as SSE `delta` by `runDesignTurn`, aiV2SdkSpawn.ts).
//     4. Child -> parent: `{"type":"control_request", request:{subtype:"can_use_tool", tool_name:"AskUserQuestion", input:{questions:[...]}}}`.
//        This is what actually drives `buildDesignTurnCanUseTool`'s
//        `onQuestion` handler (aiV2SdkSpawn.ts) -> the pending-question
//        registry (aiV2PendingQuestions.ts) -> a REAL `question` SSE event on
//        the REAL browser's stream -> the test answers via a REAL
//        `POST .../ai/v2/answer` -> `resolveAnswer` resolves the parked
//        Promise -> the SDK sends this child a matching
//        `control_response` carrying the `PermissionResult` (`{behavior:
//        'allow', updatedInput: {...answers}}`). This round trip can take an
//        arbitrary real-world amount of time (a human/Playwright click) —
//        the child just awaits it.
//     5. Child -> parent: another assistant delta acknowledging the answer.
//     6. Child -> parent: `{"type":"control_request", request:{subtype:"mcp_message", server_name:"autologger-aggregates", message:{jsonrpc:"2.0", id, method:"tools/call", params:{name:"propose_dashboard", arguments:{...}}}}}`.
//        The SDK forwards this directly to the REAL in-process MCP server
//        `aiV2.ts` built via `buildAggregateMcpServer` (mcpTools.ts) — NO
//        `can_use_tool` gate on this subtype (confirmed in the pinned SDK's
//        bundled transport: mcp_message is handled unconditionally, "the
//        control channel is trusted"), so the tool's REAL
//        `validateDashboardConfig` (catalog.ts) runs and, on acceptance,
//        the REAL `onProposeDashboard` callback fires a REAL `dashboard` SSE
//        event to the browser (design D10). The child awaits the matching
//        `control_response` (`{mcp_response: <jsonrpc result>}`).
//     7. Child -> parent: closing delta + `{"type":"result", subtype:"success", is_error:false}` (relayed as terminal `done`).
//
// Server name and widget-type/answer literals below are load-bearing wire
// values, not decoration — they must match the real production constants
// (`AGGREGATE_MCP_SERVER_NAME` in @autologger/ai-runtime's mcpTools.ts, and a real
// `WIDGET_TYPES` entry in packages/contract/src/aiV2Catalog.ts) or the real MCP
// server / `validateDashboardConfig` boundary rejects them, same as it would
// reject a live agent's malformed call.
//
// Selected via `AI_V2_SDK_EXECUTABLE_PATH` (read by server/src/routers/aiV2.ts
// and threaded into `buildDesignTurnOptions`'s pre-existing
// `pathToClaudeCodeExecutable` test seam — "Never set in production", already
// documented on that field before this task). Never touches the network,
// never reads real Anthropic credentials.

import { createInterface } from 'node:readline';

const MCP_SERVER_NAME = 'autologger-aggregates'; // AGGREGATE_MCP_SERVER_NAME

function send(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

let reqCounter = 0;
function nextReqId() {
  reqCounter += 1;
  return `fake-agent-req-${reqCounter}`;
}

/** requestId -> resolve(response) for control_requests THIS script sent. */
const pendingControlResponses = new Map();

function sendControlRequest(request) {
  const request_id = nextReqId();
  send({ type: 'control_request', request_id, request });
  return new Promise((resolve) => {
    pendingControlResponses.set(request_id, resolve);
  });
}

async function runScriptedTurn() {
  // 1. Streamed assistant text — relayed as SSE `delta` events.
  send({
    type: 'assistant',
    session_id: 'fake-agent-session',
    parent_tool_use_id: null,
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: "Looking at this session's aggregates now." }],
    },
  });

  // 2. AskUserQuestion — a real `can_use_tool` control_request. Options carry
  // real catalog widget types (packages/contract/src/aiV2Catalog.ts WIDGET_TYPES) so a
  // clicked option answers with a value the real schema accepts.
  const askInput = {
    questions: [
      {
        question: 'Which widget should we start with?',
        header: 'Widget',
        multiSelect: false,
        options: [
          { label: 'Speaker talk time', widgetType: 'talk_time_by_speaker' },
          { label: 'Topic timeline', widgetType: 'topic_timeline' },
        ],
      },
    ],
  };
  const permissionResponse = await sendControlRequest({
    subtype: 'can_use_tool',
    tool_name: 'AskUserQuestion',
    input: askInput,
    tool_use_id: 'toolu_fake_ask_1',
  });
  // permissionResponse.response is the PermissionResult the real pending-
  // question registry resolved with once the test answered via the real
  // POST .../ai/v2/answer route — e.g. { behavior: 'allow', updatedInput }.
  // This fixture doesn't branch on its content (a canned turn always
  // proposes the same starting dashboard, mirroring a real agent choosing
  // its own next step) but DOES require the round trip to have actually
  // completed before continuing, which the `await` above already enforces.
  void permissionResponse;

  // 3. Acknowledge, then commit the proposal via the REAL propose_dashboard
  // MCP tool (mcp_message control_request — no can_use_tool gate on this
  // subtype, confirmed against the pinned SDK).
  send({
    type: 'assistant',
    session_id: 'fake-agent-session',
    parent_tool_use_id: null,
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'Proposing a starting dashboard with talk time.' }],
    },
  });

  const mcpResponse = await sendControlRequest({
    subtype: 'mcp_message',
    server_name: MCP_SERVER_NAME,
    message: {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'propose_dashboard',
        arguments: {
          widgets: [
            {
              id: 'fake-agent-widget-1',
              type: 'talk_time_by_speaker',
              title: 'Speaker talk time',
              x: 0,
              y: 0,
              w: 4,
              h: 2,
            },
          ],
          interactions: [],
        },
      },
    },
  });
  void mcpResponse;

  // 4. Terminal result (relayed as SSE `done`).
  send({ type: 'result', subtype: 'success', is_error: false, session_id: 'fake-agent-session' });
}

const rl = createInterface({ input: process.stdin });
let started = false;

rl.on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }

  if (msg.type === 'control_response') {
    const resolve = pendingControlResponses.get(msg.response?.request_id);
    if (resolve) {
      pendingControlResponses.delete(msg.response.request_id);
      resolve(msg.response);
    }
    return;
  }

  if (msg.type === 'control_request' && msg.request?.subtype === 'initialize') {
    send({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: msg.request_id,
        response: {
          commands: [],
          agents: [],
          output_style: 'default',
          available_output_styles: ['default'],
          models: [],
          account: { email: 'fake-agent@example.invalid' },
        },
      },
    });
    return;
  }

  if (msg.type === 'user' && !started) {
    started = true;
    runScriptedTurn().catch((err) => {
      send({ type: 'result', subtype: 'error_during_execution', is_error: true });
      process.stderr.write(`[ai-v2-fake-agent] scripted turn threw: ${err?.stack ?? err}\n`);
      process.exit(1);
    });
  }
});
