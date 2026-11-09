# Spec Delta

## ADDED Requirements

### Requirement: Settings runs batch autogenerate for owners and admins
The Settings view SHALL have a **Batch autogenerate** section in the Team group, listed only when
the user is an owner or admin of at least one team. It SHALL offer:
- a **team picker** listing the teams the user owns or administers, defaulting to the active team
  when the user manages it;
- a **show checklist** of that team's shows, all ticked by default, with select-all;
- **step checkboxes** for Transcripts, Log events, Topics and Wiki, all ticked by default, shown in
  run order;
- a **wiki mode** choice, "Add new pages and additions to the wiki" (default) or "Leave all as
  suggestions to review",
  enabled only while Wiki is ticked;
- a **live estimate** from the preview route: the number of sessions, each step's missing count,
  and `sessions × steps`; when the preview reports a `blocked` reason the section says what to do
  (add a provider in Settings → Advanced, or ask for approval) and Start is disabled;
- **Start**, which opens a themed confirm naming the sessions, the maximum runs, that the work runs
  on the user's own provider accounts, and, in "Add to wiki pages" mode, that AI-written new pages
  and additions will be added to wiki pages without review while rewrites that remove or change
  text stay as suggestions to review; confirming sends the start with the estimate's session
  count, and a `409` "sessions changed" refreshes the estimate and asks again.

While the team has a `queued` or `running` job the section SHALL show it instead of Start: its
initiator, progress (`counts` against the item total), the current session and step, and a
**Cancel** button behind a themed confirm, refreshed every 5 seconds while the section is open.
After a job ends the section SHALL show its report: status, stop reason in words, and the failed
and skipped items grouped by session with their fixed details. A **Recent jobs** list SHALL show
the team's last 20 jobs, each opening its report. The section SHALL fetch nothing while Settings is
closed or another section is shown.

#### Scenario: A member does not see the section
- **WHEN** a user who is only a plain member of every team opens Settings
- **THEN** the Team group lists no Batch autogenerate section

#### Scenario: Confirm before start
- **WHEN** an admin with 40 sessions selected and all four steps ticked presses Start
- **THEN** a themed confirm names 40 sessions and at most 160 runs and warns that AI-written new
  pages and additions will be added to wiki pages without review, and no job is created until it
  is confirmed

#### Scenario: Another admin's running job
- **WHEN** an admin opens the section while a job another admin started is running
- **THEN** the section shows that job's progress with its initiator's name and a Cancel button, and
  Start is not offered
