/**
 * True while any dialog, alert dialog, or menu is open (shadcn-shared-wrappers D4;
 * web-ui-system "Global single-key handlers yield to dialogs and interactive targets").
 * The global single-key shortcut handlers (Space, `+`/`−`, `1–9`, `?`) bail out when this is
 * true. Radix renders `role="menu"` content only while a menu is open; the themed confirm is a
 * `role="alertdialog"` on desktop, which a bare `[role="dialog"]` check would miss.
 */
const OVERLAY_SELECTOR = '[role="dialog"],[role="alertdialog"],[role="menu"]';

export function isOverlayOpen(root: ParentNode = document, except?: string): boolean {
  if (!except) return root.querySelector(OVERLAY_SELECTOR) !== null;
  // `except` names one overlay to look past (the Settings view, for the two keys it lets
  // through: the shell's `[` and its own Escape). Any other open overlay still counts.
  for (const el of root.querySelectorAll(OVERLAY_SELECTOR)) if (!el.matches(except)) return true;
  return false;
}
