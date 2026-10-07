import { createContext, useContext, useEffect, useRef } from 'react';
import type { SettingsSectionId } from './sections';

// Unsaved-changes registry for the Settings view's inline sections (redesign-show-ignition D4;
// web-ui-system "Honest save model in Settings"). Each inline section reports whether its slice
// differs from its snapshot and how to throw the edits away; the view asks before a section
// switch or a close. Mounting a section reports nothing until it is dirty, so a visit alone never
// arms the guard ("Mounting a deferred tab does not arm the discard guard").

export interface SectionGuardState {
  dirty: boolean;
  /** Resets the section's slice to its snapshot after the user confirms a discard. */
  discard?: () => void;
}

export interface SettingsGuardRegistry {
  set: (id: SettingsSectionId, state: SectionGuardState | null) => void;
}

export const SettingsGuardContext = createContext<SettingsGuardRegistry | null>(null);

/**
 * Report an inline section's dirtiness to the Settings view. `dirty` must be derived from the
 * snapshot comparison, never hand-armed.
 */
export function useSettingsSectionGuard(
  id: SettingsSectionId,
  dirty: boolean,
  discard?: () => void,
): void {
  const registry = useContext(SettingsGuardContext);
  const discardRef = useRef(discard);
  discardRef.current = discard;
  useEffect(() => {
    if (!registry) return;
    registry.set(id, { dirty, discard: () => discardRef.current?.() });
    return () => registry.set(id, null);
  }, [registry, id, dirty]);
}
