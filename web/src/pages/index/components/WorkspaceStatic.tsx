import { memo } from 'react';
import { SessionWorkspace } from './SessionWorkspace';

interface WorkspaceStaticProps {
  sessionId: string;
  ytImportPending?: boolean;
  onOpenMobileNav?: () => void;
}

// Render-isolation memo over SessionWorkspace. The settings modal it used to
// mount moved to AppShell (teams-settings-nav, design D1); this wrapper is
// kept as-is rather than inlined into SessionRoute — a recorded deferral, not
// an oversight.
export const WorkspaceStatic = memo(
  ({ sessionId, ytImportPending, onOpenMobileNav }: WorkspaceStaticProps) => (
    <SessionWorkspace
      sessionId={sessionId}
      ytImportPending={ytImportPending}
      onOpenMobileNav={onOpenMobileNav}
    />
  ),
);
WorkspaceStatic.displayName = 'WorkspaceStatic';
