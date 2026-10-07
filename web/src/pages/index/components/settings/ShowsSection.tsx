import { useQueryClient } from '@tanstack/react-query';
import { PlusIcon, TvIcon } from 'lucide-react';
import { Fragment, useRef, useState } from 'react';
import { useCreateShow, useProfile, useProfileMutation } from '../../../../api/hooks/useProfile';
import { showAccessFrom } from '../../../../api/hooks/useShowAccess';
import { useSetShowGrant, useTeam } from '../../../../api/hooks/useTeams';
import type { ProfilePayload, Show, TeamMember, TeamRole } from '../../../../api/types';
import { Avatar, AvatarFallback } from '../../../../shared/components/ui/avatar';
import { Badge } from '../../../../shared/components/ui/badge';
import { Button } from '../../../../shared/components/ui/button';
import { Card, CardContent } from '../../../../shared/components/ui/card';
import { Checkbox } from '../../../../shared/components/ui/checkbox';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '../../../../shared/components/ui/empty';
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from '../../../../shared/components/ui/field';
import { Input } from '../../../../shared/components/ui/input';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemSeparator,
  ItemTitle,
} from '../../../../shared/components/ui/item';
import { Spinner } from '../../../../shared/components/ui/spinner';
import type { SettingsSectionProps } from './SettingsView';
import { runSaveSteps, type SaveStep, SidePanel } from './SidePanel';
import {
  activeShowIdForSave,
  invalidateAfterProfileSave,
  profileStudioId,
  type ShowDraft,
  SUFFIX_LABEL,
  showDraftToUpdate,
  showInitials,
  showToShowDraft,
} from './settingsModel';
import {
  RoleLockNotice,
  SettingRow,
  SettingsSectionHeader,
  ShowsNotReady,
  SuffixToggle,
} from './settingsParts';
import { type SettingsShowsScope, useSettingsShows } from './settingsScopes';
import { isManager, memberLabel } from './teamRules';

// --- Settings › Shows (redesign-show-ignition 8.2; design D4, D10) ---
//
// The active team's shows as `Item` rows (name, code and suffix, Edit), and Add show
// (team-management "Teams management page", Shows). Owners and admins edit; a member sees Edit
// and Add show disabled under a notice naming their role ("Member content access"). There is no
// delete control: deleting a show is out of scope.
//
// The show panel (`SidePanel`) holds the name, code, Suffix (after the code; session-title-suffix)
// and who can open it: a checkbox per `member` row, checked from their grants. Owners and admins
// reach every show by role, so they are not listed. Save runs, in order and stopping at the first
// failure (design D4):
//   - edit: the show's fields through `show_updates` (the whole show from the view's saved
//     baseline, so its buttons and palette go back unchanged), then a grant PUT or DELETE per
//     changed member;
//   - add: `POST /api/shows`, then `show_updates` only when the suffix is not the server's default
//     (Date), then the grants. A created show is remembered, so a retry never creates it twice.
// Every profile write carries the active team and echoes the active show (web-ui-system "Honest
// save model in Settings"). Each step is computed against the saved state as last known, so a
// retry sends only what did not apply.

interface ShowPanelDraft {
  name: string;
  show_code: string;
  title_suffix: 'date' | 'episode';
  /** The `member` rows granted this show, sorted. */
  access: string[];
}

export function ShowsSection(_props: SettingsSectionProps) {
  const { data: profile } = useProfile();
  const scope = useSettingsShows();
  const studioId = profileStudioId(profile);
  if (!profile || !studioId) {
    return (
      <>
        <SettingsSectionHeader title="Shows" description="You’re not on a team yet." />
        <Empty>
          <EmptyDescription>Join or create a team to set up its shows.</EmptyDescription>
        </Empty>
      </>
    );
  }
  return <Shows profile={profile} scope={scope} />;
}

