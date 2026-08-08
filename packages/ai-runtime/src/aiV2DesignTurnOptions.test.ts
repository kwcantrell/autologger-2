// ai-v2-dashboards (task 2.3) — CLOSED-WORLD characterization of the design
// turn's SDK option set (spec "Subprocess security lockdown"; design D8/D8a
// and "Resolved by the spike" 0.4/0.5). This is the security tripwire: it pins
// every enumerated key/value AND asserts that every option capable of widening
// the child — programmatic hooks, plugins, agent definitions, extra process
// arguments, additional directories, and any permission-bypass switch — is
// ABSENT. Pinning values alone catches a change; only the absence assertions
// catch an ADDITION.
//
// It asserts the exact OBJECT the runner passes to `query()` (built by
// `buildDesignTurnOptions`, the single source of truth) — no spawn, no live
// SDK turn, no spend.

import { homedir, tmpdir } from 'node:os';
import { relative } from 'node:path';
import type {
  CanUseTool,
  McpServerConfig,
  SpawnedProcess,
  SpawnOptions,
} from '@anthropic-ai/claude-agent-sdk';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildDesignTurnOptions,
  createDesignTurnWorkspace,
  DESIGN_TURN_ALLOWED_ENV_KEYS,
  DESIGN_TURN_MCP_TOOL_TIMEOUT_MS,
  DESIGN_TURN_SYSTEM_PROMPT,
} from './aiV2SdkSpawn';
import { AGGREGATE_MCP_SERVER_NAME } from './mcpTools';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

const noopCanUseTool: CanUseTool = async () => ({ behavior: 'deny', message: 'x' });
const noopSpawn = (_o: SpawnOptions): SpawnedProcess => {
  throw new Error('not spawned in this test');
};
const stubMcpServer = {
  type: 'sdk',
  name: AGGREGATE_MCP_SERVER_NAME,
  instance: {},
} as unknown as McpServerConfig;

/** Build the real options against a real per-turn workspace (cleaned up
 * afterEach), so the cwd/configDir assertions are end-to-end, not synthetic. */
function buildRealOptions(overrides: { apiKey?: string; procEnv?: NodeJS.ProcessEnv } = {}) {
  const workspace = createDesignTurnWorkspace();
  cleanups.push(workspace.cleanup);
  const options = buildDesignTurnOptions({
    cwd: workspace.cwd,
    configDir: workspace.configDir,
    maxBudgetUsd: 0.5,
    mcpServer: stubMcpServer,
    canUseTool: noopCanUseTool,
    abortController: new AbortController(),
    spawnClaudeCodeProcess: noopSpawn,
    apiKey: overrides.apiKey,
    procEnv: overrides.procEnv,
  });
  return { options, workspace };
}

describe('design turn option set — pinned values (spec "Subprocess security lockdown")', () => {
  it('the built-in tool set is exactly ["AskUserQuestion"] — NOT [] (which strips it, spike 0.4)', () => {
    const { options } = buildRealOptions();
    expect(options.tools).toEqual(['AskUserQuestion']);
  });

  it('permissionMode is "plan" — NOT "dontAsk" (which bypasses canUseTool, spike 0.4)', () => {
    const { options } = buildRealOptions();
    expect(options.permissionMode).toBe('plan');
  });

  it('filesystem settings tiers disabled (settingSources: []) and repo .mcp.json suppressed', () => {
    const { options } = buildRealOptions();
    expect(options.settingSources).toEqual([]);
    expect(options.strictMcpConfig).toBe(true);
  });

  it('session forking disabled explicitly', () => {
    const { options } = buildRealOptions();
    expect(options.forkSession).toBe(false);
  });

  it('cwd is the pinned per-turn dir, OUTSIDE the repo checkout and DATA_DIR', () => {
    const { options, workspace } = buildRealOptions();
    expect(options.cwd).toBe(workspace.cwd);
    // Under the OS tmp dir (a location the deployment controls), not under the
    // repo checkout (process.cwd()) — `..` in the relative path proves it is
    // not a descendant.
    expect(options.cwd?.startsWith(tmpdir())).toBe(true);
    expect(relative(process.cwd(), options.cwd ?? '').startsWith('..')).toBe(true);
    // DATA_DIR defaults to ./data under the repo, so being outside the repo
    // already places it outside the default DATA_DIR.
  });

  it('isolated config dir, separate from the operator personal ~/.claude', () => {
    const { options, workspace } = buildRealOptions();
    expect(options.env?.CLAUDE_CONFIG_DIR).toBe(workspace.configDir);
    expect(options.env?.CLAUDE_CONFIG_DIR).not.toBe(`${homedir()}/.claude`);
  });

  it('per-turn spend ceiling is the passed budget', () => {
    const { options } = buildRealOptions();
    const withBudget = buildDesignTurnOptions({
      cwd: '/tmp/x',
      configDir: '/tmp/y',
      maxBudgetUsd: 1.23,
      mcpServer: stubMcpServer,
      canUseTool: noopCanUseTool,
      abortController: new AbortController(),
      spawnClaudeCodeProcess: noopSpawn,
    });
    expect(options.maxBudgetUsd).toBe(0.5);
    expect(withBudget.maxBudgetUsd).toBe(1.23);
  });

  it('an explicit, non-empty pinned system prompt (a plain string, replacing the preset)', () => {
    const { options } = buildRealOptions();
    expect(typeof options.systemPrompt).toBe('string');
    expect(options.systemPrompt).toBe(DESIGN_TURN_SYSTEM_PROMPT);
    expect((options.systemPrompt as string).length).toBeGreaterThan(0);
  });

  it('askUserQuestionTimeout is set via `settings` — NOT via `managedSettings`', () => {
    const { options } = buildRealOptions();
    expect(options.settings).toEqual({ askUserQuestionTimeout: '60s' });
    // The exact filter-dropped mistake 0.4/0.8 caught: it must NOT ride on
    // managedSettings, whose restrictive-only filter silently drops it.
    expect(options.managedSettings).not.toHaveProperty('askUserQuestionTimeout');
  });

  it('account-level cloud connectors disabled via managedSettings', () => {
    const { options } = buildRealOptions();
    expect(options.managedSettings).toEqual({ disableClaudeAiConnectors: true });
  });

  it('previewFormat pinned at the "markdown" default — never opts into "html"', () => {
    const { options } = buildRealOptions();
    expect(options.toolConfig).toEqual({ askUserQuestion: { previewFormat: 'markdown' } });
  });

  it('disallowedTools names the write/exec built-ins (the only override-an-allow mechanism)', () => {
    const { options } = buildRealOptions();
    for (const t of ['Bash', 'Write', 'Edit', 'Read', 'WebFetch', 'WebSearch', 'NotebookEdit']) {
      expect(options.disallowedTools).toContain(t);
    }
    // allowedTools auto-approves rather than restricts — pinned empty so
    // nothing is ever auto-approved without canUseTool running.
    expect(options.allowedTools).toEqual([]);
  });

  it('the per-turn aggregate MCP server is the only mcpServers entry', () => {
    const { options } = buildRealOptions();
    expect(Object.keys(options.mcpServers ?? {})).toEqual([AGGREGATE_MCP_SERVER_NAME]);
  });

  it('the permission callback, abort controller, and group-kill spawn override are all present', () => {
    const { options } = buildRealOptions();
    expect(typeof options.canUseTool).toBe('function');
    expect(options.abortController).toBeInstanceOf(AbortController);
    expect(typeof options.spawnClaudeCodeProcess).toBe('function');
  });
});

