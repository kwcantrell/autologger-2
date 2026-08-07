// REAL end-to-end topic-generation test — spawns the ACTUAL `claude` CLI
// against the real in-process autologger MCP server and asserts topics are
// genuinely created from a real, MULTI-PAGE transcript.
//
// WHY: the hermetic `topicGenerate.test.ts` / integration tests drive a FAKE
// claude (fixtures), so they cannot catch *model-behavior* failures — e.g. the
// real model, told by the reused system prompt to `list_topics` (a tool the
// one-shot withholds), creating ZERO topics. This test exercises the true path.
//
// It is also the PRIMARY acceptance evidence for topic-generate-paged-transcript
// (task 4.1, design D8): before this change no real-model *paging* run existed
// anywhere in the repo (both real-test fixtures were single-page), so the paged
// generation-density delivery had never been validated against an actual model.
// The fixture below therefore spans several size-capped pages, carries
// INCREASING per-word timecodes across the whole session, and hides an
// unguessable content canary on the LAST page — a run that stops after page 0
// cannot produce it. The turn runs at the SHIPPED production defaults
// (`topicGenerateMaxBudgetUsd`/`topicGenerateTimeoutSec` with an empty config),
// so this is evidence about the configuration operators actually get, not about
// hand-picked test bounds.
//
// GATED — costs real Anthropic spend, so it NEVER runs in `npm test`. It runs
// ONLY when the operator explicitly opts in with `RUN_REAL_AI_TESTS=1` AND a
// `claude` CLI is resolvable (via `CLAUDE_CLI_PATH` or on `PATH`). Run it with:
//
//   RUN_REAL_AI_TESTS=1 npm run test:real -w server
//
// Deterministic skip otherwise (no spawn, no spend).

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from '@autologger/ports';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { topicGenerateMaxBudgetUsd, topicGenerateTimeoutSec } from '../env';
import { SessionHubRegistry } from '../session/SessionHub';
import { stableSessionCwd } from './aiChatRunner';
import { __resetAiMcpListenerForTests, renderGenerationTranscriptPage } from './aiMcpServer';
import { generateTopicsTurn } from './topicGenerate';

function resolveClaude(): string | null {
  const candidate = (process.env.CLAUDE_CLI_PATH || '').trim() || 'claude';
  const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8' });
  return probe.status === 0 ? candidate : null;
}

// Gate the CLI probe itself behind the opt-in: in a normal `npm test` run this
// module is imported (vitest's unit glob includes it), so an unconditional
// probe would spawn `claude --version` on every test run. Only resolve when the
// operator has opted in — otherwise no subprocess is spawned at all.
const OPTED_IN = process.env.RUN_REAL_AI_TESTS === '1';
const cliPath = OPTED_IN ? resolveClaude() : null;
const RUN = OPTED_IN && cliPath !== null;

// The PRODUCTION bounds, read from the same accessors the route uses with an
// empty config — i.e. the shipped defaults (5.0 USD / 600s). Hard-coding them
// here (the pre-change test used `maxBudgetUsd: 5` / `timeoutMs: 300_000`) would
// let the test pass at bounds the shipped button never runs at.
const EMPTY_CONFIG = {} as unknown as Config;
const PROD_MAX_BUDGET_USD = topicGenerateMaxBudgetUsd(EMPTY_CONFIG);
const PROD_TIMEOUT_MS = topicGenerateTimeoutSec(EMPTY_CONFIG) * 1000;
/** Vitest per-test budget: must exceed the production timeout backstop, or the
 * runner would kill the case before the server's own timeout could act. */
const CASE_TIMEOUT_MS = 660_000;

// ── Fixture ─────────────────────────────────────────────────────────────────
//
// A long conversational session that exceeds ONE 45,000-char size-capped
// generation page, built from realistic prose rather than filler: five
// genuinely distinct discussion segments (so a working per-subject generate
// produces several topics), then a final segment about a fictional commission
// that supplies the paging canary.
//
// Every word carries its own INCREASING session_time (~0.45s/word), so the
// rendered page prefixes advance across the whole session — the pre-change
// fixture anchored every word at `00:00:01`, which made "later pages" and
// "earlier pages" indistinguishable in the rendering.

