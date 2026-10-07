import { LockIcon, TriangleAlertIcon, WifiOffIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import type { TeamRole } from '../../../../api/types';
import { Alert, AlertDescription } from '../../../../shared/components/ui/alert';
import { Button } from '../../../../shared/components/ui/button';
import { CardFooter } from '../../../../shared/components/ui/card';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '../../../../shared/components/ui/empty';
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldTitle,
} from '../../../../shared/components/ui/field';
import { Spinner } from '../../../../shared/components/ui/spinner';
import { ToggleGroup, ToggleGroupItem } from '../../../../shared/components/ui/toggle-group';
import { SHOWS_STATE_COPY, SUFFIX_LABEL } from './settingsModel';

// --- Shared pieces of the Settings view's sections (redesign-show-ignition D10) ---
//
// The page head, the labelled setting row (label and help on the left, control on the right),
// the section save bar, the role lock notice and the shows-unavailable states. Composed from the
// shadcn primitives; className is layout only.

export function SettingsSectionHeader({
  title,
  description,
}: {
  title: string;
  description?: ReactNode;
}) {
  return (
    <header className="flex flex-col gap-1.5">
      <h3 className="m-0 font-ui text-2xl leading-tight font-semibold">{title}</h3>
      {description && <p className="m-0 text-sm text-muted-foreground">{description}</p>}
    </header>
  );
}

/**
 * One setting: label and help on the left, the control on the right; stacked on narrow screens.
 * `htmlFor` labels a form control; without it the label is a plain title (for a button or text).
 */
export function SettingRow({
  label,
  htmlFor,
  labelId,
  description,
  disabled,
  row,
  children,
}: {
  label: ReactNode;
  htmlFor?: string;
  /** Names the row (`data-row`) where a list mixes setting rows with item rows. */
  row?: string;
  /** For a control labelled by `aria-labelledby` (a toggle group) rather than `htmlFor`. */
  labelId?: string;
  description?: ReactNode;
  disabled?: boolean;
  children?: ReactNode;
}) {
  return (
    <Field
      orientation="horizontal"
      data-disabled={disabled || undefined}
      data-row={row}
      className="justify-between gap-4 max-sm:flex-col max-sm:items-stretch"
    >
      <FieldContent className="min-w-0">
        {htmlFor ? (
          // The row's title type for every row, labelling its control with a plain <label>
          // (the shared FieldLabel is the small muted form-label style, not a row title).
          <FieldTitle>
            <label htmlFor={htmlFor}>{label}</label>
          </FieldTitle>
        ) : (
          <FieldTitle id={labelId}>{label}</FieldTitle>
        )}
        {description && <FieldDescription>{description}</FieldDescription>}
      </FieldContent>
      {children !== undefined && (
        <div className="flex min-w-0 shrink-0 items-center justify-end gap-2 sm:w-[260px] max-sm:w-full max-sm:justify-start">
          {children}
        </div>
      )}
    </Field>
  );
}

/**
 * The inline section's save bar (web-ui-system "Honest save model in Settings"): Save is disabled
 * and reads "Saved" with nothing to save, "Save" with an edit, and shows a spinner while saving.
 * A failed save names what did not apply.
 */
