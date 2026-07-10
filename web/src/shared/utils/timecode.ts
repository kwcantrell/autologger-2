import type { LogEvent } from '../../api/types';

export function parseSmpteToSec(tc: string | null | undefined): number {
  const m = /^(\d{2}):(\d{2}):(\d{2})(?:[:;]\d+)?$/.exec(String(tc ?? '').trim());
  if (!m) return -1;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

export function formatTimecodeHMS(tc: string | null | undefined): string {
  if (tc == null || tc === '') return '—';
  return String(tc).replace(/[:;]\d{2}$/, '');
}

/** Format non-negative seconds as HH:MM:SS (truncated, no fractional). */
export function fmtHmsFromSec(sec: number): string {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const hh = String(Math.floor(s / 3600)).padStart(2, '0');
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

export function formatWallUtcYmdHms(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  const yy = p(d.getUTCFullYear() % 100);
  return `${yy}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

function wallUtcTwoDigitYearToFull(yy: string): number | null {
  const n = Number(yy);
  if (!Number.isFinite(n) || n < 0 || n > 99) return null;
  return n <= 69 ? 2000 + n : 1900 + n;
}

export function parseYmdHmsUtcToIso(s: string): string | null {
  const t = String(s ?? '').trim();
  const m4 = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(t);
  const m2 = /^(\d{2})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(t);
  const m = m4 ?? m2;
  if (!m) return null;
  const y = m4 ? Number(m[1]) : wallUtcTwoDigitYearToFull(m[1]);
  const mo = Number(m[2]);
  const da = Number(m[3]);
  const h = Number(m[4]);
  const mi = Number(m[5]);
  const se = Number(m[6]);
  if (y == null || ![y, mo, da, h, mi, se].every((x) => Number.isFinite(x))) return null;
  if (mo < 1 || mo > 12 || da < 1 || da > 31 || h > 23 || mi > 59 || se > 59) return null;
  const d = new Date(Date.UTC(y, mo - 1, da, h, mi, se));
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function normalizeWallIso(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso).trim();
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function isAutomaticLogEvent(e: LogEvent): boolean {
  const msg = String(e?.message ?? '');
  if (/^Recording \d+ (Started|Stopped)$/.test(msg)) return true;
  if (/^Log Audio Recording (Started|Stopped)$/.test(msg)) return true;
  if (/^Take \d+ Session (Started|Ended)$/.test(msg)) return true;
  return false;
}