describe('design turn option set — minimal env (closed-world over keys)', () => {
  it('env keys are a subset of the allowed set; required keys present; no ANTHROPIC_API_KEY without a key', () => {
    const { options } = buildRealOptions({ procEnv: { PATH: '/usr/bin', HOME: '/home/x' } });
    const keys = Object.keys(options.env ?? {});
    for (const k of keys) expect(DESIGN_TURN_ALLOWED_ENV_KEYS).toContain(k);
    expect(options.env?.CLAUDE_CONFIG_DIR).toBeTruthy();
    expect(options.env?.MCP_TOOL_TIMEOUT).toBe(DESIGN_TURN_MCP_TOOL_TIMEOUT_MS);
    expect(options.env?.PATH).toBe('/usr/bin');
    expect(options.env?.HOME).toBe('/home/x');
    expect(options.env).not.toHaveProperty('ANTHROPIC_API_KEY');
    // No arbitrary parent-env leakage: a secret in the parent never reaches the child.
  });

  it('a configured workspace key rides on ANTHROPIC_API_KEY (D9), preferred over the login', () => {
    const { options } = buildRealOptions({
      apiKey: 'workspace-key',
      procEnv: { PATH: '/usr/bin', HOME: '/home/x', SOME_SECRET: 'nope' },
    });
    expect(options.env?.ANTHROPIC_API_KEY).toBe('workspace-key');
    expect(options.env).not.toHaveProperty('SOME_SECRET');
  });

  it('optional proxy/TLS vars are forwarded only when the parent actually has them', () => {
    const withProxy = buildDesignTurnOptions({
      cwd: '/tmp/x',
      configDir: '/tmp/y',
      maxBudgetUsd: 0.5,
      mcpServer: stubMcpServer,
      canUseTool: noopCanUseTool,
      abortController: new AbortController(),
      spawnClaudeCodeProcess: noopSpawn,
      procEnv: { PATH: '/usr/bin', HOME: '/home/x', HTTPS_PROXY: 'http://proxy:8080' },
    });
    expect(withProxy.env?.HTTPS_PROXY).toBe('http://proxy:8080');
    const withoutProxy = buildDesignTurnOptions({
      cwd: '/tmp/x',
      configDir: '/tmp/y',
      maxBudgetUsd: 0.5,
      mcpServer: stubMcpServer,
      canUseTool: noopCanUseTool,
      abortController: new AbortController(),
      spawnClaudeCodeProcess: noopSpawn,
      procEnv: { PATH: '/usr/bin', HOME: '/home/x' },
    });
    expect(withoutProxy.env).not.toHaveProperty('HTTPS_PROXY');
  });
});

describe('design turn option set — ABSENCE of widening options (only this catches an ADDITION)', () => {
  it('no hooks, plugins, agents, extraArgs, additionalDirectories', () => {
    const { options } = buildRealOptions();
    expect(options).not.toHaveProperty('hooks');
    expect(options).not.toHaveProperty('plugins');
    expect(options).not.toHaveProperty('agents');
    expect(options).not.toHaveProperty('extraArgs');
    expect(options).not.toHaveProperty('additionalDirectories');
  });

  it('no permission-bypass switch of any kind', () => {
    const { options } = buildRealOptions();
    expect(options).not.toHaveProperty('allowDangerouslySkipPermissions');
    expect(options).not.toHaveProperty('permissionPromptToolName');
    expect(options.permissionMode).not.toBe('bypassPermissions');
    expect(options.permissionMode).not.toBe('acceptEdits');
    expect(options.permissionMode).not.toBe('auto');
  });

  it('no pathToClaudeCodeExecutable in production (the real CLI is used)', () => {
    const { options } = buildRealOptions();
    expect(options).not.toHaveProperty('pathToClaudeCodeExecutable');
  });
});
