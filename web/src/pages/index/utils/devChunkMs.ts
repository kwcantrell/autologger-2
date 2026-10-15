// Dev-only override of the recorder's chunk length (media-worker task V.2): a development build reads
// a whole number of milliseconds from localStorage `autologger.dev.chunkMs`, so an end-to-end check
// can produce several chunks in a minute. Production and test builds never read it. Bounded to
// 15 s .. 10 min (the production length); anything else is ignored.

export const DEV_CHUNK_MS_KEY = 'autologger.dev.chunkMs';
const MIN_MS = 15_000;
const MAX_MS = 10 * 60_000;

export function devChunkMsOverride(
  nodeEnv: string | undefined = process.env.NODE_ENV,
  storage: Pick<Storage, 'getItem'> | undefined = typeof localStorage === 'undefined'
    ? undefined
    : localStorage,
): number | null {
  if (nodeEnv !== 'development' || !storage) return null;
  let raw: string | null;
  try {
    raw = storage.getItem(DEV_CHUNK_MS_KEY);
  } catch {
    return null;
  }
  if (raw === null || !/^[0-9]{1,7}$/.test(raw)) return null;
  const ms = Number(raw);
  return ms >= MIN_MS && ms <= MAX_MS ? ms : null;
}
