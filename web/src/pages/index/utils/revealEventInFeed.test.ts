import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  REVEAL_EVENT,
  revealEventInFeed,
  scrollAndFlashEventRow,
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
