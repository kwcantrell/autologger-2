import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '../shared/components/ui/dialog';

// Guards the macrotask wait in setup.ts's cleanup hook. Radix FocusScope restores focus in a 0 ms
// timer scheduled when it unmounts, and calls `onCloseAutoFocus` from that timer. If the shared
// cleanup returned without letting that timer run, a dialog still open at the end of a file's
// last test would have it fire after vitest tore jsdom down: an unhandled "Failed to execute
// 'dispatchEvent' on 'EventTarget'" error. The tests run in order: the first leaves a dialog
// open for cleanup to unmount; the second checks, before it yields once, that the focus restore
// already ran inside the first test's cleanup. Plain `render`, not `renderStrict`: StrictMode's
// simulated unmount would schedule a second focus restore of its own.
const closeAutoFocusCalls: string[] = [];

describe('shared cleanup runs the focus restore of a dialog it unmounts', () => {
  it('leaves a dialog open for cleanup to unmount', () => {
    render(
      <Dialog open>
        <DialogContent onCloseAutoFocus={() => closeAutoFocusCalls.push('restored')}>
          <DialogTitle>Left open</DialogTitle>
          <DialogDescription>cleanup unmounts this</DialogDescription>
        </DialogContent>
      </Dialog>,
    );
    expect(screen.getByRole('dialog', { name: 'Left open' })).toBeTruthy();
    expect(closeAutoFocusCalls).toEqual([]);
  });

  it('has already run the focus restore by the time the next test starts', () => {
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(closeAutoFocusCalls).toEqual(['restored']);
  });
});
