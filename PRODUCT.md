# Product

## Register

product

## Platform

web

## Users

Live production operators — loggers working a session in real time, often in a studio or
broadcast/production environment under time pressure and dim ambient light. The same people (or
their teammates) return afterward to review what happened: transcripts, topics, exports, and now
AI-designed dashboards. Live-first calibrates the console surfaces; the review surfaces (AI tab,
dashboards) serve the after-the-fact analysis side of the same audience. Register is split in
practice: the authenticated app is the primary product surface, with brand register applied
per-task when working on marketing-facing surfaces such as the login page or a future landing page.

## Product Purpose

AutoLogger is a portable session-logging backend and workspace: operators log events against
running timecode during a live session, record audio, and generate transcripts and topics from it.
Success looks like a session that was effortless to log while it happened and is fully legible
afterward — every event, word, and theme findable and visualizable without re-listening to the
recording.

## Positioning

Every session becomes a searchable, visual record — transcripts, topics, dashboards.

## Brand Personality

Precise, calm, technical. Broadcast-console confidence: dense where density serves the operator,
exact about time and state, quiet everywhere else. The existing V5 visual system (dark glass
panels on near-black, sky-cyan accents, Inter/Poppins) is the committed expression of this
personality — extend it, don't reinvent it.

## Anti-references

- Consumer-cute AI chat: no bubbly gradients, sparkle iconography, or mascot energy around the AI
  features. The AI surfaces are instruments, not companions.
- Terminal/hacker aesthetic: no green-on-black monospace-everything or fake-CRT styling. Mono is
  for timecode and data values, not a theme.

## Design Principles

- **The tool disappears into the task.** Live surfaces optimize for zero-hesitation logging;
  review surfaces optimize for orientation at a glance. Nothing decorates.
- **Exact about time and state.** Timecode, transport state, and recording status are always
  truthful and legible; motion conveys state, never flourish.
- **Absence is information.** When data is missing (no word timings, no speaker names), the UI
  says so and names the reason — zeros or blanks are never presented as data.
- **One vocabulary everywhere.** New surfaces (AI dashboards included) reuse the established
  panel, tab, button, and token vocabulary rather than inventing parallel ones.
- **Legibility over spectacle.** Dark-room contrast discipline: body text and data labels hit AA
  contrast on the glass surfaces they sit on.

## Accessibility & Inclusion

WCAG AA: ≥4.5:1 body-text contrast (≥3:1 large text) on the actual rendered surfaces, color never
the only channel in charts or state indicators, `prefers-reduced-motion` alternatives for every
animation, and keyboard-operable equivalents for direct-manipulation interactions (dashboard
editing included).