const SPEAKERS = ['A', 'B', 'C'] as const;
/** Seconds per spoken word, and the pause between utterances. */
const SEC_PER_WORD = 0.45;
const SEC_BETWEEN_UTTERANCES = 1.5;

const OPENERS = [
  'Right, so the thing I keep coming back to is',
  'Honestly,',
  'What surprised me was that',
  'To pick that thread up again,',
  'Here is where it gets interesting:',
  'I do want to flag that',
  'From where I was standing,',
  'The short version is that',
  'If I am being blunt about it,',
  'One more wrinkle:',
  'Worth saying out loud:',
  'Circling back for a second,',
  'And then of course',
];

const TAILS = [
  'and that shaped how we planned the rest of the week',
  'which is why the schedule slipped by about a day',
  'so we wrote it into the call sheet for everybody',
  'and nobody has argued with that decision since',
  'though I would happily be talked out of it',
  'and the budget absorbed it without much drama',
  'so that is the working assumption going forward',
  'which the whole crew felt by the second afternoon',
  'and it saved us a genuinely painful reshoot',
  'so we will do it exactly the same way next block',
  'and honestly that was the whole lesson of the shoot',
];

interface Segment {
  /** Diagnostic label only — never rendered into the transcript. */
  readonly label: string;
  readonly details: readonly string[];
  readonly utterances: number;
}

