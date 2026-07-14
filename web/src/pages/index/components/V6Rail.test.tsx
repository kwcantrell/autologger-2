import { fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { useSessions } from '../../../api/hooks/useSessions';
import { renderStrict } from '../../../test/renderStrict';
import { setNavigationImplForTesting } from '../navigation';
import { V6Rail } from './V6Rail';

// --- V6Rail Teams-button same-route guard (teams-settings-nav, task 2.3;
// design D2 gate decision 1) ---
//
// Mocked at module boundaries (the AppShell.test.tsx idiom): `useSessions`
// and the two session-list components are stubbed — this file's only
// concern is the rail's own navigation wiring, exercised through a real
// wouter `Router` (memoryLocation, recorded) the same way AppShell.test.tsx
// drives full-shell routing. The button click reaches the shared `navigate`
// wrapper, which routes through the test-seam impl into the recorded
// memory location (same seam SessionRoute.test.tsx and AppShell.test.tsx use).

vi.mock('../../../api/hooks/useSessions', () => ({
  useSessions: vi.fn(),
}));

vi.mock('./RecentSessionsList', () => ({
  RecentSessionsList: () => null,
  ArchivedSessionsList: () => null,
}));

const mockedUseSessions = vi.mocked(useSessions);

function renderRail(initialPath: string) {
  const memory = memoryLocation({ path: initialPath, record: true });
  setNavigationImplForTesting((path, options) => memory.navigate(path, options));
  const view = renderStrict(
    <Router hook={memory.hook}>
      <V6Rail
        activeSessionId=""
        onSelectSession={() => {}}
        onCloseSession={() => {}}
        onNewSession={() => {}}
        onOpenSettings={() => {}}
      />
    </Router>,
  );
  return { view, memory };
}

beforeEach(() => {
  mockedUseSessions.mockReturnValue({
    data: undefined,
    isLoading: false,
  } as unknown as ReturnType<typeof useSessions>);
});

afterEach(() => {
  setNavigationImplForTesting(null);
});

describe('V6Rail Teams button same-route guard (gate decision 1)', () => {
  it('navigates to /teams when not already on /teams', () => {
    const { memory } = renderRail('/');

    fireEvent.click(screen.getByRole('button', { name: 'Teams' }));

    expect(memory.history).toEqual(['/', '/teams']);
  });

  it('pushes no history entry when clicked while already on /teams', () => {
    const { memory } = renderRail('/teams');

    fireEvent.click(screen.getByRole('button', { name: 'Teams' }));

    expect(memory.history).toEqual(['/teams']);
  });
});
