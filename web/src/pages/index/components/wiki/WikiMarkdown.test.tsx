// show-wiki task 5.3 (design D5, D7 "Moment links"; show-wiki spec "Page bodies render safely").
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { memoryLocation } from 'wouter/memory-location';
import { setNavigationImplForTesting } from '../../navigation';
import { momentHref, secondsHref } from '../search/searchLinks';
import { WikiMarkdown } from './WikiMarkdown';

let memory: ReturnType<typeof memoryLocation>;

beforeEach(() => {
  memory = memoryLocation({ path: '/wiki/P0', record: true });
  setNavigationImplForTesting((p, o) => memory.navigate(p, o));
});

afterEach(() => {
  setNavigationImplForTesting(null);
});

function renderBody(body: string) {
  return render(<WikiMarkdown body={body} />);
}

describe('secondsHref', () => {
  it('is the session deep link with ?t=<seconds>', () => {
    expect(secondsHref('S1', 754)).toBe('/sessions/S1?t=754');
    expect(secondsHref('a b', 1.5)).toBe('/sessions/a%20b?t=1.5');
  });

  it('is what momentHref returns for a timed transcript moment', () => {
    const m = {
      kind: 'transcript',
      session_id: 'S1',
      sec: 754,
    } as unknown as Parameters<typeof momentHref>[0];
    expect(momentHref(m)).toBe(secondsHref('S1', 754));
  });
});

describe('WikiMarkdown', () => {
  it('Script links are inert: raw HTML renders nothing and javascript: links are text', () => {
    const { container } = renderBody(
      'Before\n\n<img src=x onerror=alert(1)>\n\nSee [x](javascript:alert(1)) here.',
    );
    expect(container.querySelector('img')).toBeNull();
    expect(screen.queryByRole('link', { name: 'x' })).toBeNull();
    expect(container.querySelectorAll('a')).toHaveLength(0);
    expect(container.textContent).toContain('See x here.');
  });

  it('a cite: link is a moment link labelled with its text and h:mm:ss time', () => {
    renderBody('Plan: [we start Monday](cite:S1@754).');
    const link = screen.getByRole('link');
    expect(link.getAttribute('href')).toBe('/sessions/S1?t=754');
    expect(link.textContent).toContain('we start Monday');
    expect(link.textContent).toContain('0:12:34');
    expect(link.getAttribute('target')).toBeNull();
  });

  it('clicking a cite: link navigates in-app to the moment', () => {
    renderBody('[we start Monday](cite:S1@754)');
    fireEvent.click(screen.getByRole('link'));
    expect(memory.history?.at(-1)).toBe('/sessions/S1?t=754');
  });

  it.each([
    ['a malformed cite:', '[bad](cite:S1@1.2345)'],
    ['an upper-case CITE:', '[bad](CITE:S1@1)'],
    ['an upper-case WIKI:', '[bad](WIKI:P1)'],
    ['a malformed wiki:', '[bad](wiki:a/b)'],
    ['an http: link', '[bad](http://example.com)'],
  ])('%s renders as text', (_label, body) => {
    const { container } = renderBody(`Say ${body} now.`);
    expect(container.querySelectorAll('a')).toHaveLength(0);
    expect(container.textContent).toContain('Say bad now.');
  });

  it('an image renders as its alt text only', () => {
    const { container } = renderBody('Look ![the alt](https://x/y.png) there.');
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelectorAll('a')).toHaveLength(0);
    expect(container.textContent).toContain('Look the alt there.');
  });

  it('a wiki: link is an in-app link to /wiki/<id>', () => {
    renderBody('See [Running Joke](wiki:P1).');
    const link = screen.getByRole('link', { name: 'Running Joke' });
    expect(link.getAttribute('href')).toBe('/wiki/P1');
    expect(link.getAttribute('target')).toBeNull();
    fireEvent.click(link);
    expect(memory.history?.at(-1)).toBe('/wiki/P1');
  });

  it('an https: link opens in a new tab with rel="noopener noreferrer"', () => {
    renderBody('Docs at [the site](https://example.com/a?b=1).');
    const link = screen.getByRole('link', { name: 'the site' });
    expect(link.getAttribute('href')).toBe('https://example.com/a?b=1');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('headings and lists render', () => {
    renderBody('# Title\n\n## Sub\n\n- one\n- two\n\n1. first\n2. second\n');
    expect(screen.getByRole('heading', { level: 1, name: 'Title' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 2, name: 'Sub' })).toBeTruthy();
    const lists = screen.getAllByRole('list');
    expect(lists).toHaveLength(2);
    expect(screen.getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'one',
      'two',
      'first',
      'second',
    ]);
  });
});