function Shows({ profile, scope }: { profile: ProfilePayload; scope: SettingsShowsScope }) {
  const studioId = scope.studioId;
  const role: TeamRole = showAccessFrom(profile).teamRole(studioId) ?? 'member';
  const manager = isManager(role);
  const teamName = profile.studios.find((s) => s.id === studioId)?.name ?? studioId;
  // Only owners and admins read anyone's grants; a member's view fetches no team detail.
  const team = useTeam(manager ? studioId : '');
  const members = (team.data?.members ?? []).filter((m) => m.role === 'member');
  const shows = scope.shows.filter((s) => s.studio_id === studioId);
  // `null` id: the Add show panel. Each open is a fresh mount (`n`); closing keeps it mounted so
  // the sheet animates out and hands focus back.
  const [panel, setPanel] = useState<{ id: string | null; open: boolean; n: number } | null>(null);
  const openPanel = (id: string | null) =>
    setPanel((p) => ({ id, open: true, n: (p?.n ?? 0) + 1 }));

  const count = `${shows.length} show${shows.length === 1 ? '' : 's'}`;
  const header = (
    <SettingsSectionHeader
      title="Shows"
      description={scope.ready ? `${teamName} · ${count}` : teamName}
    />
  );

  return (
    <>
      {header}
      {!manager && <RoleLockNotice role={role} teamName={teamName} />}
      {!scope.ready ? (
        <ShowsNotReady unavailable={scope.unavailable} onRetry={scope.retry} />
      ) : (
        <Card className="py-2">
          <CardContent className="px-2">
            {shows.length === 0 ? (
              <Empty>
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <TvIcon aria-hidden="true" />
                  </EmptyMedia>
                  <EmptyTitle>No shows yet</EmptyTitle>
                  <EmptyDescription>
                    Shows group sessions. Add one to start logging.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <ItemGroup aria-label={`${teamName} shows`}>
                {shows.map((show, i) => (
                  <Fragment key={show.id}>
                    {i > 0 && <ItemSeparator />}
                    <ShowRow
                      show={show}
                      saved={scope.baseline[show.id]}
                      current={show.id === scope.activeShowId}
                      grantedCount={
                        team.data
                          ? members.filter((m) => m.show_ids?.includes(show.id)).length
                          : null
                      }
                      memberCount={members.length}
                      canEdit={manager}
                      onEdit={() => openPanel(show.id)}
                    />
                  </Fragment>
                ))}
              </ItemGroup>
            )}
          </CardContent>
        </Card>
      )}
      <Card>
        <CardContent>
          <SettingRow
            label="Add a show"
            description="Shows group sessions. Members only see the shows you let them open."
            disabled={!manager}
          >
            <Button
              variant="outline"
              disabled={!manager || !scope.ready}
              onClick={() => openPanel(null)}
            >
              <PlusIcon data-icon="inline-start" aria-hidden="true" />
              Add show
            </Button>
          </SettingRow>
        </CardContent>
      </Card>

      {manager && panel && (
        <ShowPanel
          key={panel.n}
          open={panel.open}
          showId={panel.id}
          profile={profile}
          scope={scope}
          teamName={teamName}
          members={members}
          membersLoaded={Boolean(team.data)}
          onClose={() => setPanel((p) => (p ? { ...p, open: false } : p))}
        />
      )}
    </>
  );
}

function ShowRow({
  show,
  saved,
  current,
  grantedCount,
  memberCount,
  canEdit,
  onEdit,
}: {
  show: Show;
  saved: ShowDraft | undefined;
  current: boolean;
  grantedCount: number | null;
  memberCount: number;
  canEdit: boolean;
  onEdit: () => void;
}) {
  const name = saved?.name ?? show.name;
  const code = saved?.show_code ?? show.show_code;
  const suffix = saved?.title_suffix ?? show.title_suffix;
  return (
    <Item role="listitem" size="sm" data-testid={`show-row-${show.id}`} className="flex-nowrap">
      <ItemContent className="min-w-0">
        <ItemTitle className="max-w-full min-w-0">
          <span className="min-w-0 truncate">{name || 'Untitled show'}</span>
          {current && <Badge variant="secondary">Current show</Badge>}
        </ItemTitle>
        <ItemDescription className="truncate">
          {`${code || 'No code'} · ${SUFFIX_LABEL[suffix === 'episode' ? 'episode' : 'date']} suffix`}
        </ItemDescription>
      </ItemContent>
      <ItemActions className="shrink-0">
        {grantedCount !== null && memberCount > 0 && (
          <span className="text-right text-sm text-muted-foreground max-sm:hidden">
            {`${grantedCount} of ${memberCount} member${memberCount === 1 ? '' : 's'}`}
          </span>
        )}
        <Button
          variant="ghost"
          size="sm"
          disabled={!canEdit}
          aria-label={`Edit ${name || 'Untitled show'}`}
          onClick={onEdit}
        >
          Edit
        </Button>
      </ItemActions>
    </Item>
  );
}

