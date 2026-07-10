import { API_ROOT } from '../../../api/client';
import { Dialog } from '../../../shared/ui/Dialog';

interface Props {
  sessionId: string;
  onClose: () => void;
}

export function ExportModal({ sessionId, onClose }: Props) {
  const base = `${API_ROOT}/sessions/${sessionId}`;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title="Export log">
      <div className="tool-row export-row modal-export-actions">
        <a className="btn primary" href={`${base}/export.csv`} download>
          CSV
        </a>
        <a className="btn primary" href={`${base}/export.jsonl`} download>
          JSONL
        </a>
      </div>
      <div className="modal-actions">
        <button type="button" className="btn" onClick={onClose}>
          Close
        </button>
      </div>
    </Dialog>
  );
}
