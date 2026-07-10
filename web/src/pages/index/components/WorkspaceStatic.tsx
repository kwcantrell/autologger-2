import { memo } from 'react';
import { HomeSettingsModal } from './HomeSettingsModal';
import { SessionWorkspace } from './SessionWorkspace';

interface WorkspaceStaticProps {
  sessionId: string;
  showSettings: boolean;
  onCloseSettings: () => void;
  ytImportPending?: boolean;
}

export const WorkspaceStatic = memo(
  ({ sessionId, showSettings, onCloseSettings, ytImportPending }: WorkspaceStaticProps) => (
    <>
      <HomeSettingsModal isOpen={showSettings} onClose={onCloseSettings} />
      <SessionWorkspace sessionId={sessionId} ytImportPending={ytImportPending} />
    </>
  ),
);
WorkspaceStatic.displayName = 'WorkspaceStatic';