const SEGMENTS: readonly Segment[] = [
  {
    label: 'location scouting',
    utterances: 34,
    details: [
      'the warehouse down on the river had the north light we had been chasing for weeks',
      'the freight elevator was loud enough to ruin every quiet take on the upper floor',
      'parking for the grip truck turned out to be the deciding factor, not the room itself',
      'the owner wanted a permit letter before he would even let us walk the loading dock',
      'the tide noise under the pier bled into everything we tried to record outside',
      'we found a second stairwell that solved the whole camera move without renting a crane',
      'the brick wall opposite bounced enough light that we could drop two units entirely',
      'the neighbours run a bakery that starts at four in the morning with a very loud fan',
      'the floor had a slope we only noticed when the dolly kept drifting camera left',
      'the city closes that block for a market every Saturday, which kills a weekend day',
      'the ceiling height gave us room to fly a soft box without ever seeing it in frame',
      'the power on site was ancient and we would need a generator for anything serious',
      'the windows face a billboard that changes colour every thirty seconds after dark',
      'the space photographs much bigger than it feels when you are standing inside it',
      'the route from the street to the room involves three doorways and an awkward turn',
      'the landlord offered us a second week at half rate if we agreed to shoot in November',
    ],
  },
  {
    label: 'sound mix and dialogue cleanup',
    utterances: 34,
    details: [
      'the lavalier on the lead was rubbing against a wool coat for most of the second scene',
      'we ended up rebuilding the room tone from a thirty second wild track taken at lunch',
      'the refrigerator hum sat right under the dialogue at about a hundred and twenty hertz',
      'a broadband noise pass fixed the traffic but made the sibilance sound like plastic',
      'the boom operator caught a cleaner take than the radio mic on almost every setup',
      'we automated the music down four decibels under every line and it stopped fighting',
      'the additional dialogue session ran two hours and only three lines made the cut',
      'the phone call scene needed a filter that still let the words stay intelligible',
      'the footsteps were recorded on the wrong surface so foley replaced all of them',
      'the loudness target for the platform is minus sixteen and we were riding hot',
      'the stereo width on the crowd bed was so wide that it collapsed badly in mono',
      'a single door slam had to be pulled down because it was clipping the master bus',
      'the dialogue editor built a separate track per character just to keep the mix sane',
      'the wind sock did nothing on the roof and we lost the whole exterior conversation',
      'we kept a little of the original air in the mix so it would not sound sterile',
      'the print master has to go out as separate stems, not simply a stereo bounce',
    ],
  },
  {
    label: 'night exteriors',
    utterances: 34,
    details: [
      'the moonlight source was one big unit on a condor parked two blocks down the street',
      'the practicals in the shop windows carried more of the look than anything we brought',
      'we gelled the streetlights colder so that faces would read warmer by contrast',
      'the rain towers ate about an hour of the schedule every time we needed to reset',
      'the wet down made the asphalt bounce the signage back into the frame beautifully',
      'the camera was rated at eight hundred and we were still a stop and a half under',
      'a negative fill card on the off side kept the ambience from flattening the face',
      'the generator had to sit around the corner because its hum reached the microphone',
      'we lost the sky at about five and had to match everything to the first two takes',
      'the headlights of passing cars became an unplanned but very useful accent light',
      'the haze drifted with the wind so continuity between takes was a constant fight',
      'a small unit on the actor as she turned was the only thing holding her eyes alive',
      'the colour temperature of the sodium lamps was nowhere near what the meter promised',
      'we flagged the top of frame because the building above was catching too much spill',
      'the safety meeting for the wet work took twenty minutes and was completely worth it',
      'the last shot of the night went handheld because there was no time to lay track',
    ],
  },
  {
    label: 'editorial workflow',
    utterances: 34,
    details: [
      'the proxies transcoded overnight so the assistant could sync sound before breakfast',
      'we watched dailies as a group for the first three days and then quietly stopped',
      'the scene numbering in the continuity notes did not match the slates at all',
      'the first assembly ran two hours and eleven minutes, which nobody was happy about',
      'the cold open moved into the second act and suddenly the whole middle worked',
      'we kept a bin of alternate takes purely for moments where the reading was different',
      'the conform back to camera original found four shots in the wrong colour space',
      'the timeline was locked on a Friday and unlocked again the following Tuesday',
      'the temporary music was so good that the composer had to argue us out of loving it',
      'the assistant cut a string of every take with the dog and it was the best reel',
      'the versioning convention broke the moment two people exported on the same afternoon',
      'the review link expired mid note session, which was a very quiet kind of disaster',
      'the transitions we thought were clever in the edit felt showy on a big screen',
      'we trimmed nine minutes out of act two by cutting entrances and exits, nothing else',
      'the archive drive is duplicated in two buildings and checksummed once a month',
      'the subtitle pass caught three lines that were genuinely inaudible in the mix',
    ],
  },
  {
    label: 'festivals and distribution',
    utterances: 34,
    details: [
      'the submission deadline for the regional festival is six weeks before the screening',
      'the entry fee scales with running time, which nobody warns first timers about',
      'a premiere status clause means one festival can quietly disqualify you from another',
      'the deliverables list asked for a two hundred word synopsis and four production stills',
      'the programmer told us the first five minutes decide whether they watch the rest',
      'the caption file has to match the final cut frame for frame or the upload bounces',
      'we budgeted travel for exactly one festival and hoped it would be the right one',
      'the streaming aggregator takes a percentage plus an annual fee for every title',
      'a short film tends to screen for eighteen months before it goes online for free',
      'the poster art had to be redone at three aspect ratios for three different catalogues',
      'the jury feedback was contradictory in a way that was actually rather reassuring',
      'the audience award is voted on paper slips, which is charming and slightly chaotic',
      'the rights window for the online release starts after the last festival screening',
      'the press kit needs a director statement that does not sound like every other one',
      'we learned the hard way to ask about projection format before saying yes to a venue',
      'the regional grant requires proof of a screening within the calendar year of the award',
    ],
  },
];

/** The canary token. It is a COINED proper noun that appears NOWHERE in the
 * five segments above (asserted below, page by page): nothing on page 0 — or on
 * any page but the last — names it, hints at it, or makes it derivable, and it
 * is not a word a model could plausibly invent while summarising production
 * chatter. So a summary containing it is proof the run actually FETCHED the
 * final page, not proof of a good guess or an extrapolation from the
 * continuation marker (which does announce the total page count). */
const CANARY = 'Zarnovian';

