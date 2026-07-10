import { useEffect, useRef, useState } from 'react';
import { API_ROOT } from '../../../api/client';
import { Dialog } from '../../../shared/ui/Dialog';

interface Props {
  sessionId: string;
  onClose: () => void;
}

type Status = 'loading' | 'done' | 'error';

export function TranscribeModal({ sessionId, onClose }: Props) {
  const [status, setStatus] = useState<Status>('loading');
  const [csvUrl, setCsvUrl] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const urlRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    fetch(`${API_ROOT}/sessions/${sessionId}/transcribe.csv`)
      .then(async (res) => {
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          let detail = `HTTP ${res.status}`;
          try {
            const json = JSON.parse(text) as { detail?: string };
            if (json.detail) detail = json.detail;
          } catch {
            if (text) detail = text;
          }
          throw new Error(detail);
        }
        return res.blob();
      })
      .then((blob) => {
        if (cancelled) return;
        const url = URL.createObjectURL(blob);
        urlRef.current = url;
        setCsvUrl(url);
        setStatus('done');
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setErrorMsg(err instanceof Error ? err.message : String(err));
        setStatus('error');
      });

    return () => {
      cancelled = true;
      if (urlRef.current) {
        URL.revokeObjectURL(urlRef.current);
        urlRef.current = null;
      }
    };
  }, [sessionId]);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title="Transcribe audio">
      {status === 'loading' && (
        <p className="modal-transcribe-status">Transcribing… this may take a few minutes.</p>
      )}
      {status === 'done' && csvUrl && (
        <div className="tool-row export-row modal-export-actions">
          <a
            className="btn primary"
            href={csvUrl}
            download={`transcription_${sessionId.slice(0, 8)}.csv`}
          >
            Download CSV
          </a>
        </div>
      )}
      {status === 'error' && (
        <p className="modal-transcribe-error">{errorMsg ?? 'Transcription failed.'}</p>
      )}
      <div className="modal-actions">
        <button type="button" className="btn" onClick={onClose}>
          {status === 'loading' ? 'Cancel' : 'Close'}
        </button>
      </div>
    </Dialog>
  );
}
