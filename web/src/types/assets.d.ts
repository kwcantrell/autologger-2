// `*.png`/`*.webm` module shape is bundler-agnostic (nextjs-frontend-migration,
// task 1.2): Vite's default asset-import transform emits a plain string URL
// at runtime; Next's static-import transform emits a `StaticImageData`-shaped
// object (`{ src: string, ... }`). The declared type is the union of both so
// callers must go through `assetSrc()` (`@/shared/utils/assetSrc`) rather
// than assuming either shape -- keeping Vite's runtime string value working
// today with zero further call-site edits once Next's runtime object value
// lands (design D5).
declare module '*.png' {
  const mod: string | { src: string };
  export default mod;
}

declare module '*.json' {
  const value: { version?: string; [key: string]: unknown };
  export default value;
}

declare module '*.webm' {
  const mod: string | { src: string };
  export default mod;
}

declare module '*.woff2' {
  const src: string;
  export default src;
}
