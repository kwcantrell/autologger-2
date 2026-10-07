import { Alert, AlertDescription } from '../../../shared/components/ui/alert';
import { Button } from '../../../shared/components/ui/button';
import { Card } from '../../../shared/components/ui/card';
import { Separator } from '../../../shared/components/ui/separator';
import { stashLoginReturnPathIfDeepLink } from '../../../shared/utils/loginReturnStash';

// --- LoginPage (add-login-screen, task 2.1) ---
// Full-screen branded login view. Mounted by the root gate whenever
// `!auth.logged_in` (require-login D8: there is no anonymous mode);
// this component itself issues no network traffic. Both entry controls are
// plain anchors to the existing `GET /auth/google/start` route — first-time
// Google sign-in creates the account automatically in the callback's new-user
// branch, so "create account" is the same navigation with different framing
// (spec `web-login-experience`, "Google sign-in entry").
//
// All three sign-in affordances (Google sign-in, create-account, error-state
// retry) share `stashLoginReturnPathIfDeepLink` as their `onClick`, which
// synchronously stashes the current deep link before the browser follows the
// anchor's `href` (session-deep-links, task 6.2, design D6). The anchors keep
// their plain `href="/auth/google/start"` — the login-gate e2e asserts those
// hrefs — the stash write rides the activation's `onClick`, which runs before
// the browser navigates.

/**
 * `?login_error=<code>` copy, grouped per design D5: three messages, not six.
 * Unrecognized codes (the server may add codes over time) fall through to the
 * generic message; none of the copy may disclose deployment configuration.
 */
const LOGIN_ERROR_MESSAGES: Record<string, string> = {
  state_invalid: 'This sign-in attempt expired.',
  provider_error: 'Sign-in was cancelled or refused.',
};

const LOGIN_ERROR_GENERIC = "Sign-in didn't complete.";

function loginErrorMessage(code: string): string {
  return LOGIN_ERROR_MESSAGES[code] ?? LOGIN_ERROR_GENERIC;
}

function readLoginErrorCode(): string | null {
  if (typeof window === 'undefined') return null;
  return new URLSearchParams(window.location.search).get('login_error');
}

// --- class strings (V6Rail-style constants; v5 tokens throughout) ---

// The page ground is the body's flat --si-bg; the wrapper stays z-[1] above any shell layer.
const PAGE =
  'relative z-[1] flex min-h-screen min-h-[100dvh] w-full items-center justify-center px-5 py-10';

// The panel is the flat shadcn Card on --si-panel (redesign-show-ignition fix round 3: it was the
// glass panel). A short fade in, none under reduced motion.
const MAIN = 'w-full max-w-[25rem]';
const CARD =
  'gap-0 px-7 pb-9 pt-8 text-center animate-overlay-fade-in motion-reduce:animate-none max-md:px-5 max-md:pb-8';

// Brand mark (fix round 3, owner decision): the product's timeline in the redesign's own
// vocabulary, replacing the PNG strip whose red/cyan/purple markers broke the one-accent world.
// A slim band on the panel ground, neutral markers plus one accent marker, and the signature
// glowing accent playhead (the timeline playhead's `0 0 10px 1px` halo). No gradients.
const MARK = 'relative mx-auto mb-6 h-12 w-64 max-w-full select-none pointer-events-none';
const MARK_BAND =
  'absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full border border-si-line bg-si-panel-2';
const MARK_DOT = 'absolute top-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-si-dim';
const MARK_DOT_ACCENT =
  'absolute top-1/2 h-2 w-5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-si-accent';
const MARK_PLAYHEAD =
  'absolute inset-y-0 left-[46%] w-0.5 -translate-x-1/2 rounded-full bg-si-accent [box-shadow:0_0_10px_1px_color-mix(in_oklab,var(--si-accent)_75%,transparent),0_0_4px_1px_color-mix(in_oklab,var(--si-accent)_75%,transparent)]';

function BrandMark() {
  return (
    <div className={MARK} data-slot="login-brand-mark" aria-hidden="true">
      <div className={MARK_BAND} data-part="band" />
      <span className={`${MARK_DOT} left-[12%]`} data-part="marker" />
      <span className={`${MARK_DOT_ACCENT} left-[34%]`} data-part="marker" />
      <span className={`${MARK_DOT} left-[64%]`} data-part="marker" />
      <span className={`${MARK_DOT} left-[86%]`} data-part="marker" />
      <span className={MARK_PLAYHEAD} data-part="playhead" />
    </div>
  );
}

// Wordmark in the brand's own display face (League Gothic drives the category
// buttons in-session; here it carries the name).
const WORDMARK =
  'm-0 font-league-gothic font-bold text-[2.75rem] leading-none tracking-[0.02em] uppercase text-v5-text max-md:text-[2.4rem]';

const TAGLINE = 'mx-auto mb-0 mt-2 max-w-[19rem] text-[0.9rem] leading-[1.5] text-v5-muted';

// Error banner: danger-tinted glass, house dialog radius. role="alert" lives
// on the element; the retry link starts a fresh /auth/google/start.
// shadcn-port-shell D4: the error banner is the destructive Alert (tinted as before); retry is a
// link-variant Button rendered as the same <a>.
const ERROR_BANNER =
  'mt-6 block bg-[rgba(248,113,113,0.1)] border-[rgba(248,113,113,0.35)] text-left';
