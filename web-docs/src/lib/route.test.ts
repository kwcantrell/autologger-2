import { describe, expect, it } from 'vitest';
import {
  ABOUT_HASH,
  capabilityHash,
  componentHash,
  diagramHash,
  erHash,
  L0_HASH,
  parseHash,
} from './route';

describe('parseHash', () => {
  it('treats empty/root/hashless input as L0', () => {
    expect(parseHash('')).toEqual({ kind: 'l0' });
    expect(parseHash('#')).toEqual({ kind: 'l0' });
    expect(parseHash('#/')).toEqual({ kind: 'l0' });
  });

  it('parses about', () => {
    expect(parseHash('#/about')).toEqual({ kind: 'about' });
  });

  it('parses a component route, decoding the name', () => {
    expect(parseHash('#/component/aiV2')).toEqual({ kind: 'component', name: 'aiV2' });
    expect(parseHash('#/component/catalog-db')).toEqual({ kind: 'component', name: 'catalog-db' });
  });

  it('parses a capability route, decoding the name', () => {
    expect(parseHash('#/capability/ai-topics-chat')).toEqual({
      kind: 'capability',
      name: 'ai-topics-chat',
    });
  });

  it('parses ER routes for catalog and session only', () => {
    expect(parseHash('#/er/catalog')).toEqual({ kind: 'er', schema: 'catalog' });
    expect(parseHash('#/er/session')).toEqual({ kind: 'er', schema: 'session' });
    expect(parseHash('#/er/bogus')).toEqual({ kind: 'not-found', hash: '/er/bogus' });
  });

  it('parses a diagram route, decoding a slash-bearing path from a single encoded segment', () => {
    const path = 'web-docs/diagrams/recording-lease.mmd';
    expect(parseHash(diagramHash(path))).toEqual({ kind: 'diagram', path });
  });

  it('falls back to not-found for unrecognized shapes', () => {
    expect(parseHash('#/nonsense')).toEqual({ kind: 'not-found', hash: '/nonsense' });
    expect(parseHash('#/component/')).toEqual({ kind: 'not-found', hash: '/component/' });
    expect(parseHash('#/about/extra')).toEqual({ kind: 'not-found', hash: '/about/extra' });
  });

  it('round-trips every hash builder through parseHash', () => {
    expect(parseHash(L0_HASH)).toEqual({ kind: 'l0' });
    expect(parseHash(ABOUT_HASH)).toEqual({ kind: 'about' });
    expect(parseHash(componentHash('web-app'))).toEqual({ kind: 'component', name: 'web-app' });
    expect(parseHash(capabilityHash('team-management'))).toEqual({
      kind: 'capability',
      name: 'team-management',
    });
    expect(parseHash(erHash('session'))).toEqual({ kind: 'er', schema: 'session' });
  });
});
