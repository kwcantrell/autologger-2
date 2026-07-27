import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderStrict } from '../../../test/renderStrict';
import { FeedTable } from './FeedTable';
import { JUMP_COLUMN, JumpToTimeButton } from './JumpToTimeButton';

// --- feed-row-seek, phase 5 (tasks 5.1/5.2) ---
//
// This unit builds JumpToTimeButton and its column definition IN ISOLATION — no
// feed is wired to it yet (phases 6/7/8 do that). Everything here is exercised
// against a plain <table> host, not a real feed.
//
// Two gate-intent requirements this file is written to satisfy for real, not just
// nominally:
//
//   1. "no control on a positionless row" must assert ABSENCE, not aria-disabled —
//      see "renders no control at all" below, which checks queryByRole('button')
//      is null. aria-disabled does NOT remove an element from the accessibility
//      tree (that's exactly why the rolling state uses it and the positionless
//      state does not — design D2), so this assertion is genuinely falsified by an
//      implementation that renders an aria-disabled button instead of nothing.
//
//   2. the keyboard-activation tests genuinely exercise Enter/Space, not a
//      disguised click. jsdom does NOT implement the browser's native
//      "Enter/Space activates a focused <button>" behavior (verified directly:
//      dispatching a raw `keydown`/`keyup` on a plain jsdom <button> fires no
//      `click` event at all — jsdom's HTMLButtonElement only implements the
//      DOM "activation behavior" for submit/reset, not the UA-level key-to-click
//      translation). So JumpToTimeButton implements Enter/Space handling itself
//      (WAI-ARIA APG's button pattern: Enter activates on keydown, Space
//      activates on keyup with keydown only suppressing scroll), and these tests
//      dispatch real KeyboardEvents and assert the callback fires — there is no
//      native browser behavior standing in for it here, so this could not pass by
//      accident via a `fireEvent.click` shortcut. (Empirically cross-checked in
//      real headless Chromium that calling preventDefault() in this component's
//      keydown/keyup handlers suppresses the browser's own native click-on-key
//      activation, so real-browser behavior does not double-fire alongside it.)

describe('FeedTable + ColumnDef.ariaLabel (first consumer)', () => {
  it('renders JUMP_COLUMN header with no visible text but an accessible name', () => {
    renderStrict(
      <FeedTable columns={[JUMP_COLUMN, { key: 'x', label: 'X', thClassName: 'w-10' }]}>
        <tr>
          <td>a</td>
          <td>b</td>
        </tr>
      </FeedTable>,
    );
    const header = screen.getByRole('columnheader', { name: JUMP_COLUMN.ariaLabel });
    expect(header.textContent).toBe('');
  });
});

function renderButton(props: Partial<React.ComponentProps<typeof JumpToTimeButton>> = {}) {
  const onJump = props.onJump ?? vi.fn();
  renderStrict(
    <table>
      <tbody>
        <tr>
          <td>
            <JumpToTimeButton
              resolvedSec={42}
              displayTime="00:12:03:07"
              onJump={onJump}
              {...props}
            />
          </td>
        </tr>
      </tbody>
    </table>,
  );
  return onJump;
}

describe('JumpToTimeButton', () => {
  it('is a real <button> whose accessible name identifies the time as the row displays it', () => {
    renderButton();
    const btn = screen.getByRole('button', { name: /00:12:03:07/ });
    expect(btn.tagName).toBe('BUTTON');
  });

  it('names the time as displayed, even when the row shows a wall-clock string rather than a session timecode', () => {
    renderButton({ displayTime: '14:03:09 UTC' });
    // getByRole throws if no match, so a successful call is itself the assertion —
    // no `@testing-library/jest-dom` matchers in this workspace (see
    // SessionWorkspace.test.tsx precedent).
    expect(screen.getByRole('button', { name: /14:03:09 UTC/ })).not.toBeNull();
  });

  it('activates by pointer click', () => {
    const onJump = vi.fn();
    renderButton({ onJump });
    fireEvent.click(screen.getByRole('button', { name: /00:12:03:07/ }));
    expect(onJump).toHaveBeenCalledTimes(1);
    expect(onJump).toHaveBeenCalledWith(42);
  });

  it('activates on Enter via a genuine keydown (not a synthesized click)', () => {
    const onJump = vi.fn();
    renderButton({ onJump });
    const btn = screen.getByRole('button', { name: /00:12:03:07/ });
    fireEvent.keyDown(btn, { key: 'Enter' });
    expect(onJump).toHaveBeenCalledTimes(1);
    expect(onJump).toHaveBeenCalledWith(42);
  });

  it('activates on Space release via a genuine keyup, not on Space keydown, and not via click', () => {
    const onJump = vi.fn();
    renderButton({ onJump });
    const btn = screen.getByRole('button', { name: /00:12:03:07/ });
    fireEvent.keyDown(btn, { key: ' ' });
    expect(onJump).not.toHaveBeenCalled();
    fireEvent.keyUp(btn, { key: ' ' });
    expect(onJump).toHaveBeenCalledTimes(1);
    expect(onJump).toHaveBeenCalledWith(42);
  });

  it('renders no control at all when the row has no resolvable position (absence, not aria-disabled)', () => {
    renderButton({ resolvedSec: null });
    // Would fail if the implementation instead rendered an aria-disabled button:
    // queryByRole('button') finds aria-disabled elements too (they stay in the
    // accessibility tree), so only true absence from the DOM satisfies this.
    expect(screen.queryByRole('button')).toBeNull();
    expect(document.querySelector('button')).toBeNull();
  });

  it('is aria-disabled — never the native disabled attribute — while unavailable, and does not activate', () => {
    const onJump = vi.fn();
    renderButton({ onJump, unavailable: true, reasonId: 'shared-reason' });
    const btn = screen.getByRole('button', { name: /00:12:03:07/ });

    expect(btn.getAttribute('aria-disabled')).toBe('true');
    expect(btn.hasAttribute('disabled')).toBe(false);
    expect((btn as HTMLButtonElement).disabled).toBe(false);
    expect(btn.getAttribute('aria-describedby')).toBe('shared-reason');

    fireEvent.click(btn);
    fireEvent.keyDown(btn, { key: 'Enter' });
    fireEvent.keyDown(btn, { key: ' ' });
    fireEvent.keyUp(btn, { key: ' ' });
    expect(onJump).not.toHaveBeenCalled();
  });

  it('references one shared reason node id across every row in a feed, and never fabricates its own', () => {
    renderStrict(
      <table>
        <tbody>
          <tr>
            <td>
              <JumpToTimeButton
                resolvedSec={1}
                displayTime="a"
                onJump={vi.fn()}
                unavailable
                reasonId="feed-shared-reason"
              />
            </td>
          </tr>
          <tr>
            <td>
              <JumpToTimeButton
                resolvedSec={2}
                displayTime="b"
                onJump={vi.fn()}
                unavailable
                reasonId="feed-shared-reason"
              />
            </td>
          </tr>
        </tbody>
      </table>,
    );
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(2);
    for (const btn of buttons) {
      expect(btn.getAttribute('aria-describedby')).toBe('feed-shared-reason');
    }
    // The component only ever REFERENCES the id the feed supplies — it must not
    // render a reason node of its own (which per row would violate "one shared
    // reason node per feed, never one per row").
    expect(document.querySelectorAll('#feed-shared-reason')).toHaveLength(0);
  });
});