export function SectionSaveBar({
  dirty,
  saving,
  valid = true,
  error,
  onSave,
}: {
  dirty: boolean;
  saving: boolean;
  valid?: boolean;
  error?: string | null;
  onSave: () => void;
}) {
  return (
    <CardFooter
      data-slot="settings-save-bar"
      className="sticky bottom-0 flex-col items-stretch gap-3 border-t border-(--si-line) bg-card pt-4"
    >
      {error && (
        <Alert variant="destructive">
          <TriangleAlertIcon aria-hidden="true" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <div className="flex items-center justify-end gap-3">
        <span className="text-sm text-muted-foreground" aria-live="polite">
          {saving ? '' : dirty ? 'Unsaved changes' : ''}
        </span>
        <Button disabled={!dirty || !valid || saving} onClick={onSave}>
          {saving && <Spinner data-icon="inline-start" aria-hidden="true" />}
          {saving ? 'Saving…' : dirty ? 'Save' : 'Saved'}
        </Button>
      </div>
    </CardFooter>
  );
}

const ROLE_PHRASE: Record<TeamRole, string> = {
  owner: 'the owner',
  admin: 'an admin',
  member: 'a member',
};

/** "You’re the owner" etc., for a section's scope line. */
export const YOU_ARE: Record<TeamRole, string> = {
  owner: 'You’re the owner',
  admin: 'You’re an admin',
  member: 'You’re a member',
};

/** A team with no owner (team-management "Orphaned team is visible as such"). */
export function OrphanedNotice() {
  return (
    // A polite status, not an alarm (shadcn-port-shell D5; Alert defaults to role="alert").
    <Alert role="status" data-testid="team-orphaned-notice">
      This team has no owner. Contact support.
    </Alert>
  );
}

/** Disabled controls are explained, not hidden (team-management "Teams management page"). */
export function RoleLockNotice({
  role,
  teamName,
  children,
}: {
  role: TeamRole;
  teamName: string;
  children?: ReactNode;
}) {
  return (
    <Alert role="status" data-slot="settings-role-notice">
      <LockIcon aria-hidden="true" />
      <AlertDescription>
        {children ??
          `You’re ${ROLE_PHRASE[role]} of ${teamName}. Only owners and admins can change these.`}
      </AlertDescription>
    </Alert>
  );
}

/**
 * The show-backed sections' three not-ready states (web-ui-system "The Settings shows section says
 * why it has nothing to show"). Retry only on the error: on the offline hold it would be a dead
 * control (a paused query resumes on reconnect by itself), so that state says so instead.
 */
export function ShowsNotReady({
  unavailable,
  onRetry,
}: {
  unavailable: 'error' | 'offline' | null;
  onRetry: () => void;
}) {
  if (unavailable === 'error') {
    return (
      <Empty data-slot="settings-shows-state" data-state="error">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <TriangleAlertIcon aria-hidden="true" />
          </EmptyMedia>
          <EmptyTitle>{SHOWS_STATE_COPY.error}</EmptyTitle>
        </EmptyHeader>
        <EmptyContent>
          <Button variant="outline" onClick={onRetry}>
            Retry
          </Button>
        </EmptyContent>
      </Empty>
    );
  }
  if (unavailable === 'offline') {
    return (
      <Empty data-slot="settings-shows-state" data-state="offline">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <WifiOffIcon aria-hidden="true" />
          </EmptyMedia>
          <EmptyTitle>{SHOWS_STATE_COPY.offline}</EmptyTitle>
          <EmptyDescription>{SHOWS_STATE_COPY.offlineRecovery}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <Empty data-slot="settings-shows-state" data-state="loading" aria-busy="true">
      <EmptyHeader>
        <EmptyMedia>
          <Spinner aria-hidden="true" />
        </EmptyMedia>
        <EmptyDescription>{SHOWS_STATE_COPY.loading}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

/**
 * The show's title Suffix (session-title-suffix): Date or Episode Number, always one of the two.
 * Shared by Show details and the show panel.
 */
export function SuffixToggle({
  labelledBy,
  value,
  disabled,
  onChange,
}: {
  labelledBy: string;
  value: 'date' | 'episode';
  disabled?: boolean;
  onChange: (value: 'date' | 'episode') => void;
}) {
  return (
    <ToggleGroup
      type="single"
      variant="outline"
      aria-labelledby={labelledBy}
      disabled={disabled}
      value={value}
      onValueChange={(v) => {
        // A single toggle group deselects on a second click; a suffix is always set.
        if (v === 'date' || v === 'episode') onChange(v);
      }}
    >
      <ToggleGroupItem value="date">{SUFFIX_LABEL.date}</ToggleGroupItem>
      <ToggleGroupItem value="episode">{SUFFIX_LABEL.episode}</ToggleGroupItem>
    </ToggleGroup>
  );
}
