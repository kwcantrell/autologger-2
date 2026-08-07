// Attachment + structural checklist tests for the two v1 authored state
// diagrams (task 6.2; design.md D7; spec "Authored state diagrams are
// attached, structurally validated, and labeled"). Mermaid *parse* validity
// (task 6.3) is out of scope here — these tests assert (1) the diagrams are
// attached to the `session` component in the model, (2) each file exists
// with non-empty content, and (3) the states/transitions authored from the
// code read (see task-6.1-6.2-report.md for the file:line quotes
// justifying each line below) are actually present as text, so a future
// edit that silently drops a transition is caught even before 6.3's real
// mermaid parser lands.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { model } from './components';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

function readDiagram(repoRelativePath: string): string {
  return readFileSync(`${REPO_ROOT}/${repoRelativePath}`, 'utf8');
}

const RECORDING_LEASE_PATH = 'web-docs/diagrams/recording-lease.mmd';
const SESSION_HUB_REGISTRY_PATH = 'web-docs/diagrams/session-hub-registry.mmd';

describe('authored diagrams — attached to the session component', () => {
  it('attaches exactly the two v1 authored diagrams to the session component', () => {
    const session = model.components.find((c) => c.name === 'session');
    expect(session).toBeDefined();
    expect(session?.authoredDiagrams).toEqual(
      [RECORDING_LEASE_PATH, SESSION_HUB_REGISTRY_PATH].sort(),
    );
  });

  it('ships no transcript-generation diagram in v1 (deferred pending transcript-gen-lock-status)', () => {
    const allAuthored = model.components.flatMap((c) => c.authoredDiagrams);
    expect(allAuthored.some((path) => /transcript/i.test(path))).toBe(false);
  });
});

describe('recording-lease.mmd — non-empty, parses as a state diagram, matches the code-read checklist', () => {
  const source = readDiagram(RECORDING_LEASE_PATH);

  it('is non-empty and declares stateDiagram-v2', () => {
    expect(source.trim().length).toBeGreaterThan(0);
    expect(source).toContain('stateDiagram-v2');
  });

  it('has the two real lease states: Free and Held', () => {
    expect(source).toContain('Free');
    expect(source).toContain('Held');
  });

  it('has a grant transition (Free -> Held via claimLease when unheld)', () => {
    expect(source).toMatch(/Free\s*-->\s*Held/);
    expect(source).toMatch(/claimLease/);
  });

  it('has a heartbeat self-transition on Held that re-arms the alarm', () => {
    expect(source).toMatch(/Held\s*-->\s*Held/);
    expect(source).toMatch(/heartbeatLease/);
  });

  it('has a stale-holder takeover transition (Held -> Held, a different client wins)', () => {
    expect(source).toMatch(/stale-holder takeover/i);
  });

  it('has an explicit release transition (Held -> Free)', () => {
    expect(source).toMatch(/Held\s*-->\s*Free/);
    expect(source).toMatch(/releaseLease/);
  });

  it('has an expiry transition (Held -> Free via expireIfStale finding a stale heartbeat)', () => {
    expect(source).toMatch(/expireIfStale/);
    expect(source).toMatch(/expiry/i);
  });

  it('has an alarm re-arm transition (Held -> Held via expireIfStale finding a NOT-yet-stale heartbeat)', () => {
    expect(source).toMatch(/alarm re-arm/i);
  });
});

describe('session-hub-registry.mmd — non-empty, parses as a state diagram, matches the code-read checklist', () => {
  const source = readDiagram(SESSION_HUB_REGISTRY_PATH);

  it('is non-empty and declares stateDiagram-v2', () => {
    expect(source.trim().length).toBeGreaterThan(0);
    expect(source).toContain('stateDiagram-v2');
  });

  it('has the two real registry states: Absent and Active', () => {
    expect(source).toContain('Absent');
    expect(source).toContain('Active');
  });

  it('has a construction transition (Absent -> Active via get() with no existing hub)', () => {
    expect(source).toMatch(/Absent\s*-->\s*Active/);
    expect(source).toMatch(/get\(/);
  });

  it('has a touch self-transition on Active (get() on an existing hub updates lastTouchedMs)', () => {
    expect(source).toMatch(/Active\s*-->\s*Active/);
    expect(source).toMatch(/lastTouchedMs/);
  });

  it('has an eviction transition (Active -> Absent) naming the triple idle guard', () => {
    expect(source).toMatch(/Active\s*-->\s*Absent/);
    expect(source).toMatch(/socketCount/);
    expect(source).toMatch(/hasArmedAlarm/);
  });

  it('says "reconstruct", never "reopen" in its transition labels — the hub is a new instance, not the same object reopened', () => {
    // Scoped to the actual state-diagram body (transition lines), not the
    // leading `%%` header comment, which legitimately quotes CLAUDE.md's
    // looser "reopen lazily" prose while explaining why the diagram
    // corrects it — that quotation isn't a claim the diagram itself makes.
    const body = source.slice(source.indexOf('stateDiagram-v2'));
    expect(body).toMatch(/reconstruct/i);
    expect(body).not.toMatch(/reopen/i);
  });

  it('does not model eviction as a persisted third state — only Absent and Active are real registry states', () => {
    const stateDeclarationLines = source
      .split('\n')
      .filter((line) => /-->/.test(line) || /^\s*state\s/.test(line));
    expect(stateDeclarationLines.join('\n')).not.toMatch(/\bEvicted\b/);
  });
});
