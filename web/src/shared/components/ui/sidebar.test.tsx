import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SIDEBAR_STORAGE_KEY,
  Sidebar,
  SidebarContent,
  SidebarProvider,
  SidebarTrigger,
} from './sidebar';

// redesign-show-ignition D10: the generated sidebar persisted its open state in a cookie; the
// shell sets and reads no cookies, so it persists in localStorage (try/catch, default expanded).

function Shell() {
  return (
    <SidebarProvider>
      <Sidebar collapsible="icon">
        <SidebarContent>Rail</SidebarContent>
      </Sidebar>
      <SidebarTrigger />
    </SidebarProvider>
  );
}

const sidebarState = () =>
  document.querySelector('[data-slot="sidebar"]')?.getAttribute('data-state') ?? null;

describe('Sidebar persistence', () => {
  let cookieSet: ReturnType<typeof vi.fn<(value: string) => void>>;

  beforeEach(() => {
    window.localStorage.clear();
    cookieSet = vi.fn<(value: string) => void>();
    Object.defineProperty(document, 'cookie', {
      configurable: true,
      get: () => '',
      set: cookieSet,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // Drop the own-property cookie stub so the Document.prototype accessor is visible again.
    delete (document as unknown as Record<string, unknown>).cookie;
  });

  it('is expanded by default', () => {
    render(<Shell />);
    expect(sidebarState()).toBe('expanded');
  });

  it('toggling writes localStorage and never document.cookie', () => {
    render(<Shell />);
    fireEvent.click(screen.getByRole('button', { name: /toggle sidebar/i }));
    expect(sidebarState()).toBe('collapsed');
    expect(window.localStorage.getItem(SIDEBAR_STORAGE_KEY)).toBe('collapsed');
    fireEvent.click(screen.getByRole('button', { name: /toggle sidebar/i }));
    expect(window.localStorage.getItem(SIDEBAR_STORAGE_KEY)).toBe('expanded');
    expect(cookieSet).not.toHaveBeenCalled();
  });

  it('the collapsed state survives a remount', () => {
    const first = render(<Shell />);
    fireEvent.click(screen.getByRole('button', { name: /toggle sidebar/i }));
    first.unmount();
    render(<Shell />);
    expect(sidebarState()).toBe('collapsed');
  });

  it('storage that throws defaults to expanded, and toggling still works', () => {
    // Private windows and blocked site data throw on access, not just on read.
    const own = Object.getOwnPropertyDescriptor(window, 'localStorage');
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get: () => {
        throw new Error('denied');
      },
    });
    try {
      render(<Shell />);
      expect(sidebarState()).toBe('expanded');
      fireEvent.click(screen.getByRole('button', { name: /toggle sidebar/i }));
      expect(sidebarState()).toBe('collapsed');
      expect(cookieSet).not.toHaveBeenCalled();
    } finally {
      if (own) Object.defineProperty(window, 'localStorage', own);
      else delete (window as unknown as Record<string, unknown>).localStorage;
    }
  });

  it('uses the preview widths (272px expanded, 68px icon)', () => {
    render(<Shell />);
    const wrapper = document.querySelector('[data-slot="sidebar-wrapper"]') as HTMLElement;
    expect(wrapper.style.getPropertyValue('--sidebar-width')).toBe('272px');
    expect(wrapper.style.getPropertyValue('--sidebar-width-icon')).toBe('68px');
  });
});
