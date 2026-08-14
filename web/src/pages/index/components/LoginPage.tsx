import brandStripAsset from '../../../assets/logos/logo-autologger-transparent.png';
import { assetSrc } from '../../../shared/utils/assetSrc';
import { stashLoginReturnPathIfDeepLink } from '../../../shared/utils/loginReturnStash';

const brandStripUrl = assetSrc(brandStripAsset);

// --- LoginPage (add-login-screen, task 2.1) ---
// Full-screen branded login view for OAuth-configured deployments. Mounted by
// the root gate (task 2.2) only when `auth.oauth_configured && !auth.logged_in`;
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

// Body supplies the deep-navy ground + film grain; ThemeProvider's ambient
// glow nodes sit behind everything at z-index 0, so the wrapper stays z-[1].
const PAGE =
  'relative z-[1] flex min-h-screen min-h-[100dvh] w-full items-center justify-center px-5 py-10';

// Glass card: the shared floating-panel chrome (glass-face-strong + hairline
// border + the sky-bloom panel shadow) — the login card glows exactly like the
// app's own panels. overflow-hidden clips the full-bleed brand strip.
const CARD =
  'glass-panel relative box-border w-full max-w-[25rem] overflow-hidden rounded-v5-lg px-7 pb-9 pt-0 text-center animate-overlay-fade-in motion-reduce:animate-none max-md:px-5 max-md:pb-8';

// Brand strip: the logo asset is a glowing session-timeline band centered in a
// square transparent canvas; object-cover center-crop turns it into an
// edge-to-edge title band — the product's timeline opening the slate. The
// vertical mask fades the playhead's cropped ends so the band reads as a
// vignette, not a cut.
const BRAND_STRIP_WRAP =
  'pointer-events-none -mx-7 mb-4 select-none [mask-image:linear-gradient(180deg,transparent,black_30%,black_70%,transparent)] max-md:-mx-5';
const BRAND_STRIP_IMG = 'block h-24 w-full max-w-none object-cover';

// Wordmark in the brand's own display face (League Gothic drives the category
// buttons in-session; here it carries the name).
const WORDMARK =
  'm-0 font-league-gothic text-[2.75rem] leading-none tracking-[0.02em] uppercase text-v5-text max-md:text-[2.4rem]';

const TAGLINE = 'mx-auto mb-0 mt-2 max-w-[19rem] text-[0.9rem] leading-[1.5] text-v5-muted';

// Error banner: danger-tinted glass, house dialog radius. role="alert" lives
// on the element; the retry link starts a fresh /auth/google/start.
const ERROR_BANNER =
  'mt-6 rounded-v5-sm border border-[rgba(248,113,113,0.35)] bg-[rgba(248,113,113,0.1)] px-4 py-3 text-left';
const ERROR_TEXT = 'm-0 text-[0.85rem] leading-[1.45] text-v5-text';
const ERROR_RETRY =
  'mt-1 inline-block text-[0.85rem] font-semibold text-v5-primary underline underline-offset-2 hover-always:text-v5-primary2';

// Google sign-in: Google's light-surface branding (white face, #747775 hairline,
// #1f1f1f Roboto label, official G mark) — same recipe the rail button used.
const BTN_GOOGLE =
  'mt-7 box-border flex h-12 w-full cursor-pointer items-center justify-center gap-[0.65rem] rounded-v5-sm border border-[#747775] bg-white px-4 text-[0.9rem] font-medium leading-[1.2] text-[#1f1f1f] no-underline shadow-[0_1px_2px_rgba(0,0,0,0.12)] [font-family:"Roboto",ui-sans-serif,system-ui,-apple-system,"Segoe_UI",sans-serif] [transition:background_0.15s_ease,border-color_0.15s_ease,box-shadow_0.15s_ease] hover-always:border-[#5f6368] hover-always:bg-[#f8f9fa] hover-always:shadow-[0_1px_3px_rgba(0,0,0,0.16)]';

// Create-account section marker: the rail's uppercase tracked label idiom,
// framed by hairlines.
const SECTION_ROW = 'mt-6 flex items-center gap-3';
const SECTION_RULE = 'h-px flex-1 bg-v5-line';
const SECTION_LABEL =
  'whitespace-nowrap text-[0.625rem] font-semibold tracking-[0.18em] uppercase text-v5-muted';

// Ghost secondary control (RAIL_NAV surface treatment).
const BTN_CREATE =
  'mt-4 box-border flex h-11 w-full cursor-pointer items-center justify-center rounded-v5-sm border border-v5-border-strong bg-[rgba(255,255,255,0.03)] px-4 text-[0.8125rem] font-semibold tracking-[0.04em] text-v5-muted no-underline [transition:border-color_0.15s_ease,background_0.15s_ease,color_0.15s_ease] hover-always:bg-[rgba(255,255,255,0.05)] hover-always:text-v5-text';

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
      <main className={CARD} aria-labelledby="login-wordmark">
        <div className={BRAND_STRIP_WRAP} aria-hidden="true">
          <img className={BRAND_STRIP_IMG} src={brandStripUrl} alt="" draggable={false} />
        </div>

        <h1 className={WORDMARK} id="login-wordmark">
          AutoLogger
        </h1>
        <p className={TAGLINE}>Sign in to open your sessions, markers, and transcripts.</p>

        {errorCode !== null && (
          <div className={ERROR_BANNER} id="login-error-banner" role="alert">
            <p className={ERROR_TEXT}>{loginErrorMessage(errorCode)}</p>
            <a
              className={ERROR_RETRY}
              href="/auth/google/start"
              id="login-error-retry"
              onClick={stashLoginReturnPathIfDeepLink}
            >
              Try again
            </a>
          </div>
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
          <span className={SECTION_RULE} />
          <span className={SECTION_LABEL}>New to AutoLogger?</span>
          <span className={SECTION_RULE} />
        </div>

        <a
          className={BTN_CREATE}
          href="/auth/google/start"
          id="login-btn-create-account"
          onClick={stashLoginReturnPathIfDeepLink}
        >
          Create an account with Google
        </a>
        <p className={FINE_PRINT}>
          Your account is created automatically the first time you sign in with Google. There is no
          separate sign-up form.
        </p>
      </main>
    </div>
  );
}
