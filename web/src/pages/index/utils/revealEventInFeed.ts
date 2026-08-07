/** Custom event: timeline marker → switch to Event Feed, scroll + flash the row. */
export const REVEAL_EVENT = 'autologger:reveal-event';

/** Attribute-value escape for CSS selectors (jsdom may lack CSS.escape). */
function cssAttrEscape(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(value);
  }
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export function revealEventInFeed(eventId: string): void {
  const id = String(eventId || '').trim();
  if (!id) return;
  document.body.dispatchEvent(
    new CustomEvent(REVEAL_EVENT, { detail: { eventId: id } }),
  );
}

/**
 * Scroll the Event Feed row into view and flash it. Returns false when the row
 * is missing or still inside a hidden tabpanel (caller may retry after a tab switch).
 */
export function scrollAndFlashEventRow(eventId: string): boolean {
  const id = String(eventId || '').trim();
  if (!id) return false;
  const row = document.querySelector(
    `#v4-log-sheet tr[data-event-id="${cssAttrEscape(id)}"]`,
  ) as HTMLElement | null;
  if (!row) return false;
  if (row.closest('[hidden]')) return false;

  row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  // Retrigger CSS animation if the same marker is clicked again.
  row.classList.remove('event-row-flash');
  void row.offsetWidth;
  row.classList.add('event-row-flash');
  window.setTimeout(() => {
    row.classList.remove('event-row-flash');
  }, 2500);
  return true;
}

/**
 * scrollAndFlashEventRow, retried every 50ms for up to 2s. A reveal's target
 * row can be legitimately absent for a while: the tabpanel stays `hidden` for
 * a frame after a tab switch, and EventLogSheet may have to grow its loaded
 * page (fetch + render) before the row exists at all — a single fixed-delay
 * retry misses the second case entirely. Returns a cancel function; callers
 * starting a new reveal must cancel the previous loop first.
 */
export function scrollAndFlashEventRowWithRetry(eventId: string): () => void {
  if (scrollAndFlashEventRow(eventId)) return () => {};
  let attempts = 0;
  const timer = window.setInterval(() => {
    attempts += 1;
    if (scrollAndFlashEventRow(eventId) || attempts >= 40) {
      window.clearInterval(timer);
    }
  }, 50);
  return () => window.clearInterval(timer);
}
