// The MCP OAuth server's HTML pages (custom dashboards J3; design
// docs/design/custom-session-dashboards.md sections 4.2 and 4.4; mcp-authorization "Consent").
//
// Three pages, all rendered here by Hono's auto-escaping `html` helper, never by Next:
// - the consent page (`GET /oauth/authorize` with a session, `GET /oauth/authorize/resume`);
// - the page that returns to the client after Approve or Deny: a `200` with a meta refresh and a
//   "Continue" link, never a `302`, because the consent page's `form-action 'self'` would block a
//   cross-origin redirect after the form post in Chromium;
// - a plain error page (`400`), which never redirects.
//
// Every page carries one inline `<style>` and loads nothing else, and `MCP_PAGE_CSP` names that
// style by its SHA-256, so the CSP allows nothing but it. Client-supplied text (the client name)
// and the redirect URL are only ever interpolated through `html`, which escapes them.

import { createHash } from 'node:crypto';
import { html, raw } from 'hono/html';

/** The one inline style every page uses; its hash is in the CSP. */
export const MCP_PAGE_STYLE = `
body{margin:0;font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;background:#f6f7f9;color:#1b1d21}
main{max-width:30rem;margin:4rem auto;padding:2rem;background:#fff;border:1px solid #dde1e6;border-radius:12px}
h1{font-size:1.3rem;margin:0 0 1rem}
p{margin:.5rem 0}
.label{color:#5c6370;font-size:.9rem}
.actions{display:flex;gap:.75rem;margin-top:1.5rem}
button{font:inherit;padding:.6rem 1.2rem;border-radius:8px;border:1px solid #c4c9d0;background:#fff;cursor:pointer}
button.primary{background:#1f5fd6;border-color:#1f5fd6;color:#fff}
a{color:#1f5fd6}
@media (prefers-color-scheme:dark){body{background:#15171a;color:#e6e8eb}main{background:#1f2226;border-color:#33373d}.label{color:#a0a6ae}button{background:#2a2e33;color:#e6e8eb;border-color:#454a51}button.primary{background:#3b7bf0;border-color:#3b7bf0;color:#fff}a{color:#7aa7ff}}
`;

const STYLE_HASH = createHash('sha256').update(MCP_PAGE_STYLE, 'utf8').digest('base64');

/** The CSP of every MCP OAuth page (design 4.2). */
export const MCP_PAGE_CSP = `default-src 'none'; style-src 'sha256-${STYLE_HASH}'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`;

/** The headers every MCP OAuth page carries beside `Cache-Control` and `Referrer-Policy`. */
export const MCP_PAGE_HEADERS: Readonly<Record<string, string>> = {
  'Content-Security-Policy': MCP_PAGE_CSP,
  'X-Frame-Options': 'DENY',
};

function page(title: string, body: unknown) {
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${title}</title>
<style>${raw(MCP_PAGE_STYLE)}</style>
</head>
<body><main>${body}</main></body>
</html>`;
}

/** What the consent page shows (design 4.4). */
export interface ConsentView {
  email: string;
  clientName: string;
  redirectHost: string;
  requestId: string;
  csrf: string;
}

export async function consentPage(v: ConsentView): Promise<string> {
  return String(
    await page(
      'Connect to AutoLogger',
      html`<h1>Allow an app to use your AutoLogger account?</h1>
<p><span class="label">Signed in as</span><br>${v.email}</p>
<p><span class="label">App name, as given by the app</span><br>${v.clientName}</p>
<p><span class="label">You will be sent back to</span><br><strong>${v.redirectHost}</strong></p>
<p><span class="label">If you approve, it can</span><br>read every session you can open, and create, edit and delete dashboards in studios where you are an owner or admin.</p>
<form method="post" action="/oauth/authorize">
<input type="hidden" name="request" value="${v.requestId}">
<input type="hidden" name="csrf" value="${v.csrf}">
<div class="actions">
<button class="primary" type="submit" name="decision" value="approve">Approve</button>
<button type="submit" name="decision" value="deny">Deny</button>
</div>
</form>`,
    ),
  );
}

/** The page that sends the browser to the client's validated, stored redirect URI. */
export async function returnPage(location: string, host: string): Promise<string> {
  return String(
    await html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta http-equiv="refresh" content="0; url=${location}">
<title>Returning to the app</title>
<style>${raw(MCP_PAGE_STYLE)}</style>
</head>
<body><main><h1>Returning to the app</h1>
<p><a href="${location}">Continue to ${host}</a></p></main></body>
</html>`,
  );
}

/** A plain error page: no redirect, no link to the client. */
export async function errorPage(title: string, message: string): Promise<string> {
  return String(await page(title, html`<h1>${title}</h1><p>${message}</p>`));
}
