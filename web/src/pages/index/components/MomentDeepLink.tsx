import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useSearch as useLocationSearch } from 'wouter';
import { useEvents, WORKSPACE_EVENTS_LIMIT } from '../../../api/hooks/useEvents';
import { useSessionStatus } from '../../../api/hooks/useSessionStatus';
import { useTopics } from '../../../api/hooks/useTopics';
import { useTranscriptWords } from '../../../api/hooks/useTranscriptWords';
import type { SessionStatus } from '../../../api/types';
import { isRegistered } from '../coordination/registry';
import { navigate } from '../navigation';
import { jumpTimelineToSec } from '../utils/timelineJump';
import { eventRowTimelineSec } from './EventLogSheet';
import { transcriptWhollyAnchorless } from './TopicsFeed';
import { topicsRowTimelineSec } from './TopicsRow';

// --- Moment deep links (catalog-search D8; web-session-routing "Moment deep links") ---
//
// `/sessions/:id` takes one moment parameter: `t=<seconds>`, `topic=<id>` or `event=<id>`, in
// that precedence. The workspace applies it:
//   - once the session's status has resolved and the timeline has registered its handles (the
//     timeline mounts with the workspace, so this is polled briefly rather than subscribed to);
//   - never while the session is rolling;
//   - through `jumpTimelineToSec`, which moves the playhead and never plays (`useTimelineSeek`'s
//     jump would start playback when a clip covers the target, so it is not used);
//   - with a topic or event placed by its feed row's own rule, gate included
//     (`topicsRowTimelineSec` behind `transcriptWhollyAnchorless`; `eventRowTimelineSec`);
//   - exactly once, after which every moment parameter is removed with a history replace, so a
//     reload or Back does not seek again. An unusable target is removed the same way, unseeked.
// The URL's search string is watched, so a link into the session already open (a same-id
// navigation: no remount, no departure) applies the same way.
//
// Shape: `MomentDeepLink` renders nothing, and mounts a per-kind applier only while the URL names
// a moment (keyed by the search string, so each link applies once). The topic and event appliers
// are the only readers of the topics, transcript words and events here: with no such link, this
// adds no query observer to the workspace (the words fetch stays behind its tab gate, perf B4).

export const MOMENT_TIMELINE_WAIT_MS = 10_000;
const TIMELINE_POLL_MS = 50;
const MOMENT_PARAMS = ['t', 'topic', 'event'] as const;

export type MomentTarget =
  | { kind: 't'; sec: number }
  | { kind: 'topic'; id: string }
  | { kind: 'event'; id: string }
  | { kind: 'invalid' };

const SECONDS_RE = /^(\d+(\.\d+)?|\.\d+)$/;

/** The moment a search string asks for, or `null` when it names none. The highest-precedence
 * parameter present decides; when it is unusable the link is `invalid`, not the next one. */
export function parseMomentParams(search: string): MomentTarget | null {
  const params = new URLSearchParams(search);
  const t = params.get('t');
  if (t !== null) {
    const sec = SECONDS_RE.test(t.trim()) ? Number(t.trim()) : Number.NaN;
    return Number.isFinite(sec) && sec >= 0 ? { kind: 't', sec } : { kind: 'invalid' };
  }
  const topic = params.get('topic');
  if (topic !== null) return topic ? { kind: 'topic', id: topic } : { kind: 'invalid' };
  const event = params.get('event');
  if (event !== null) return event ? { kind: 'event', id: event } : { kind: 'invalid' };
  return null;
}

function withoutMoment(pathname: string, search: string): string {
  const params = new URLSearchParams(search);
  for (const p of MOMENT_PARAMS) params.delete(p);
  const rest = params.toString();
  return rest ? `${pathname}?${rest}` : pathname;
}

function timelineRegistered(): boolean {
  return isRegistered('setManualScrubSec') && isRegistered('scrollTimelineToSec');
}

interface QueryState {
  data?: unknown;
  isSuccess?: boolean;
  isError?: boolean;
}
const settled = (q: QueryState) => Boolean(q.isSuccess || q.isError || q.data !== undefined);

interface ApplierProps {
  sessionId: string;
  search: string;
  pathname: string;
  status: SessionStatus | undefined;
  statusError: boolean;
}

/**
 * Applies one link once. `sec` is the target second, `null` for an unusable target, `undefined`
 * while the data that places it is still loading.
 */
function useApplyMoment(
  { search, pathname, status, statusError }: ApplierProps,
  sec: number | null | undefined,
) {
  const done = useRef(false);
  const waitStartedAt = useRef<number | null>(null);
  const [pollTick, setPollTick] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: pollTick re-runs the readiness check
  useEffect(() => {
    if (done.current) return;
    const finish = (to: number | null) => {
      done.current = true;
      if (to != null) jumpTimelineToSec(to);
      navigate(withoutMoment(pathname, search), { replace: true });
    };
    if (sec === null || statusError) return finish(null);
    if (!status) return;
    if (status.is_rolling) return finish(null);
    if (sec === undefined) return;
    if (!timelineRegistered()) {
      const now = Date.now();
      waitStartedAt.current ??= now;
      if (now - waitStartedAt.current >= MOMENT_TIMELINE_WAIT_MS) return finish(null);
      const t = setTimeout(() => setPollTick((n) => n + 1), TIMELINE_POLL_MS);
      return () => clearTimeout(t);
    }
    finish(sec);
  }, [sec, status, statusError, search, pathname, pollTick]);
}

function FixedMoment({ sec, ...props }: ApplierProps & { sec: number | null }) {
  useApplyMoment(props, sec);
  return null;
}

function TopicMoment({ id, ...props }: ApplierProps & { id: string }) {
  const topics = useTopics(props.sessionId);
  const words = useTranscriptWords(props.sessionId, { enabled: true });
  let sec: number | null | undefined;
  if (props.status && settled(topics) && settled(words)) {
    const row = topics.data?.find((t) => t.id === id);
    // The feed's gate: an unknown transcript reads as unanchored (TopicsFeed `words != null`).
    const anchored = words.data != null && !transcriptWhollyAnchorless(words.data);
    sec = row ? topicsRowTimelineSec(row, props.status.frame_rate ?? null, anchored) : null;
  }
  useApplyMoment(props, sec);
  return null;
}

function EventMoment({ id, ...props }: ApplierProps & { id: string }) {
  const events = useEvents(props.sessionId, { limit: WORKSPACE_EVENTS_LIMIT });
  let sec: number | null | undefined;
  if (settled(events)) {
    const ev = events.data?.events.find((e) => e.event_id === id);
    sec = ev ? eventRowTimelineSec(ev) : null;
  }
  useApplyMoment(props, sec);
  return null;
}

/** Mounted once by the session workspace; renders nothing. */
export function MomentDeepLink({ sessionId }: { sessionId: string }) {
  const search = useLocationSearch();
  const [pathname] = useLocation();
  const target = useMemo(() => parseMomentParams(search), [search]);
  const { data: status, isError } = useSessionStatus(sessionId || null);
  if (!target || !sessionId) return null;
  const props: ApplierProps = { sessionId, search, pathname, status, statusError: isError };
  // Keyed by session and search string: each link (even a repeat of the same moment) applies once.
  const key = `${sessionId}?${search}`;
  switch (target.kind) {
    case 't':
      return <FixedMoment key={key} sec={target.sec} {...props} />;
    case 'invalid':
      return <FixedMoment key={key} sec={null} {...props} />;
    case 'topic':
      return <TopicMoment key={key} id={target.id} {...props} />;
    case 'event':
      return <EventMoment key={key} id={target.id} {...props} />;
  }
}
