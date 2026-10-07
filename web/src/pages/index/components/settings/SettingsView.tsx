import { ChevronLeftIcon } from 'lucide-react';
import { Fragment, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useProfile } from '../../../../api/hooks/useProfile';
import { Button } from '../../../../shared/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../../../shared/components/ui/tabs';
import { cn } from '../../../../shared/lib/utils';
import { useConfirm } from '../../../../shared/ui/ConfirmDialog';
import { isOverlayOpen } from '../../../../shared/ui/overlayOpen';
import { SETTINGS_SECTION_CONTENT } from './SettingsSections';
import {
  SETTINGS_SECTION_GROUPS,
  SETTINGS_SECTIONS,
  SETTINGS_VIEW_SELECTOR,
  type SettingsSectionId,
  settingsPanelId,
  settingsTabId,
} from './sections';
import {
  type SectionGuardState,
  SettingsGuardContext,
  type SettingsGuardRegistry,
} from './settingsGuard';
import { SettingsShowsContext, useSettingsShowsScopeState } from './settingsScopes';

// --- SettingsView (redesign-show-ignition D3, D10; task 6.1) ---
//
// Settings is a view over the console, not a route: AppShell mounts it inside <main>, below the
// top bar and beside the rail, only while its `settings` state is non-null (web-ui-system "The
// Settings modal costs nothing while closed"), behind the one overlay `LazyChunk`. Because it is
// in the page rather than a full-viewport portal, the top bar's status control and menus stay
// pointer-reachable over it.
//
// It is still modal to the console (web-ui-system "The Settings view is modal to the console"):
// the root is `role="dialog"` + `aria-modal`, and every console hotkey yields to an open
// `[role=dialog]` (`isOverlayOpen`), so 1-9, Space, zoom and `?` do nothing while it is open even
// though the workspace stays mounted beneath. The shell's `[` is the one key it lets through.
//
// Section mounting (web-ui-system "Settings modal defers inactive tab content"): the nav is a
// vertical shadcn `Tabs`; every `TabsContent` is force-mounted and `hidden` (so each
// `aria-controls` resolves), and a section's content mounts on its first visit and stays mounted
// while the view is open. The view unmounts on close, so every open starts over from the section
// it names and can never commit a previously visited section's content.

export interface SettingsSectionProps {
  /** Switch the view to another section (through the discard guard). */
  onGoToSection: (id: SettingsSectionId) => void;
  /** AppShell's close-session path, for a save that changes the active team. */
  onCloseSession: () => void;
}

export interface SettingsViewProps {
  /** The open section. Owned by the shell's `settings` state. */
  section: SettingsSectionId;
  onSectionChange: (section: SettingsSectionId) => void;
  /** Closes the view (the shell clears its `settings` state; on `/teams` it also navigates). */
  onClose: () => void;
  onCloseSession: () => void;
  /** The back control's label ("Back to session" with one open). */
  backLabel: string;
  /**
   * Lets the shell route its own close paths (the top bar's status control) through the discard
   * guard. The guard returns `true` synchronously when nothing is dirty.
   */
  registerCloseGuard?: (guard: (() => true | Promise<boolean>) | null) => void;
}

const sectionLabel = (id: SettingsSectionId) =>
  SETTINGS_SECTIONS.find((s) => s.id === id)?.label ?? id;

