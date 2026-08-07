// Spec-markdown parser (design.md D1/D6; spec "Requirement browser is parsed
// from spec markdown with a count gate"). Pure logic over an already-read
// markdown string — the live-repo wiring (reading
// openspec/specs/<capability>/spec.md via readFileSync) lives in
// scripts/check.ts, mirroring model/coverage.ts, model/edges.ts,
// model/relationships.ts, and model/capabilities.ts's pure-logic/live-wiring
// split (spec "Live-repo drift gates run at build and via docs:check").
//
// Parser scope (spec, verbatim): headings inside a "## Requirements"-style
// section; "### Requirement: <name>" and "#### Scenario: <name>" are the
// only classifiable forms; any other "###"/"####" heading inside a
// Requirements section fails the gate naming the capability. Direct heading
// count = literal grep-style count over the whole file, compared to parsed
// counts — this also transitively catches a requirement/scenario heading
// that exists OUTSIDE the located Requirements section (Purpose prose, or a
// section after Requirements): the parsed (section-scoped) count differs
// from the direct (whole-file) count, so a "count-mismatch" issue fires even
// though the offending heading itself was never inside the section to be
// individually classified.

export interface ParsedScenario {
  name: string;
  /** Raw markdown between this scenario's heading and the next heading, trimmed. */
  body: string;
}

export interface ParsedRequirement {
  name: string;
  /** Raw markdown between this requirement's heading and its first scenario (or the next heading), trimmed. */
  body: string;
  scenarios: ParsedScenario[];
}

export interface CapabilitySpecTree {
  capability: string;
  requirements: ParsedRequirement[];
}

export interface SpecParseIssue {
  kind: 'count-mismatch' | 'unclassified-heading' | 'missing-file';
  message: string;
}

export interface SpecParseResult {
  tree: CapabilitySpecTree;
  issues: SpecParseIssue[];
}

const REQUIREMENTS_SECTION_HEADING = '## Requirements';
const REQUIREMENT_PREFIX = '### Requirement: ';
const SCENARIO_PREFIX = '#### Scenario: ';

/** True for a level-2 ("## ") markdown heading. A level-3/4 heading never matches (its 3rd/4th char is "#", not whitespace). */
function isLevel2Heading(line: string): boolean {
  return /^##\s/.test(line);
}

/** True for a level-3 ("### ") heading. A level-4 heading never matches for the same reason as isLevel2Heading. */
function isLevel3Heading(line: string): boolean {
  return /^###\s/.test(line);
}

function isLevel4Heading(line: string): boolean {
  return /^####\s/.test(line);
}

/** Literal grep-style count of lines starting with `prefix`, over the whole file — the count-equality gate's other side. */
function countHeadingLines(markdown: string, prefix: string): number {
  return markdown.split('\n').filter((line) => line.startsWith(prefix)).length;
}

/** The lines of the first "## Requirements" section (exclusive of its own heading line, up to the next level-2 heading or EOF). Empty when no such section exists. */
function requirementsSectionLines(markdown: string): string[] {
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => line.trim() === REQUIREMENTS_SECTION_HEADING);
  if (start === -1) return [];
  const section: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (isLevel2Heading(line)) break;
    section.push(line);
  }
  return section;
}

function unclassifiedHeadingIssue(capability: string, line: string): SpecParseIssue {
  return {
    kind: 'unclassified-heading',
    message:
      `Capability "${capability}": heading "${line.trim()}" inside the Requirements section ` +
      'is neither "### Requirement: " nor "#### Scenario: " — the parser cannot classify it.',
  };
}

/**
 * Parses one capability's spec.md into a capability -> requirements ->
 * scenarios tree, plus any gate issues. Never throws on malformed input —
 * malformed headings become issues, not exceptions, so a single bad file
 * doesn't crash the whole docs:check run before every violation is
 * collected.
 */
export function parseCapabilitySpec(capability: string, markdown: string): SpecParseResult {
  const issues: SpecParseIssue[] = [];
  const requirements: ParsedRequirement[] = [];

  let currentRequirement: ParsedRequirement | undefined;
  let currentScenario: ParsedScenario | undefined;
  let bodyBuffer: string[] = [];
  let parsedRequirementCount = 0;
  let parsedScenarioCount = 0;

  const flushBody = () => {
    const text = bodyBuffer.join('\n').trim();
    if (currentScenario) currentScenario.body = text;
    else if (currentRequirement) currentRequirement.body = text;
    bodyBuffer = [];
  };

  for (const line of requirementsSectionLines(markdown)) {
    if (isLevel3Heading(line)) {
      flushBody();
      currentScenario = undefined;
      if (line.startsWith(REQUIREMENT_PREFIX)) {
        currentRequirement = {
          name: line.slice(REQUIREMENT_PREFIX.length).trim(),
          body: '',
          scenarios: [],
        };
        requirements.push(currentRequirement);
        parsedRequirementCount++;
      } else {
        currentRequirement = undefined;
        issues.push(unclassifiedHeadingIssue(capability, line));
      }
    } else if (isLevel4Heading(line)) {
      flushBody();
      if (line.startsWith(SCENARIO_PREFIX)) {
        const scenario: ParsedScenario = {
          name: line.slice(SCENARIO_PREFIX.length).trim(),
          body: '',
        };
        currentScenario = scenario;
        parsedScenarioCount++;
        // A scenario heading with no enclosing requirement is counted for
        // the count-equality gate below but has nowhere to nest in the
        // tree — never observed across the repo's 17 spec files (every
        // scenario is nested under a requirement by convention), but
        // handled without crashing rather than assumed away.
        currentRequirement?.scenarios.push(scenario);
      } else {
        currentScenario = undefined;
        issues.push(unclassifiedHeadingIssue(capability, line));
      }
    } else {
      bodyBuffer.push(line);
    }
  }
  flushBody();

  const directRequirementCount = countHeadingLines(markdown, REQUIREMENT_PREFIX);
  const directScenarioCount = countHeadingLines(markdown, SCENARIO_PREFIX);
  if (
    parsedRequirementCount !== directRequirementCount ||
    parsedScenarioCount !== directScenarioCount
  ) {
    issues.push({
      kind: 'count-mismatch',
      message:
        `Capability "${capability}": parsed ${parsedRequirementCount} requirement(s) / ` +
        `${parsedScenarioCount} scenario(s) from the "## Requirements" section, but the file ` +
        `contains ${directRequirementCount} requirement(s) / ${directScenarioCount} scenario(s) ` +
        'heading(s) in total. A requirement/scenario heading exists outside the located ' +
        'Requirements section (or the section heading itself is missing/misspelled).',
    });
  }

  return { tree: { capability, requirements }, issues };
}

/**
 * Parses every given capability's spec.md (via an injected reader), sorted
 * by capability name. A capability whose file cannot be read produces a
 * "missing-file" issue rather than throwing.
 */
export function parseAllSpecs(
  baselineCapabilities: string[],
  readSpecFile: (capability: string) => string | undefined,
): { trees: CapabilitySpecTree[]; issues: SpecParseIssue[] } {
  const trees: CapabilitySpecTree[] = [];
  const issues: SpecParseIssue[] = [];

  for (const capability of [...baselineCapabilities].sort()) {
    const markdown = readSpecFile(capability);
    if (markdown === undefined) {
      issues.push({
        kind: 'missing-file',
        message: `Capability "${capability}": openspec/specs/${capability}/spec.md could not be read.`,
      });
      continue;
    }
    const result = parseCapabilitySpec(capability, markdown);
    trees.push(result.tree);
    issues.push(...result.issues);
  }

  return { trees, issues };
}