const accessOf = (members: TeamMember[], showId: string | null) =>
  showId
    ? members
        .filter((m) => m.show_ids?.includes(showId))
        .map((m) => m.id)
        .sort()
    : [];

function ShowPanel({
  open,
  showId,
  profile,
  scope,
  teamName,
  members,
  membersLoaded,
  onClose,
}: {
  open: boolean;
  /** `null` for Add show. */
  showId: string | null;
  profile: ProfilePayload;
  scope: SettingsShowsScope;
  teamName: string;
  members: TeamMember[];
  membersLoaded: boolean;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const profileWrite = useProfileMutation();
  const createShow = useCreateShow();
  const setGrant = useSetShowGrant(scope.studioId);
  const isNew = showId === null;
  // Add show: the show once created, so a retry after a later step failed never creates twice.
  const created = useRef<{ id: string; draft: ShowDraft } | null>(null);

  const savedShow = showId ? scope.baseline[showId] : undefined;
  const fieldsOf = (d: ShowDraft | undefined) => ({
    name: d?.name ?? '',
    show_code: d?.show_code ?? '',
    title_suffix: d?.title_suffix ?? ('date' as const),
  });
  // The saved state as last known: an edit's from the view's baseline and the fetched grants.
  const baseline: ShowPanelDraft = {
    ...fieldsOf(savedShow),
    access: accessOf(members, showId),
  };
  const [draft, setDraft] = useState<ShowPanelDraft>(baseline);
  // The grants arrive with the team detail, possibly after the panel opened.
  const [seeded, setSeeded] = useState(membersLoaded || isNew);
  if (!seeded && membersLoaded) {
    setSeeded(true);
    setDraft((d) => ({ ...d, access: accessOf(members, showId) }));
  }

  const update = (patch: Partial<ShowPanelDraft>) => setDraft((d) => ({ ...d, ...patch }));

  function grantSteps(targetShowId: string, before: string[]): SaveStep[] {
    const was = new Set(before);
    const now = new Set(draft.access);
    const steps: SaveStep[] = [];
    for (const m of members) {
      const granted = now.has(m.id);
      if (granted === was.has(m.id)) continue;
      const who = memberLabel(m);
      steps.push({
        label: granted ? `give ${who} access` : `remove ${who}’s access`,
        run: () => setGrant.mutateAsync({ showId: targetShowId, userId: m.id, granted }),
      });
    }
    return steps;
  }

  function showUpdateStep(id: string, saved: ShowDraft, label: string): SaveStep {
    const merged: ShowDraft = {
      ...saved,
      name: draft.name.trim(),
      show_code: draft.show_code.trim(),
      title_suffix: draft.title_suffix,
    };
    return {
      label,
      run: async () => {
        await profileWrite.mutateAsync({
          active_studio_id: scope.studioId,
          active_show_id: activeShowIdForSave(profile, scope.studioId, {
            ready: scope.ready,
            selectedShowId: scope.activeShowId,
          }),
          show_updates: [showDraftToUpdate(id, merged)],
        });
        scope.commitShow(id, merged);
        if (created.current?.id === id) created.current = { id, draft: merged };
        invalidateAfterProfileSave(queryClient, { showUpdates: true });
      },
    };
  }

  async function save() {
    const steps: SaveStep[] = [];
    if (!isNew && showId && savedShow) {
      const before = fieldsOf(savedShow);
      const after = {
        name: draft.name.trim(),
        show_code: draft.show_code.trim(),
        title_suffix: draft.title_suffix,
      };
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        steps.push(showUpdateStep(showId, savedShow, 'save the show'));
      }
      steps.push(...grantSteps(showId, baseline.access));
      await runSaveSteps(steps);
      return;
    }

    // Add show.
    if (!created.current) {
      await runSaveSteps([
        {
          label: 'create the show',
          run: async () => {
            const code = draft.show_code.trim();
            const { show } = await createShow.mutateAsync({
              studio_id: scope.studioId,
              name: draft.name.trim(),
              ...(code ? { show_code: code } : {}),
            });
            const fresh = showToShowDraft(show);
            created.current = { id: show.id, draft: fresh };
            scope.commitShow(show.id, fresh);
          },
        },
      ]);
    }
    const made = created.current;
    if (!made) return;
    if (made.draft.title_suffix !== draft.title_suffix) {
      steps.push(showUpdateStep(made.id, made.draft, 'set the show’s suffix'));
    }
    steps.push(...grantSteps(made.id, accessOf(members, made.id)));
    await runSaveSteps(steps);
  }

  const title = isNew ? 'New show' : 'Edit show';
  const initials = showInitials(draft.name);

  return (
    <SidePanel
      open={open}
      onClose={onClose}
      title={title}
      description={teamName}
      media={
        <Avatar size="lg">
          <AvatarFallback>{initials || <PlusIcon aria-hidden="true" />}</AvatarFallback>
        </Avatar>
      }
      value={draft}
      baseline={isNew ? { name: '', show_code: '', title_suffix: 'date', access: [] } : baseline}
      valid={draft.name.trim() !== ''}
      onSave={save}
      saveLabel={isNew ? 'Add show' : 'Save'}
    >
      <FieldSet>
        <FieldLegend>Show</FieldLegend>
        <FieldGroup className="gap-4">
          <Field>
            <FieldLabel htmlFor="show-panel-name">Show name</FieldLabel>
            <Input
              id="show-panel-name"
              type="text"
              maxLength={200}
              autoComplete="off"
              placeholder="e.g. Morning Desk"
              value={draft.name}
              onChange={(e) => update({ name: e.target.value })}
            />
            <FieldDescription>Appears in the top bar and on every session.</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="show-panel-code">Code</FieldLabel>
            <Input
              id="show-panel-code"
              type="text"
              maxLength={40}
              autoComplete="off"
              spellCheck={false}
              className="font-mono"
              placeholder={initials || 'e.g. MD'}
              value={draft.show_code}
              onChange={(e) => update({ show_code: e.target.value.toUpperCase() })}
            />
            <FieldDescription>
              {isNew
                ? 'Starts the name of every untitled session. Left empty, the name’s initials are used.'
                : 'Starts the name of every untitled session in this show.'}
            </FieldDescription>
          </Field>
          <Field>
            <FieldLabel id="show-panel-suffix-label">Suffix</FieldLabel>
            <SuffixToggle
              labelledBy="show-panel-suffix-label"
              value={draft.title_suffix}
              onChange={(title_suffix) => update({ title_suffix })}
            />
            <FieldDescription>
              How an untitled session’s name ends: the date, or an episode number.
            </FieldDescription>
          </Field>
        </FieldGroup>
      </FieldSet>

      <FieldSet>
        <FieldLegend>Who can open it</FieldLegend>
        {!membersLoaded ? (
          <FieldDescription className="flex items-center gap-2">
            <Spinner aria-hidden="true" />
            Loading members…
          </FieldDescription>
        ) : members.length === 0 ? (
          <FieldDescription>
            No members on this team yet. Owners and admins can always open every show.
          </FieldDescription>
        ) : (
          <FieldGroup data-slot="checkbox-group" className="gap-3">
            {members.map((m) => {
              const id = `show-access-${m.id}`;
              return (
                <Field key={m.id} orientation="horizontal">
                  <Checkbox
                    id={id}
                    checked={draft.access.includes(m.id)}
                    onCheckedChange={(next) => {
                      const ids = new Set(draft.access);
                      if (next === true) ids.add(m.id);
                      else ids.delete(m.id);
                      update({ access: [...ids].sort() });
                    }}
                  />
                  <FieldContent className="min-w-0">
                    <FieldLabel htmlFor={id} className="font-normal">
                      {memberLabel(m)}
                    </FieldLabel>
                    <FieldDescription className="truncate">{m.email}</FieldDescription>
                  </FieldContent>
                </Field>
              );
            })}
          </FieldGroup>
        )}
        {membersLoaded && members.length > 0 && (
          <FieldDescription>Owners and admins can always open every show.</FieldDescription>
        )}
      </FieldSet>
    </SidePanel>
  );
}