const CANARY_SEGMENT: Segment = {
  label: 'the Zarnovian commission (canary — last page only)',
  utterances: 8,
  details: [
    'the Zarnovian Marsh Trust wants a three part series about the tidal flats by next spring',
    'nobody outside the Zarnovian district has filmed the pygmy otter colonies in twenty years',
    'the Zarnovian marshes flood twice a day, so every setup has a ninety minute window',
    'the Trust will fund a scout of the eastern Zarnovian flats in the first week of March',
    'the Zarnovian pygmy otter is nocturnal, so most of the series is infrared and long lens',
    'the local guides in Zarnovia refuse to take boats past the second channel after dusk',
    'the Zarnovian series would be our first commission where the client owns the footage',
    'the working title on the deck is simply Zarnovian Tides, which everybody seems to like',
    'the Zarnovian marsh mud eats tripods, so we would build floating platforms instead',
    'the Trust holds archival stills of the Zarnovian flats going back to the nineteen thirties',
    'a Zarnovian shoot means eleven weeks away, which is the real question for the crew',
    'the Zarnovian dialect has a word for the turning of the tide that the narration should use',
  ],
};

/** Two sentences of plausible conversation, composed so that consecutive
 * utterances in a segment differ (two independently-striding detail indices
 * over a shared opener/tail bank). */
function utterance(seg: Segment, i: number): string {
  const sentence = (k: number): string =>
    `${OPENERS[k % OPENERS.length]} ${seg.details[k % seg.details.length]}, and ` +
    `${seg.details[(k * 5 + 3) % seg.details.length]}, ${TAILS[k % TAILS.length]}.`;
  return `${sentence(i * 2)} ${sentence(i * 2 + 1)}`;
}

interface FixtureWord {
  word: string;
  speaker: string;
  session_time: string;
  start_sec: number;
  end_sec: number;
}

function hhmmss(totalSec: number): string {
  const s = Math.floor(totalSec);
  const p2 = (n: number): string => String(n).padStart(2, '0');
  return `${p2(Math.floor(s / 3600))}:${p2(Math.floor(s / 60) % 60)}:${p2(s % 60)}`;
}

function buildTranscript(): FixtureWord[] {
  const words: FixtureWord[] = [];
  let sec = 0;
  let utteranceIndex = 0;
  for (const seg of [...SEGMENTS, CANARY_SEGMENT]) {
    for (let i = 0; i < seg.utterances; i++) {
      const speaker = SPEAKERS[utteranceIndex % SPEAKERS.length];
      utteranceIndex++;
      for (const word of utterance(seg, i).split(/\s+/)) {
        words.push({
          word,
          speaker,
          session_time: hhmmss(sec),
          start_sec: sec,
          end_sec: sec + SEC_PER_WORD,
        });
        sec += SEC_PER_WORD;
      }
      sec += SEC_BETWEEN_UTTERANCES;
    }
  }
  return words;
}

const TRANSCRIPT = buildTranscript();

/** Every page the run's snapshot renders to, via the SAME pager (at its
 * production defaults) the turn's registration memoizes. */
function renderAllPages(): string[] {
  const first = renderGenerationTranscriptPage(TRANSCRIPT, 0);
  if (!first.ok) throw new Error(`fixture page 0 did not render: ${first.error}`);
  const pages = [first.text];
  for (let p = 1; p < first.totalPages; p++) {
    const res = renderGenerationTranscriptPage(TRANSCRIPT, p);
    if (!res.ok) throw new Error(`fixture page ${p} did not render: ${res.error}`);
    pages.push(res.text);
  }
  return pages;
}

