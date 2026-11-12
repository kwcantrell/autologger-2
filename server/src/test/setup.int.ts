import { Agent, setGlobalDispatcher } from 'undici';
import { afterEach, beforeEach } from 'vitest';
import { resetTestEnv, teardownTestEnv } from './harness';

// fetch drops idle keep-alive sockets at once, so a server a test starts (the AI MCP listener, a
// fake LLM) closes as soon as its test is done instead of waiting out undici's 4 s idle timeout.
setGlobalDispatcher(new Agent({ keepAliveTimeout: 10, keepAliveMaxTimeout: 10 }));

beforeEach(() => resetTestEnv());
afterEach(() => teardownTestEnv());
