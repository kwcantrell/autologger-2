// --- assetSrc (nextjs-frontend-migration, task 1.2) ---
// Bundler-agnostic normalizer for statically-imported asset modules (png/webm
// today). Vite's default asset-import transform emits a plain string URL;
// Next's `next/image`-style static imports emit a `StaticImageData`-shaped
// object (`{ src: string, ... }`). `web/src/types/assets.d.ts` types these
// modules as `string | { src: string }` so both runtimes typecheck; call
// sites normalize through this helper instead of assuming either shape, so
// no call-site edit is needed when the bundler switches (design D5).

export function assetSrc(mod: string | { src: string }): string {
  return typeof mod === 'string' ? mod : mod.src;
}
