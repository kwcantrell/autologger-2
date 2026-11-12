import { act, fireEvent, render, renderHook, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AutogenerateStep, AutogenerateWikiMode } from '../../../../api/types';
import { renderStrict } from '../../../../test/renderStrict';
import { AutogenerateConfirmMessage, AutogenerateOptions } from './AutogenerateOptions';
import { defaultAutogenerateSteps, useDebounced } from './autogenerateModel';

// playlist-import-autogenerate task 1.1 (design D8): the Steps and Wiki output groups shared by
// Settings → Batch autogenerate and the Batch Import modal, the confirm body and `useDebounced`.

function Harness({
  idPrefix,
  disabled,
  onSteps,
}: {
  idPrefix: string;
  disabled?: boolean;
  onSteps?: (s: Set<AutogenerateStep>) => void;
}) {
  const [steps, setSteps] = useState(defaultAutogenerateSteps());
  const [mode, setMode] = useState<AutogenerateWikiMode>('accept');
  return (
    <AutogenerateOptions
      idPrefix={idPrefix}
      steps={steps}
      onStepsChange={(s) => {
        onSteps?.(s);
        setSteps(s);
      }}
      mode={mode}
      onModeChange={setMode}
      disabled={disabled}
    />
  );
}

const stepBoxes = () =>
  within(screen.getByRole('group', { name: 'Steps' })).getAllByRole('checkbox');

describe('AutogenerateOptions', () => {
  it('renders the four steps in run order, ticked by the caller, and the wiki modes', () => {
    renderStrict(<Harness idPrefix="x" />);
    expect(stepBoxes().map((b) => b.getAttribute('aria-label'))).toEqual([
      'Transcripts',
      'Log events',
      'Topics',
      'Wiki',
    ]);
    expect(stepBoxes().every((b) => b.getAttribute('aria-checked') === 'true')).toBe(true);
    expect(
      screen
        .getByRole('radio', { name: 'Add new pages and additions to the wiki' })
        .getAttribute('aria-checked'),
    ).toBe('true');
    expect(screen.getByRole('radio', { name: 'Leave all as suggestions to review' })).toBeTruthy();
  });

  it('toggling a step calls back with the new set', () => {
    const onSteps = vi.fn();
    const last = () => (onSteps.mock.lastCall?.[0] ?? new Set()) as Set<string>;
    renderStrict(<Harness idPrefix="x" onSteps={onSteps} />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Topics' }));
    expect([...last()].sort()).toEqual(['events', 'transcript', 'wiki'].sort());
    fireEvent.click(screen.getByRole('checkbox', { name: 'Topics' }));
    expect(last().has('topics')).toBe(true);
  });

  it('the wiki radio is disabled without Wiki', () => {
    renderStrict(<Harness idPrefix="x" />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Wiki' }));
    for (const r of screen.getAllByRole('radio'))
      expect((r as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Wiki' }));
    for (const r of screen.getAllByRole('radio'))
      expect((r as HTMLButtonElement).disabled).toBe(false);
  });

  it('idPrefix keeps ids unique across two instances', () => {
    const { container } = renderStrict(
      <>
        <Harness idPrefix="a" />
        <Harness idPrefix="b" />
      </>,
    );
    const ids = [...container.querySelectorAll('[id]')].map((e) => e.id);
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
    for (const label of container.querySelectorAll('label[for]')) {
      expect(container.querySelector(`#${label.getAttribute('for')}`)).not.toBeNull();
    }
  });

  it('disabled disables every control', () => {
    renderStrict(<Harness idPrefix="x" disabled />);
    for (const b of stepBoxes()) expect((b as HTMLButtonElement).disabled).toBe(true);
    for (const r of screen.getAllByRole('radio'))
      expect((r as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('AutogenerateConfirmMessage', () => {
  it('renders the lead sentences first, then the own-accounts sentence, then the trailing ones', () => {
    render(
      <AutogenerateConfirmMessage
        lead={['First.', 'Second.']}
        trailing={['Last.']}
        mode="pending"
        wiki
      />,
    );
    const text = screen.getAllByText(/./).at(0)?.parentElement?.textContent ?? '';
    expect(text.indexOf('First.')).toBe(0);
    expect(text.indexOf('Second.')).toBeLessThan(
      text.indexOf('The work runs on your own provider accounts.'),
    );
    expect(text.indexOf('The work runs on your own provider accounts.')).toBeLessThan(
      text.indexOf('Last.'),
    );
    expect(text).not.toMatch(/without review/);
  });

  it('shows the auto-accept warning only in accept mode with Wiki ticked', () => {
    const warning =
      'AI-written new pages and additions will be added to wiki pages without review; rewrites that remove or change text stay as suggestions to review.';
    const { rerender } = render(<AutogenerateConfirmMessage lead={[]} mode="accept" wiki />);
    expect(screen.getByText(warning)).toBeTruthy();
    rerender(<AutogenerateConfirmMessage lead={[]} mode="accept" wiki={false} />);
    expect(screen.queryByText(warning)).toBeNull();
    rerender(<AutogenerateConfirmMessage lead={[]} mode="pending" wiki />);
    expect(screen.queryByText(warning)).toBeNull();
  });
});

describe('useDebounced', () => {
  afterEach(() => vi.useRealTimers());

  it('delays a value by the given ms and keeps only the last change', () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ v }) => useDebounced(v, 400), {
      initialProps: { v: 'a' },
    });
    expect(result.current).toBe('a');
    rerender({ v: 'b' });
    act(() => vi.advanceTimersByTime(300));
    rerender({ v: 'c' });
    act(() => vi.advanceTimersByTime(399));
    expect(result.current).toBe('a');
    act(() => vi.advanceTimersByTime(1));
    expect(result.current).toBe('c');
  });
});
