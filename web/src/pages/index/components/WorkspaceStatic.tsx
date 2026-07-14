import { memo } from 'react';
import { HomeSettingsModal } from './HomeSettingsModal';
import { SessionWorkspace } from './SessionWorkspace';

interface WorkspaceStaticProps {
  sessionId: string;
  showSettings: boolean;
  onCloseSettings: () => void;
  /** Close the active session (AppShell's close handler — navigates home). */
  onCloseSession: () => void;
  ytImportPending?: boolean;
}

export const WorkspaceStatic = memo(
  ({
    sessionId,
    showSettings,
    onCloseSettings,
    onCloseSession,
    ytImportPending,
  }: WorkspaceStaticProps) => (
    <>
      <HomeSettingsModal
        isOpen={showSettings}
        onClose={onCloseSettings}
        onCloseSession={onCloseSession}
      />
      <SessionWorkspace sessionId={sessionId} ytImportPending={ytImportPending} />
    </>
  ),
);
WorkspaceStatic.displayName = 'WorkspaceStatic';
