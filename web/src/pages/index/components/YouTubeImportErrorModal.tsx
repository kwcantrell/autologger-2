import { useState } from 'react';
import { apiFetch } from '../../../api/client';
import { Dialog } from '../../../shared/ui/Dialog';
import { showToast } from '../utils/toast';

interface Props {
  sessionId: string;
  lastUrl: string;
  onRetry: (newUrl: string) => void;
  onContinue: () => void;
  onCancel: () => void;
}

export function YouTubeImportErrorModal({
  sessionId,
  lastUrl,
  onRetry,
  onContinue,
  onCancel,
}: Props) {
  const [retryUrl, setRetryUrl] = useState(lastUrl);
  const [showRetryInput, setShowRetryInput] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  const handleCancel = async () => {
    setCancelling(true);
    try {
      await apiFetch(`sessions/${sessionId}/archive`, { method: 'POST' });
      await apiFetch(`sessions/${sessionId}`, { method: 'DELETE' });
    } catch {
      showToast('Could not delete session.', true);
    } finally {
      setCancelling(false);
      onCancel();
    }
  };

  return (
    <Dialog
      open
      onOpenChange={() => {
        /* parent controls mounting; ignore Radix close attempts */
      }}
      closeOnOverlayClick={false}
      title="YouTube import failed"
    >
      <p>Could not download audio from the YouTube link. What would you like to do?</p>

      {showRetryInput && (
        <div className="tool-row" style={{ marginTop: '0.75rem' }}>
          <input
            type="url"
            className="profile-select"
            placeholder="Link to YouTube video"
            autoFocus
            value={retryUrl}
            onChange={(e) => setRetryUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && retryUrl.trim()) onRetry(retryUrl.trim());
            }}
          />
          <button
            type="button"
            className="btn primary"
            disabled={!retryUrl.trim()}
            onClick={() => onRetry(retryUrl.trim())}
          >
            Import
          </button>
        </div>
      )}

      <div className="tool-row" style={{ marginTop: '1rem', gap: '0.5rem' }}>
        {!showRetryInput && (
          <button type="button" className="btn primary" onClick={() => setShowRetryInput(true)}>
            Try a different link
          </button>
        )}
        <button type="button" className="btn" onClick={onContinue}>
          Continue without audio
        </button>
        <button type="button" className="btn danger" disabled={cancelling} onClick={handleCancel}>
          {cancelling ? 'Deleting…' : "Don't create session"}
        </button>
      </div>
    </Dialog>
  );
}
