import clsx from 'clsx';
import { useState } from 'react';
import { apiFetch } from '../../../api/client';
import { Button, TOUCH_TARGET } from '../../../shared/components/ui/button';
import { Input } from '../../../shared/components/ui/input';
import { Dialog } from '../../../shared/ui/Dialog';
import { showToast } from '../utils/toast';

// The former `.tool-row`: a wrapping flex row (1rem column / 0.75rem row gaps).
const ROW = 'flex flex-wrap items-center gap-x-4 gap-y-3';

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
      <p className="my-[1em]">
        Could not download audio from the YouTube link. What would you like to do?
      </p>

      {showRetryInput && (
        <div className={clsx(ROW, 'mt-3')}>
          <Input
            type="url"
            aria-label="YouTube video link"
            className="min-w-0 flex-1"
            placeholder="Link to YouTube video"
            autoFocus
            value={retryUrl}
            onChange={(e) => setRetryUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && retryUrl.trim()) onRetry(retryUrl.trim());
            }}
          />
          <Button
            className={TOUCH_TARGET}
            disabled={!retryUrl.trim()}
            onClick={() => onRetry(retryUrl.trim())}
          >
            Import
          </Button>
        </div>
      )}

      <div className={clsx(ROW, 'mt-4 gap-2')}>
        {!showRetryInput && (
          <Button className={TOUCH_TARGET} onClick={() => setShowRetryInput(true)}>
            Try a different link
          </Button>
        )}
        <Button variant="outline" className={TOUCH_TARGET} onClick={onContinue}>
          Continue without audio
        </Button>
        <Button
          variant="destructive"
          className={TOUCH_TARGET}
          disabled={cancelling}
          onClick={handleCancel}
        >
          {cancelling ? 'Deleting…' : "Don't create session"}
        </Button>
      </div>
    </Dialog>
  );
}