describe.skipIf(!RUN)('REAL claude topic generation (opt-in: RUN_REAL_AI_TESTS=1)', () => {
  let dataDir: string;
  let registry: SessionHubRegistry;
  const sessionId = 'real-topic-gen';

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'real-topics-'));
    registry = new SessionHubRegistry(join(dataDir, 'sessions'));
    // One transaction for ~15k words (a per-word insert loop is the slow path).
    registry.get(sessionId).replaceTranscriptWords(TRANSCRIPT);
  }, 120_000);

  afterAll(async () => {
    // `driveAiTurn` starts the process-wide MCP listener singleton — close it
    // here (the event real test's convention) rather than leaking the port.
    await __resetAiMcpListenerForTests();
    registry?.closeAll();
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    rmSync(stableSessionCwd(sessionId), { recursive: true, force: true });
  });

  it(
    'creates real topics from a real MULTI-PAGE transcript, reaching the last page',
    async () => {
      const hub = registry.get(sessionId);
      expect(hub.listTranscriptWords().length).toBe(TRANSCRIPT.length);

      // Fixture self-checks — cheap, and they run BEFORE any spend, so a fixture
      // that stopped being multi-page (or leaked the canary early) fails loudly
      // instead of quietly turning this into a single-page test again.
      const pages = renderAllPages();
      console.log(
        `[real topic gen] fixture: ${TRANSCRIPT.length} words -> ${pages.length} pages ` +
          `(sizes ${pages.map((p) => p.length).join(', ')} chars)`,
      );
      expect(pages.length).toBeGreaterThanOrEqual(2); // the property under test
      for (const [i, text] of pages.entries()) {
        expect(text.length).toBeLessThanOrEqual(45_000);
        expect(
          text.includes(CANARY),
          `canary must appear ONLY on the last page (found on page ${i} of ${pages.length})`,
        ).toBe(i === pages.length - 1);
      }

      // The SHIPPED bounds, not test-local ones (see PROD_* above). Pinned so a
      // future default change cannot silently decouple this evidence from the
      // configuration operators run.
      expect(PROD_MAX_BUDGET_USD).toBe(topicGenerateMaxBudgetUsd(EMPTY_CONFIG));
      expect(PROD_TIMEOUT_MS).toBe(topicGenerateTimeoutSec(EMPTY_CONFIG) * 1000);
      expect(CASE_TIMEOUT_MS).toBeGreaterThan(PROD_TIMEOUT_MS);

      const startedAt = Date.now();
      const outcome = await generateTopicsTurn({
        registry,
        cliPath: cliPath as string,
        sessionId,
        maxBudgetUsd: PROD_MAX_BUDGET_USD,
        timeoutMs: PROD_TIMEOUT_MS,
      });
      const wallSec = ((Date.now() - startedAt) / 1000).toFixed(1);

      const topics = registry.get(sessionId).listTopics();
      // Surface what actually happened so a 0-topics or partial-paging run is
      // diagnosable — operator-facing output, deliberate in this gated real test.
      console.log(
        `[real topic gen] wall=${wallSec}s words=${TRANSCRIPT.length} ` +
          `pages=${outcome.pageCoverage.servedPages}/${outcome.pageCoverage.totalPages} ` +
          `budget=$${PROD_MAX_BUDGET_USD} timeout=${PROD_TIMEOUT_MS}ms ` +
          `outcome=${JSON.stringify(outcome)} topics=${topics.length}: ` +
          topics.map((t) => `[${t.session_time}] ${t.summary}`).join(' | '),
      );

      expect(outcome.ok).toBe(true);
      // The core assertion the fake fixtures cannot make: the real model
      // actually created topics (this fails on the list_topics-withheld
      // prompt-contradiction bug that produced "created 0 topics").
      expect(topics.length).toBeGreaterThanOrEqual(2);
      for (const t of topics) {
        expect(t.summary.trim().length).toBeGreaterThan(0);
      }

      // Paging behaviour (topic-generate-paged-transcript D6/D8), two ways:
      // mechanically — the server served every page of the run's snapshot; and
      // semantically — content that exists ONLY on the last page reached a topic
      // summary, so the model genuinely read to the end rather than fetching the
      // final page and ignoring it. Matched case-insensitively on the distinctive
      // token alone (never a whole phrase), since summaries are paraphrase.
      expect(outcome.pageCoverage.totalPages).toBe(pages.length);
      expect(outcome.pageCoverage.servedPages).toBe(outcome.pageCoverage.totalPages);
      const summaries = topics.map((t) => t.summary).join(' | ');
      expect(
        new RegExp(CANARY, 'i').test(summaries),
        `no topic summary mentions the last-page canary "${CANARY}": ${summaries}`,
      ).toBe(true);
    },
    CASE_TIMEOUT_MS,
  );
});
