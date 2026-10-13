import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderStrict } from '../../../../test/renderStrict';
import { SearchSnippet, snippetParts } from './SearchSnippet';

// catalog-search task 5.3 (design D8; catalog-search "Snippets are plain text with sentinel
// highlights"): U+E000 … U+E001 spans render as `<mark>` text elements; nothing in a snippet is
// ever parsed as HTML.

const OPEN = '';
const CLOSE = '';

describe('snippetParts', () => {
  it('splits plain and highlighted runs', () => {
    expect(snippetParts(`we talked ${OPEN}budget${CLOSE} and ${OPEN}tax${CLOSE}.`)).toEqual([
      { text: 'we talked ', hit: false },
      { text: 'budget', hit: true },
      { text: ' and ', hit: false },
      { text: 'tax', hit: true },
      { text: '.', hit: false },
    ]);
  });

  it('tolerates an unclosed highlight and a stray close', () => {
    expect(snippetParts(`a${CLOSE}b ${OPEN}c`)).toEqual([
      { text: 'ab ', hit: false },
      { text: 'c', hit: true },
    ]);
    expect(snippetParts('')).toEqual([]);
  });
});

describe('SearchSnippet', () => {
  it('renders each sentinel span as a <mark> with the plain text around it', () => {
    const { container } = renderStrict(
      <SearchSnippet text={`the ${OPEN}Café${CLOSE} noir ${OPEN}budget${CLOSE} talk`} />,
    );
    const marks = container.querySelectorAll('mark');
    expect([...marks].map((m) => m.textContent)).toEqual(['Café', 'budget']);
    expect(container.textContent).toBe('the Café noir budget talk');
  });

  it('shows markup in a snippet as literal text and creates no element from it', () => {
    const evil = `<img src=x onerror="alert(1)"> ${OPEN}<b>bold</b>${CLOSE}`;
    const { container } = renderStrict(<SearchSnippet text={evil} />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('b')).toBeNull();
    expect(container.textContent).toBe('<img src=x onerror="alert(1)"> <b>bold</b>');
    expect(container.querySelector('mark')?.textContent).toBe('<b>bold</b>');
    expect(screen.getByText(/onerror/)).toBeTruthy();
  });
});
