import { describe, expect, it } from 'vitest';
import { model } from './components';
import { buildNavIndex, routeForComponent, slugifyComponentId } from './navigation';

describe('slugifyComponentId', () => {
  it('is deterministic — the same name always produces the same id', () => {
    expect(slugifyComponentId('web-app')).toBe(slugifyComponentId('web-app'));
  });

  it('lowercases and replaces hyphens with underscores', () => {
    expect(slugifyComponentId('session-databases')).toBe('session_databases');
  });

  it('produces a mermaid-safe identifier for a hostile component name', () => {
    const id = slugifyComponentId('weird "name"; DROP TABLE <script>');
    expect(id).toMatch(/^[a-z][a-z0-9_]*$/);
  });

  it('prefixes a numeric-leading name so the id still starts with a letter', () => {
    const id = slugifyComponentId('123-numeric');
    expect(id).toMatch(/^[a-z]/);
  });

  it('falls back to a non-empty id for an all-punctuation name', () => {
    const id = slugifyComponentId('!!!');
    expect(id.length).toBeGreaterThan(0);
    expect(id).toMatch(/^[a-z][a-z0-9_]*$/);
  });
});

describe('routeForComponent', () => {
  it('builds a stable per-component route', () => {
    expect(routeForComponent('web-app')).toBe('/component/web-app');
  });
});

describe('buildNavIndex', () => {
  it('emits one sorted entry per component name, mapping id -> componentName -> route', () => {
    const index = buildNavIndex(['beta', 'alpha']);
    expect(index).toEqual([
      { id: 'alpha', componentName: 'alpha', route: '/component/alpha' },
      { id: 'beta', componentName: 'beta', route: '/component/beta' },
    ]);
  });

  it('never produces two different components with the same slug, across the whole real model', () => {
    const index = buildNavIndex(model.components.map((c) => c.name));
    const ids = index.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
