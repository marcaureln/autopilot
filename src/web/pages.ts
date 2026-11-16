import { readFileSync } from "node:fs";

const wordmark = readFileSync(new URL("../../assets/autopilot-wordmark-black.svg", import.meta.url), "utf8").replaceAll("#111111", "currentColor");

const favicon = `data:image/svg+xml,${encodeURIComponent(readFileSync(new URL("../../assets/favicon.svg", import.meta.url), "utf8"))}`;

const REPO_URL = "https://github.com/marcaureln/autopilot";

const STYLE = `
:root {
  --paper: #FFFFFF; --fog: #F2F2F2; --line: #D9D9D9; --steel: #6B6B6B; --graphite: #3A3A3A;
  --ink: #111111; --on-ink: #FFFFFF; --control-border: #8C8C8C; --success: #1E6B38; --danger: #B3261E;
  --font-sans: "Geist", "Inter", system-ui, sans-serif; --font-mono: "IBM Plex Mono", ui-monospace, monospace;
}
@media (prefers-color-scheme: dark) { :root {
  --paper: #0E0E0E; --fog: #1A1A1A; --line: #2E2E2E; --steel: #9C9C9C; --graphite: #C8C8C8;
  --ink: #F5F5F5; --on-ink: #0E0E0E; --control-border: #6E6E6E; --success: #5CC985; --danger: #F2766B;
} }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 48px 16px;
  font: 16px/24px var(--font-sans); background: var(--paper); color: var(--ink); -webkit-font-smoothing: antialiased; }
main { width: 100%; max-width: 520px; display: flex; flex-direction: column; gap: 32px; }
.logo { display: block; width: 160px; color: var(--ink); align-self: flex-start; }
.logo:focus-visible { outline: 2px solid var(--ink); outline-offset: 4px; }
.logo svg { display: block; width: 100%; height: auto; }
h1 { margin: 0; font-size: 28px; line-height: 34px; font-weight: 600; letter-spacing: -0.5px; }
p { margin: 0; color: var(--graphite); }
.ap-label { font: 500 12px/16px var(--font-mono); letter-spacing: 1.5px; text-transform: uppercase; color: var(--steel); }
.ap-panel { border: 1px solid var(--line); }
.ap-panel-head { display: flex; justify-content: space-between; align-items: center; padding: 12px 16px; border-bottom: 1px solid var(--line); }
.ap-panel-body { padding: 24px; display: flex; flex-direction: column; gap: 16px; }
.ap-tag { display: inline-flex; align-items: center; gap: 8px; font: 500 12px/16px var(--font-mono); letter-spacing: 1px;
  text-transform: uppercase; padding: 4px 12px; border: 1px solid var(--line); }
.ap-tag-queued { border-style: dashed; border-color: var(--control-border); color: var(--steel); }
.ap-tag-live::before { content: ""; width: 6px; height: 6px; border-radius: 9999px; background: var(--success); }
.ap-tag-danger { color: var(--danger); border-color: var(--danger); }
dl { margin: 0; display: grid; grid-template-columns: max-content 1fr; border-top: 1px solid var(--line); }
dt, dd { margin: 0; padding: 8px 0; border-bottom: 1px solid var(--line); }
dt { padding-right: 24px; }
dd { font: 14px/20px var(--font-mono); overflow-wrap: anywhere; padding-top: 6px; }
.ap-code { margin: 0; font: 14px/20px var(--font-mono); background: var(--fog); padding: 16px; border: 1px solid var(--line); overflow-x: auto; white-space: pre-wrap; }
.ap-btn { font: 600 15px var(--font-sans); height: 44px; padding: 0 16px; border: 1px solid var(--ink); border-radius: 0;
  background: var(--ink); color: var(--on-ink); cursor: pointer; display: inline-flex; align-items: center; text-decoration: none; align-self: flex-start; }
.ap-btn:hover { background: var(--graphite); border-color: var(--graphite); }
.ap-btn:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }
.ap-hint { font-size: 13px; line-height: 18px; color: var(--steel); }
.ap-hint code { font: 13px/18px var(--font-mono); color: var(--ink); background: var(--fog); border: 1px solid var(--line); padding: 1px 6px; }
`;

function escape(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)} · autopilot</title>
<link rel="icon" type="image/svg+xml" href="${favicon}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500;600&display=swap">
<style>${STYLE}</style>
</head>
<body>
<main>
<a class="logo" href="${REPO_URL}" aria-label="autopilot on GitHub">${wordmark}</a>
${body}
</main>
</body>
</html>`;
}

function panel(label: string, tag: string, content: string): string {
  return `<section class="ap-panel">
<div class="ap-panel-head"><span class="ap-label">${label}</span>${tag}</div>
<div class="ap-panel-body">${content}</div>
</section>`;
}

function rows(entries: [string, string][]): string {
  return `<dl>${entries.map(([key, value]) => `<dt class="ap-label">${escape(key)}</dt><dd>${escape(value)}</dd>`).join("")}</dl>`;
}

export function appStartPage(options: { action: string; manifest: { name: string; default_permissions: Record<string, string> } }): string {
  const permissions = Object.entries(options.manifest.default_permissions).map(([name, level]): [string, string] => [name.replaceAll("_", " "), level]);
  return layout(
    "Create the GitHub App",
    panel(
      "Step 1 of 2 · GitHub App",
      `<span class="ap-tag ap-tag-queued">Not created</span>`,
      `<h1>Create the GitHub App</h1>
<p>Autopilot acts on GitHub through its own App. On the next page, GitHub suggests the name <b>${escape(options.manifest.name)}</b>. You can change it there. The App gets these permissions.</p>
${rows(permissions)}
<form method="post" action="${escape(options.action)}">
<input type="hidden" name="manifest" value="${escape(JSON.stringify(options.manifest))}">
<button class="ap-btn" type="submit">Continue to GitHub</button>
</form>`,
    ),
  );
}

export function appCreatedPage(app: { slug: string; id: number; keyPath: string; installUrl: string }): string {
  return layout(
    "App created",
    panel(
      "Step 2 of 2 · Install",
      `<span class="ap-tag ap-tag-live">Created</span>`,
      `<h1>${escape(app.slug)} is ready</h1>
<p>Install the App on the accounts and orgs that autopilot may work on.</p>
${rows([
  ["App ID", String(app.id)],
  ["Private key", app.keyPath],
])}
<a class="ap-btn" href="${escape(app.installUrl)}">Install the App</a>`,
    ) + `<p class="ap-hint">You can close this tab. The terminal shows the same details.</p>`,
  );
}

export function appFailedPage(message: string): string {
  return layout(
    "App not created",
    panel(
      "GitHub App",
      `<span class="ap-tag ap-tag-danger">Failed</span>`,
      `<h1>The App was not created</h1>
<p>GitHub returned an error. Nothing was written to this machine.</p>
<pre class="ap-code">${escape(message)}</pre>`,
    ) + `<p class="ap-hint">Run <code>autopilot app create</code> again to retry.</p>`,
  );
}
