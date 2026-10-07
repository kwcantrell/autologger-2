import { afterEach, describe, expect, it } from 'vitest';
import { isOverlayOpen } from './overlayOpen';

// shadcn-shared-wrappers D4 / web-ui-system "Global single-key handlers yield to dialogs":
// global single-key shortcuts yield to any open dialog, alert dialog, or menu. Radix renders
// role="menu" content only while a menu is open, so a closed menu never matches.
afterEach(() => {
  document.body.innerHTML = '';
});

function add(role: string) {
  const el = document.createElement('div');
  el.setAttribute('role', role);
  document.body.appendChild(el);
}

describe('isOverlayOpen', () => {
  it('is false with no overlay in the document', () => {
    expect(isOverlayOpen()).toBe(false);
  });

  it.each([
    'dialog',
    'alertdialog',
    'menu',
  ])('is true while a role="%s" element is present', (role) => {
    add(role);
    expect(isOverlayOpen()).toBe(true);
  });

  it('ignores unrelated roles (menuitem buttons, listbox, tooltip)', () => {
    for (const role of ['menuitem', 'listbox', 'tooltip', 'status']) add(role);
    expect(isOverlayOpen()).toBe(false);
  });

  it('checks the given root instead of the document', () => {
    add('dialog');
    const other = document.createElement('div');
    expect(isOverlayOpen(other)).toBe(false);
  });
  it('looks past the one overlay named by `except`, and only that one', () => {
    const view = document.createElement('div');
    view.setAttribute('role', 'dialog');
    view.setAttribute('data-slot', 'settings-view');
    document.body.appendChild(view);
    expect(isOverlayOpen(document, '[data-slot="settings-view"]')).toBe(false);
    expect(isOverlayOpen()).toBe(true);
    add('menu');
    expect(isOverlayOpen(document, '[data-slot="settings-view"]')).toBe(true);
  });
});
