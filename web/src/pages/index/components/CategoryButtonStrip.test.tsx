import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useLogEvent } from '../../../api/hooks/useEvents';
import { useShowCategories } from '../../../api/hooks/useShowCategories';
import type { Category } from '../../../api/types';
import { renderStrict } from '../../../test/renderStrict';
import { CategoryButtonStrip } from './CategoryButtonStrip';

// --- CategoryButtonStrip 1–9 hotkey guard set (ui-refresh, task 4.2) ---
//
// The spec ("Logging hotkeys 1–9", web-session-console) pins the full guard
// enumeration: fire at most once per physical keypress (auto-repeat ignored via
// `event.repeat`), never while a text-entry element has focus, never while any
// `[role="dialog"]` is open, and never with Ctrl/Meta/Alt held — Shift is
// deliberately PERMITTED (digits require Shift on some layouts). These tests
// exercise the document-level keydown listener directly.

vi.mock('../../../api/hooks/useShowCategories', () => ({
  useShowCategories: vi.fn(),
}));
vi.mock('../../../api/hooks/useEvents', () => ({
  useLogEvent: vi.fn(),
}));
vi.mock('../../../shared/components/Toast', () => ({
  showToast: vi.fn(),
}));

const mockedUseShowCategories = vi.mocked(useShowCategories);
const mockedUseLogEvent = vi.mocked(useLogEvent);

function categoryFixture(id: string, label: string): Category {
  return {
    id,
    label,
    color: '#4488ff',
    type: 'BUTTON',
    dropdown_options: [],
    on_label: '',
    off_label: '',
  };
}

const CATEGORIES = [
  categoryFixture('cat-1', 'Alpha'),
  categoryFixture('cat-2', 'Bravo'),
  categoryFixture('cat-3', 'Charlie'),
];

let mutateAsync: ReturnType<typeof vi.fn>;

function renderStrip({ isRolling = true }: { isRolling?: boolean } = {}) {
  return renderStrict(
    <CategoryButtonStrip
      sessionId="sess-hotkeys-1"
      isRolling={isRolling}
      onOffState={new Map()}
      onToggle={vi.fn()}
    />,
  );
}

beforeEach(() => {
  mutateAsync = vi.fn().mockResolvedValue({});
  mockedUseShowCategories.mockReturnValue({
    data: { categories: CATEGORIES },
    isLoading: false,
  } as unknown as ReturnType<typeof useShowCategories>);
  mockedUseLogEvent.mockReturnValue({ mutateAsync } as unknown as ReturnType<typeof useLogEvent>);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('CategoryButtonStrip 1–9 hotkeys', () => {
  it('fires the nth category action on a digit keypress', async () => {
    renderStrip();
    fireEvent.keyDown(document.body, { key: '2' });
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(mutateAsync).toHaveBeenCalledWith({ category: 'cat-2', message: 'Bravo' });
  });

  it('permits Shift (digits require it on some layouts)', async () => {
    renderStrip();
    fireEvent.keyDown(document.body, { key: '1', shiftKey: true });
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(mutateAsync).toHaveBeenCalledWith({ category: 'cat-1', message: 'Alpha' });
  });

  it('ignores auto-repeat (fires at most once per physical keypress)', async () => {
    renderStrip();
    fireEvent.keyDown(document.body, { key: '2' });
    fireEvent.keyDown(document.body, { key: '2', repeat: true });
    fireEvent.keyDown(document.body, { key: '2', repeat: true });
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
  });

  it('ignores digits while a text-entry element has focus', () => {
    renderStrip();
    const input = document.createElement('input');
    document.body.appendChild(input);
    try {
      fireEvent.keyDown(input, { key: '2' });
      expect(mutateAsync).not.toHaveBeenCalled();
    } finally {
      input.remove();
    }
  });

  it('ignores digits while any [role="dialog"] is open', () => {
    renderStrip();
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    document.body.appendChild(dialog);
    try {
      fireEvent.keyDown(document.body, { key: '2' });
      expect(mutateAsync).not.toHaveBeenCalled();
    } finally {
      dialog.remove();
    }
  });

  it('ignores digits with Ctrl, Meta, or Alt held', () => {
    renderStrip();
    fireEvent.keyDown(document.body, { key: '2', ctrlKey: true });
    fireEvent.keyDown(document.body, { key: '2', metaKey: true });
    fireEvent.keyDown(document.body, { key: '2', altKey: true });
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it('does not listen at all when the live dock is not shown (isRolling=false)', () => {
    renderStrip({ isRolling: false });
    fireEvent.keyDown(document.body, { key: '2' });
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it('renders aria-hidden digit badges on the first nine live tiles', () => {
    renderStrip();
    const firstTile = screen.getByRole('button', { name: /Alpha/ });
    const badge = firstTile.querySelector('span[aria-hidden="true"]');
    expect(badge).not.toBeNull();
    expect(badge?.textContent).toBe('1');
  });
});
