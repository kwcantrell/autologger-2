import type { ComponentProps, MouseEvent } from 'react';
import { navigate } from '../../navigation';

// A real link to `/wiki/<pageId>` (so it opens in a new tab and copies like one) that opens in
// place on a plain left click, through the app's single navigation funnel.

export function wikiPageHref(pageId: string): string {
  return `/wiki/${encodeURIComponent(pageId)}`;
}

/** Open `href` in place on a plain left click; leave modified clicks to the browser. */
export function openInPlace(e: MouseEvent<HTMLAnchorElement>, href: string): boolean {
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return false;
  e.preventDefault();
  navigate(href);
  return true;
}

type Props = Omit<ComponentProps<'a'>, 'href'> & {
  pageId: string;
  /** Runs when a plain left click opens the page in place. */
  onOpen?: () => void;
};

export function WikiPageLink({ pageId, onOpen, onClick, ...rest }: Props) {
  const href = wikiPageHref(pageId);
  return (
    <a
      {...rest}
      href={href}
      onClick={(e) => {
        onClick?.(e);
        if (!e.defaultPrevented && openInPlace(e, href)) onOpen?.();
      }}
    />
  );
}
