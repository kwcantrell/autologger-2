// IdentityVerifier port (spec: core-ports-architecture): Google OAuth identity
// verification today (`server/src/auth/oauth_google.ts`'s
// `GoogleIdentityVerifier` class) — a substitutable port so tests never touch
// the network.
//
// `JWTPayload` is `jose`'s claim-bag type (an external dependency, not an
// `@autologger/*` one) — this is a type-only reference, erased at compile
// time under `verbatimModuleSyntax`, so it does not pull `jose`'s runtime
// into this package.

import type { JWTPayload } from 'jose';

export interface IdentityVerifier {
  authorizationUrl(opts: { clientId: string; state: string; redirectUri: string }): string;
  /** Exchange the authorization code for tokens (includes id_token). Throws on HTTP error. */
  exchangeCode(opts: {
    code: string;
    redirectUri: string;
    clientId: string;
    clientSecret: string;
  }): Promise<Record<string, unknown>>;
  /** Verify signature + audience + issuer; returns claims. Throws on failure. */
  verifyIdToken(idToken: string, clientId: string): Promise<JWTPayload>;
}
