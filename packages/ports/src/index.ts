// @autologger/ports package entry (package-split-foundation task 4.1).
// Interface-only port definitions the app composes at server/src/appEnv.ts,
// plus the Config type and the base Ports shape. No runtime implementations
// ship here (design D2/D3) — adapters (systemClock, GoogleIdentityVerifier,
// BlobStore, KvStore, PresenceRegistry, CatalogDb) live at the composition
// side in server/src/.

export * from './blobStore';
export * from './catalogDb';
export * from './clock';
export * from './companionDevices';
export * from './config';
export * from './identityVerifier';
export * from './kvStore';
export * from './leaseDirectory';
export * from './ports';
// Types only: the module's runtime constant (PRESENCE_FRESH_MS) is imported from
// `@autologger/ports/presenceRegistry`, so this barrel stays free of runtime values.
export type * from './presenceRegistry';
