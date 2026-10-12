// Resumable upload rows (OpenSpec change `media-worker`, design D12): the MediaUploadsPort over
// `catalog.media_uploads`. The staged bytes live in `BLOB_DIR/.tmp/upload-<id>` (blobStore.ts);
// these rows hold the declared part hashes, the received part numbers and the expiry, which moves
// to 24 h after the last part. A user binding sees only the uploads it created on sessions it can
// access (the table's policy); the sweep runs as `catalog_system`. `?` placeholders, unqualified
// names.

import type { MediaUpload, MediaUploadStatus, MediaUploadsPort } from '@autologger/ports/media';
import { UPLOAD_TTL_MS } from './mediaLimits';

type Row = Record<string, unknown>;

function parseNumbers(text: unknown): number[] {
  const v = JSON.parse(String(text)) as unknown;
  return Array.isArray(v) ? v.map((x) => Number(x)) : [];
}

function parseStrings(text: unknown): string[] {
  const v = JSON.parse(String(text)) as unknown;
  return Array.isArray(v) ? v.map((x) => String(x)) : [];
}

export function mediaUploadFromRow(r: Row): MediaUpload {
  return {
    id: String(r.id),
    sessionId: String(r.session_id),
    createdByUserId: String(r.created_by_user_id),
    contentType: String(r.content_type),
    sizeBytes: Number(r.size_bytes),
    partSize: Number(r.part_size),
    partsTotal: Number(r.parts_total),
    partSha256: parseStrings(r.part_sha256_json),
    received: parseNumbers(r.received_json),
    status: String(r.status) as MediaUploadStatus,
    expiresAtMs: Number(r.expires_at_ms),
    createdAtMs: Number(r.created_at_ms),
  };
}

export const mediaUploads: MediaUploadsPort = {
  async create(db, u) {
    const [r] = await db.all<Row>(
      `INSERT INTO media_uploads (id, session_id, created_by_user_id, content_type, size_bytes,
         part_size, parts_total, part_sha256_json, received_json, status, expires_at_ms,
         created_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, '[]', 'open', ?, ?)
       RETURNING *`,
      u.id,
      u.sessionId,
      u.createdByUserId,
      u.contentType,
      u.sizeBytes,
      u.partSize,
      u.partSha256.length,
      JSON.stringify(u.partSha256),
      u.nowMs + UPLOAD_TTL_MS,
      u.nowMs,
    );
    if (!r) throw new Error('media upload insert returned no row');
    return mediaUploadFromRow(r);
  },

  async get(db, id) {
    const [r] = await db.all<Row>('SELECT * FROM media_uploads WHERE id = ?', id);
    return r ? mediaUploadFromRow(r) : null;
  },

  async recordPart(db, id, n, nowMs) {
    // One statement: under concurrent parts the row lock serialises the updates and each re-reads
    // the latest `received_json` (READ COMMITTED re-evaluation), so no part is lost.
    const { changes } = await db.run(
      `UPDATE media_uploads
          SET received_json = (
                SELECT COALESCE(json_agg(p ORDER BY p), '[]'::json)::text
                  FROM (SELECT (jsonb_array_elements_text(received_json::jsonb))::int AS p
                        UNION SELECT ?::int) parts),
              expires_at_ms = ?
        WHERE id = ? AND status = 'open' AND expires_at_ms > ?
          AND ?::int BETWEEN 1 AND parts_total`,
      n,
      nowMs + UPLOAD_TTL_MS,
      id,
      nowMs,
      n,
    );
    return changes > 0;
  },

  async markComplete(db, id, nowMs) {
    const { changes } = await db.run(
      `UPDATE media_uploads SET status = 'complete'
        WHERE id = ? AND status = 'open' AND expires_at_ms > ?`,
      id,
      nowMs,
    );
    return changes > 0;
  },

  async remove(db, id) {
    const { changes } = await db.run('DELETE FROM media_uploads WHERE id = ?', id);
    return changes > 0;
  },

  async deleteExpired(db, nowMs) {
    const rows = await db.all<{ id: string }>(
      'DELETE FROM media_uploads WHERE expires_at_ms <= ? RETURNING id',
      nowMs,
    );
    return rows.map((r) => String(r.id));
  },

  async openUsage(db, userId, nowMs) {
    const [r] = await db.all<Row>(
      `SELECT count(*)::int AS n, COALESCE(sum(size_bytes), 0)::bigint AS bytes
         FROM media_uploads
        WHERE created_by_user_id = ? AND status = 'open' AND expires_at_ms > ?`,
      userId,
      nowMs,
    );
    return { count: Number(r?.n ?? 0), bytes: Number(r?.bytes ?? 0) };
  },
};
