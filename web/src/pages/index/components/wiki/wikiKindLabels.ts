import type { WikiKind } from '../../../../api/types';

/** A page kind as the wiki screens name it (show-wiki "Wiki screens"). */
export const WIKI_KIND_LABEL: Record<WikiKind, string> = {
  person: 'Person',
  topic: 'Topic',
  bit: 'Running bit',
  session: 'Session',
};

/** The kinds a person can give a new page by hand; `session` pages come from a session. */
export const SPLIT_KINDS = ['person', 'topic', 'bit'] as const satisfies readonly WikiKind[];