const ERROR_TEXT = 'm-0 block text-[0.85rem] leading-[1.45] text-v5-text';
const ERROR_RETRY =
  'mt-1 h-auto p-0 text-[0.85rem] font-semibold normal-case tracking-normal underline underline-offset-2 hover-always:text-v5-primary2';

// Google sign-in: Google's light-surface branding (white face, #747775 hairline,
// #1f1f1f Roboto label, official G mark) — same recipe the rail button used.
const BTN_GOOGLE =
  'mt-7 box-border flex h-12 w-full cursor-pointer items-center justify-center gap-[0.65rem] rounded-v5-sm border border-[#747775] bg-white px-4 text-[0.9rem] font-medium leading-[1.2] text-[#1f1f1f] no-underline shadow-[0_1px_2px_rgba(0,0,0,0.12)] [font-family:"Roboto",ui-sans-serif,system-ui,-apple-system,"Segoe_UI",sans-serif] [transition:background_0.15s_ease,border-color_0.15s_ease,box-shadow_0.15s_ease] hover-always:border-[#5f6368] hover-always:bg-[#f8f9fa] hover-always:shadow-[0_1px_3px_rgba(0,0,0,0.16)]';

// Create-account section marker: the rail's uppercase tracked label idiom,
// framed by hairlines.
const SECTION_ROW = 'mt-6 flex items-center gap-3';
const SECTION_RULE = 'flex-1 bg-v5-line';
const SECTION_LABEL =
  'whitespace-nowrap text-[0.625rem] font-semibold tracking-[0.18em] uppercase text-v5-muted';

// Ghost secondary control (RAIL_NAV surface treatment).
const BTN_CREATE =
  'mt-4 box-border flex h-11 w-full cursor-pointer items-center justify-center rounded-v5-sm border border-v5-border-strong bg-[rgba(255,255,255,0.03)] px-4 text-[0.8125rem] font-semibold normal-case tracking-[0.04em] text-[rgba(229,238,252,0.78)] no-underline [transition:border-color_0.15s_ease,background_0.15s_ease,color_0.15s_ease] hover-always:bg-[rgba(255,255,255,0.05)] hover-always:text-v5-text';

const FINE_PRINT = 'mx-auto mb-0 mt-4 max-w-[20rem] text-[0.78rem] leading-[1.5] text-v5-soft';

function GoogleGMark() {
  return (
    <svg
      className="block flex-shrink-0"
      width="20"
      height="20"
      viewBox="0 0 48 48"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6C44.98 37.03 48 31.06 48 24c0-1.67-.14-3.29-.41-4.84z"
      />
      <path
        fill="#FBBC05"
        d="M6.99 29.16c-.65-1.95-1-4.02-1-6.16 0-2.15.35-4.22 1-6.16l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.35L6.99 29.16z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.35 0-11.72-4.27-13.59-10.08l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
    </svg>
  );
}

export function LoginPage() {
  const errorCode = readLoginErrorCode();

  return (
    <div className={PAGE}>
      <main className={MAIN} aria-labelledby="login-wordmark">
        <Card className={CARD}>
          <BrandMark />

          <h1 className={WORDMARK} id="login-wordmark">
            AutoLogger
          </h1>
          <p className={TAGLINE}>Sign in to open your sessions, markers, and transcripts.</p>

          {errorCode !== null && (
            <Alert variant="destructive" className={ERROR_BANNER} id="login-error-banner">
              <AlertDescription className={ERROR_TEXT}>
                {loginErrorMessage(errorCode)}
              </AlertDescription>
              <Button variant="link" asChild className={ERROR_RETRY}>
                <a
                  href="/auth/google/start"
                  id="login-error-retry"
                  onClick={stashLoginReturnPathIfDeepLink}
                >
                  Try again
                </a>
              </Button>
            </Alert>
          )}

          <a
            className={BTN_GOOGLE}
            href="/auth/google/start"
            id="login-btn-google"
            onClick={stashLoginReturnPathIfDeepLink}
          >
            <GoogleGMark />
            <span>Sign in with Google</span>
          </a>

          <div className={SECTION_ROW} aria-hidden="true">
            <Separator className={SECTION_RULE} />
            <span className={SECTION_LABEL}>New to AutoLogger?</span>
            <Separator className={SECTION_RULE} />
          </div>

          {/* Outline Button rendered as the same <a> (id/href/stash unchanged); BTN_CREATE keeps the
            0.78-alpha label the AA floor needs (contrastTokens.test.ts reads this constant). */}
          <Button variant="outline" asChild className={BTN_CREATE}>
            <a
              href="/auth/google/start"
              id="login-btn-create-account"
              onClick={stashLoginReturnPathIfDeepLink}
            >
              Create an account with Google
            </a>
          </Button>
          <p className={FINE_PRINT}>
            Your account is created automatically the first time you sign in with Google. There is
            no separate sign-up form.
          </p>
        </Card>
      </main>
    </div>
  );
}
