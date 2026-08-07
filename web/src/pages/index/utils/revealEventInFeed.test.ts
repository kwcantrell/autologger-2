import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  REVEAL_EVENT,
  revealEventInFeed,
  scrollAndFlashEventRow,
  scrollAndFlashEventRowWithRetry,
} from './revealEventInFeed';

describe('revealEventInFeed', () => {
  it('dispatches autologger:reveal-event with the event id', () => {
    const spy = vi.fn();
    document.body.addEventListener(REVEAL_EVENT, spy);
    revealEventInFeed('evt-1');
    expect(spy).toHaveBeenCalledTimes(1);
    expect((spy.mock.calls[0][0] as CustomEvent).detail).toEqual({ eventId: 'evt-1' });
    document.body.removeEventListener(REVEAL_EVENT, spy);
  });

  it('no-ops on empty id', () => {
    const spy = vi.fn();
    document.body.addEventListener(REVEAL_EVENT, spy);
    revealEventInFeed('  ');
    expect(spy).not.toHaveBeenCalled();
    document.body.removeEventListener(REVEAL_EVENT, spy);
  });
});

describe('scrollAndFlashEventRow', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('scrolls, flashes, and clears the flash class', () => {
    Element.prototype.scrollIntoView = vi.fn();
    document.body.innerHTML = `
      <div id="v4-log-sheet">
        <table><tbody>
          <tr data-event-id="evt-9"><td>row</td></tr>
        </tbody></table>
      </div>`;
    const row = document.querySelector('tr[data-event-id="evt-9"]') as HTMLElement;

    expect(scrollAndFlashEventRow('evt-9')).toBe(true);
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
    expect(row.classList.contains('event-row-flash')).toBe(true);

    vi.advanceTimersByTime(2500);
    expect(row.classList.contains('event-row-flash')).toBe(false);
  });

  it('returns false when the row is in a hidden tabpanel', () => {
    document.body.innerHTML = `
      <div hidden>
        <div id="v4-log-sheet">
          <table><tbody>
            <tr data-event-id="evt-9"><td>row</td></tr>
          </tbody></table>
        </div>
      </div>`;
    expect(scrollAndFlashEventRow('evt-9')).toBe(false);
  });

  it('returns false when the row is missing', () => {
    expect(scrollAndFlashEventRow('missing')).toBe(false);
  });
});

describe('scrollAndFlashEventRowWithRetry', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    vi.useFakeTimers();
    Element.prototype.scrollIntoView = vi.fn();
  });
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  function insertRow(eventId: string) {
    document.body.innerHTML = `
      <div id="v4-log-sheet">
        <table><tbody>
          <tr data-event-id="${eventId}"><td>row</td></tr>
        </tbody></table>
      </div>`;
    return document.querySelector(`tr[data-event-id="${eventId}"]`) as HTMLElement;
  }

  it('flashes immediately when the row is already present', () => {
    const row = insertRow('evt-1');
    scrollAndFlashEventRowWithRetry('evt-1');
    expect(row.classList.contains('event-row-flash')).toBe(true);
  });

  it('flashes a row that only appears later (page growth / tab reveal)', () => {
    scrollAndFlashEventRowWithRetry('evt-2');
    vi.advanceTimersByTime(500);
    const row = insertRow('evt-2');
    expect(row.classList.contains('event-row-flash')).toBe(false);
    vi.advanceTimersByTime(50);
    expect(row.classList.contains('event-row-flash')).toBe(true);
  });

  it('gives up after the 2s bound', () => {
    scrollAndFlashEventRowWithRetry('evt-3');
    vi.advanceTimersByTime(2100);
    const row = insertRow('evt-3');
    vi.advanceTimersByTime(1000);
    expect(row.classList.contains('event-row-flash')).toBe(false);
  });

  it('cancel stops the loop', () => {
    const cancel = scrollAndFlashEventRowWithRetry('evt-4');
    cancel();
    const row = insertRow('evt-4');
    vi.advanceTimersByTime(1000);
    expect(row.classList.contains('event-row-flash')).toBe(false);
  });
});