export function SettingsView({
  section,
  onSectionChange,
  onClose,
  onCloseSession,
  backLabel,
  registerCloseGuard,
}: SettingsViewProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const headingId = useId();
  const { data: profile } = useProfile();
  // The view owns the shows scope (the drafts' saved baseline and the shows query), so every
  // show-backed section saves the same thing whichever sections were visited, and the query runs
  // only while the view is mounted, i.e. open.
  const showsScope = useSettingsShowsScopeState(profile);

  // Sections visited during this open. Adjusted during render, not in an effect, so the commit
  // that activates a section already mounts it (no empty frame) — and since the view unmounts on
  // close, a reopen starts from just the section it names.
  const [visited, setVisited] = useState<ReadonlySet<SettingsSectionId>>(() => new Set([section]));
  if (!visited.has(section)) setVisited(new Set([...visited, section]));

  // The inline sections' dirtiness (settingsGuard.ts). A ref, not state: reporting never
  // re-renders the view, and a mount that reports clean leaves the guard unarmed.
  const guards = useRef(new Map<SettingsSectionId, SectionGuardState>());
  const registry = useMemo<SettingsGuardRegistry>(
    () => ({
      set: (id, state) => {
        if (state) guards.current.set(id, state);
        else guards.current.delete(id);
      },
    }),
    [],
  );

  const { confirm, confirmElement } = useConfirm();

  const confirmDiscard = useCallback(
    async (ids: SettingsSectionId[]) => {
      const names = ids.map(sectionLabel).join(' and ');
      const ok = await confirm({
        title: 'Discard changes?',
        message: `You have unsaved changes in ${names}. Discard them?`,
        confirmLabel: 'Discard',
        cancelLabel: 'Keep editing',
        danger: true,
      });
      if (ok) for (const id of ids) guards.current.get(id)?.discard?.();
      return ok;
    },
    [confirm],
  );

  // `true` at once when nothing is dirty, so a clean close stays synchronous.
  const checkClose = useCallback((): true | Promise<boolean> => {
    const dirty = [...guards.current].filter(([, g]) => g.dirty).map(([id]) => id);
    return dirty.length === 0 ? true : confirmDiscard(dirty);
  }, [confirmDiscard]);

  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const requestClose = useCallback(() => {
    const ok = checkClose();
    if (ok === true) onCloseRef.current();
    else
      void ok.then((confirmed) => {
        if (confirmed) onCloseRef.current();
      });
  }, [checkClose]);

  useEffect(() => {
    if (!registerCloseGuard) return;
    registerCloseGuard(checkClose);
    return () => registerCloseGuard(null);
  }, [registerCloseGuard, checkClose]);

  const requestSection = (value: string) => {
    const next = value as SettingsSectionId;
    if (next === section) return;
    if (!guards.current.get(section)?.dirty) {
      onSectionChange(next);
      return;
    }
    void confirmDiscard([section]).then((ok) => {
      if (ok) onSectionChange(next);
    });
  };
  const requestSectionRef = useRef(requestSection);
  requestSectionRef.current = requestSection;
  const goToSection = useCallback((id: SettingsSectionId) => requestSectionRef.current(id), []);

  // Escape closes the view. A layer above it (a top-bar menu, a side panel, a confirm) handles its
  // own Escape first and marks it handled (Radix `preventDefault`s the keydown it dismisses on),
  // and any other overlay still open defers it too.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (isOverlayOpen(document, SETTINGS_VIEW_SELECTOR)) return;
      e.preventDefault();
      requestClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [requestClose]);

  // Focus moves in on open (to the current section's nav control) and back to the invoking
  // control on close. Under StrictMode the cleanup refocuses the invoker, so the re-run reads it
  // again rather than a control inside the view.
  useEffect(() => {
    const active = document.activeElement;
    const invoker = active instanceof HTMLElement && active !== document.body ? active : null;
    rootRef.current?.querySelector<HTMLElement>('[role="tab"][data-state="active"]')?.focus();
    return () => {
      if (invoker?.isConnected) invoker.focus();
    };
  }, []);

  const teamName =
    profile?.studios.find((s) => s.id === profile.active_studio_id)?.name ??
    profile?.studios[0]?.name;
  const showName = profile?.shows.find((s) => s.id === profile.active_show_id)?.name;
  const scopeName: Record<string, string | undefined> = { Team: teamName, Show: showName };

  return (
    <SettingsGuardContext.Provider value={registry}>
      <SettingsShowsContext.Provider value={showsScope}>
        <div
          ref={rootRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={headingId}
          data-slot="settings-view"
          className="absolute inset-0 z-(--z-settings-view) flex flex-col bg-background max-md:bottom-auto max-md:min-h-full"
        >
          <Tabs
            value={section}
            onValueChange={requestSection}
            orientation="vertical"
            className="min-h-0 flex-1 flex-row max-md:flex-col"
          >
            <div className="flex w-[250px] shrink-0 flex-col gap-4 overflow-y-auto border-r border-(--si-line) px-3 pt-4 pb-5 max-md:w-full max-md:overflow-visible max-md:border-r-0 max-md:border-b max-md:pb-4">
              <Button
                variant="ghost"
                size="sm"
                className="self-start"
                data-slot="settings-back"
                onClick={requestClose}
              >
                <ChevronLeftIcon data-icon="inline-start" aria-hidden="true" />
                {backLabel}
              </Button>
              <h2
                id={headingId}
                className="mx-2 font-ui text-[1.375rem] leading-tight font-semibold"
              >
                Settings
              </h2>
              <TabsList
                variant="nav"
                aria-label="Settings sections"
                className="max-md:grid max-md:grid-cols-2 max-md:gap-x-2"
              >
                {SETTINGS_SECTION_GROUPS.map((group, i) => (
                  <Fragment key={group.label}>
                    <div
                      aria-hidden="true"
                      className={cn(
                        'mx-2 mb-1 flex min-w-0 flex-col gap-1 max-md:col-span-full',
                        i > 0 && 'mt-4 max-md:mt-2',
                      )}
                    >
                      <span
                        data-slot="settings-nav-group"
                        className="font-label text-[0.6875rem] leading-none font-semibold tracking-[0.12em] text-muted-foreground uppercase"
                      >
                        {group.label}
                      </span>
                      {scopeName[group.label] && (
                        <span className="truncate text-[0.8125rem] font-semibold">
                          {scopeName[group.label]}
                        </span>
                      )}
                    </div>
                    {group.sections.map((s) => (
                      <TabsTrigger
                        key={s.id}
                        variant="nav"
                        value={s.id}
                        id={settingsTabId(s.id)}
                        aria-controls={settingsPanelId(s.id)}
                      >
                        {s.label}
                      </TabsTrigger>
                    ))}
                  </Fragment>
                ))}
              </TabsList>
            </div>

            <div className="min-w-0 flex-1 overflow-y-auto max-md:overflow-visible">
              {SETTINGS_SECTIONS.map(({ id }) => {
                const Content = SETTINGS_SECTION_CONTENT[id];
                return (
                  <TabsContent
                    key={id}
                    value={id}
                    forceMount
                    id={settingsPanelId(id)}
                    aria-labelledby={settingsTabId(id)}
                    hidden={section !== id}
                    className="flex max-w-[860px] flex-col gap-[18px] px-8 pt-6 pb-10 max-md:px-4 max-md:pt-[18px] max-md:pb-7"
                  >
                    {visited.has(id) && (
                      <Content onGoToSection={goToSection} onCloseSession={onCloseSession} />
                    )}
                  </TabsContent>
                );
              })}
            </div>
          </Tabs>
        </div>
      </SettingsShowsContext.Provider>
      {confirmElement}
    </SettingsGuardContext.Provider>
  );
}
