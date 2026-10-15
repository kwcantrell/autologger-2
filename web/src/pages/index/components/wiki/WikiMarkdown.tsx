// A wiki page body rendered as Markdown into React elements (show-wiki D5; spec "Page bodies render
// safely"). Raw HTML is skipped, never parsed. Only `https:` links and `cite:`/`wiki:` links that
// match the exact grammar stay clickable: `urlTransform` blanks every other URL, and the `a`
// renderer shows a blank link as its text. Images render as their alt text. No remark or rehype
// plugins.

import type { MouseEvent, ReactNode } from 'react';
import Markdown, { type Components, type UrlTransform } from 'react-markdown';
import { cn } from '@/shared/lib/utils';
import { navigate } from '../../navigation';
import { formatMomentTime, secondsHref } from '../search/searchLinks';
import { classifyWikiUrl, isHttpsUrl } from './wikiUrl';

export function wikiPageHref(pageId: string): string {
  return `/wiki/${encodeURIComponent(pageId)}`;
}

const urlTransform: UrlTransform = (url) =>
  classifyWikiUrl(url) !== null || isHttpsUrl(url) ? url : '';

const LINK_CLASS =
  'text-si-fg underline decoration-v5-border-strong underline-offset-2 hover-always:text-si-accent';

/** An in-app link: a real `href` (open in new tab works), a plain click goes through `navigate`. */
function InAppLink({ href, children }: { href: string; children: ReactNode }) {
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(href);
  };
  return (
    <a href={href} onClick={onClick} className={LINK_CLASS}>
      {children}
    </a>
  );
}

const components: Components = {
  a({ href, children }) {
    if (!href) return <span>{children}</span>;
    const target = classifyWikiUrl(href);
    if (target?.kind === 'cite') {
      return (
        <InAppLink href={secondsHref(target.sessionId, target.seconds)}>
          {children}{' '}
          <span className="font-mono text-[0.85em] text-si-dim tabular-nums">
            {formatMomentTime(target.seconds)}
          </span>
        </InAppLink>
      );
    }
    if (target?.kind === 'wiki') {
      return <InAppLink href={wikiPageHref(target.pageId)}>{children}</InAppLink>;
    }
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" className={LINK_CLASS}>
        {children}
      </a>
    );
  },
  img({ alt }) {
    return <>{alt ?? ''}</>;
  },
};

const PROSE_CLASS = [
  'text-[0.9rem] leading-relaxed text-si-fg',
  '[&_p]:my-2 [&_h1]:mt-4 [&_h1]:mb-2 [&_h1]:text-xl [&_h1]:font-semibold',
  '[&_h2]:mt-4 [&_h2]:mb-2 [&_h2]:text-lg [&_h2]:font-semibold',
  '[&_h3]:mt-3 [&_h3]:mb-1 [&_h3]:text-base [&_h3]:font-semibold',
  '[&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5',
  '[&_blockquote]:border-l-2 [&_blockquote]:border-v5-border-strong [&_blockquote]:pl-3 [&_blockquote]:text-si-muted',
  '[&_code]:font-mono [&_code]:text-[0.85em] [&_pre]:overflow-x-auto [&_pre]:rounded-ctl [&_pre]:bg-si-panel-2 [&_pre]:p-3',
].join(' ');

export function WikiMarkdown({ body, className }: { body: string; className?: string }) {
  return (
    <div className={cn(PROSE_CLASS, className)}>
      <Markdown skipHtml urlTransform={urlTransform} components={components}>
        {body}
      </Markdown>
    </div>
  );
}
