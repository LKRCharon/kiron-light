import { writeFileSync } from "node:fs";

const regions = [
  "ap-northeast-2",
  "ap-southeast-1",
  "eu-central-1",
  "us-east-1",
];

const serviceRoots = [
  "access-gateway",
  "artifact-registry",
  "audit-ledger",
  "billing-meter",
  "change-planner",
  "config-resolver",
  "deployment-coordinator",
  "event-router",
  "flag-evaluator",
  "health-aggregator",
  "incident-broker",
  "policy-engine",
];

const teams = [
  "identity",
  "release-platform",
  "runtime-reliability",
  "developer-experience",
  "security-engineering",
  "data-foundation",
];

const tenants = [
  "northwind",
  "papertrail",
  "solstice",
  "harbor",
  "atlas",
  "juniper",
  "lattice",
  "meridian",
];

const statuses = ["healthy", "deploying", "degraded", "paused"];
const severities = ["info", "warning", "critical"];

const services = Array.from({ length: 48 }, (_, index) => {
  const root = serviceRoots[index % serviceRoots.length];
  const region = regions[index % regions.length];
  const status = statuses[(index * 3) % statuses.length];
  const errorBudget = Math.max(7.2, 99.7 - index * 1.37);
  const latency = 42 + ((index * 37) % 410);
  const replicas = 3 + (index % 6);
  return {
    id: `${root}-${region}-${String(index + 1).padStart(2, "0")}`,
    name: root,
    region,
    status,
    team: teams[index % teams.length],
    version: `2026.08.${String(120 + index).padStart(3, "0")}`,
    errorBudget: errorBudget.toFixed(1),
    latency,
    replicas,
  };
});

const flags = Array.from({ length: 36 }, (_, index) => ({
  key: `release.${serviceRoots[index % serviceRoots.length]}.${[
    "adaptive-batching",
    "async-audit",
    "hedged-reads",
  ][index % 3]}`,
  tenant: tenants[index % tenants.length],
  owner: teams[(index + 2) % teams.length],
  exposure: [1, 5, 10, 25, 50, 100][index % 6],
  state: ["running", "paused", "completed"][index % 3],
  updatedAt: `2026-08-12T${String(8 + (index % 10)).padStart(2, "0")}:${String(
    (index * 7) % 60,
  ).padStart(2, "0")}:00+08:00`,
}));

const incidents = Array.from({ length: 24 }, (_, index) => ({
  id: `INC-2026-${String(8120 + index).padStart(5, "0")}`,
  service: services[(index * 5) % services.length],
  severity: severities[index % severities.length],
  phase: ["detected", "mitigating", "monitoring", "resolved"][index % 4],
  summary: [
    "Elevated p99 latency during regional failover",
    "Audit delivery lag exceeded the ten-minute SLO",
    "Canary error rate crossed the automatic pause threshold",
    "Policy cache served stale tenant constraints",
  ][index % 4],
}));

function htmlDocument() {
  const lines = [];
  lines.push("<!doctype html>");
  lines.push('<html lang="en" data-theme="kiron-light">');
  lines.push("  <head>");
  lines.push('    <meta charset="utf-8">');
  lines.push('    <meta name="viewport" content="width=device-width, initial-scale=1">');
  lines.push('    <meta name="color-scheme" content="light">');
  lines.push('    <meta name="description" content="Kiron Fleet Control Plane engineering fixture">');
  lines.push("    <title>Kiron Fleet Control Plane</title>");
  lines.push('    <link rel="stylesheet" href="./demo.css">');
  lines.push('    <script type="module" src="./demo.js"></script>');
  lines.push("  </head>");
  lines.push("  <body>");
  lines.push('    <a class="skip-link" href="#workspace">Skip to operations workspace</a>');
  lines.push('    <div class="app-shell" data-density="comfortable">');
  lines.push('      <header class="topbar">');
  lines.push('        <div class="brand-lockup" aria-label="Kiron Fleet Control Plane">');
  lines.push('          <span class="brand-mark" aria-hidden="true">K</span>');
  lines.push('          <span class="brand-copy">');
  lines.push('            <strong>Kiron Fleet</strong>');
  lines.push('            <small>Production control plane</small>');
  lines.push("          </span>");
  lines.push("        </div>");
  lines.push('        <form class="command-search" role="search">');
  lines.push('          <label class="sr-only" for="global-search">Search services and incidents</label>');
  lines.push('          <input id="global-search" name="q" type="search" placeholder="Search services, flags, incidents…" autocomplete="off">');
  lines.push('          <kbd aria-label="Command K">⌘ K</kbd>');
  lines.push("        </form>");
  lines.push('        <div class="topbar-actions">');
  lines.push('          <output class="environment-chip" aria-label="Current environment">production</output>');
  lines.push('          <button class="button button--quiet" type="button" data-open-dialog="command-palette">Commands</button>');
  lines.push('          <button class="avatar-button" type="button" aria-label="Open operator menu">KL</button>');
  lines.push("        </div>");
  lines.push("      </header>");
  lines.push('      <aside class="sidebar" aria-label="Primary navigation">');
  lines.push('        <nav class="primary-nav">');
  lines.push('          <a class="nav-item is-active" href="#overview" aria-current="page"><span>Overview</span><small>48</small></a>');
  lines.push('          <a class="nav-item" href="#services"><span>Services</span><small>48</small></a>');
  lines.push('          <a class="nav-item" href="#rollouts"><span>Rollouts</span><small>36</small></a>');
  lines.push('          <a class="nav-item" href="#incidents"><span>Incidents</span><small>24</small></a>');
  lines.push('          <a class="nav-item" href="#audit"><span>Audit</span><small>live</small></a>');
  lines.push("        </nav>");
  lines.push('        <section class="sidebar-summary" aria-labelledby="budget-title">');
  lines.push('          <h2 id="budget-title">Fleet error budget</h2>');
  lines.push('          <strong>91.4%</strong>');
  lines.push('          <meter min="0" max="100" low="30" high="70" optimum="100" value="91.4">91.4%</meter>');
  lines.push('          <p>Thirty-day rolling window</p>');
  lines.push("        </section>");
  lines.push("      </aside>");
  lines.push('      <main id="workspace" class="workspace" tabindex="-1">');
  lines.push('        <section id="overview" class="page-heading">');
  lines.push("          <div>");
  lines.push('            <p class="eyebrow">Wednesday, 12 August 2026</p>');
  lines.push("            <h1>Fleet overview</h1>");
  lines.push("            <p>Release health, tenant exposure, and incident response across four production regions.</p>");
  lines.push("          </div>");
  lines.push('          <div class="page-actions">');
  lines.push('            <button class="button button--secondary" type="button">Export snapshot</button>');
  lines.push('            <button class="button button--primary" type="button" data-open-dialog="new-rollout">Plan rollout</button>');
  lines.push("          </div>");
  lines.push("        </section>");
  lines.push('        <section class="metric-grid" aria-label="Fleet health metrics">');
  [
    ["Healthy services", "41 / 48", "+2 since 09:00", "positive"],
    ["Active rollouts", "18", "4 awaiting approval", "neutral"],
    ["Open incidents", "6", "1 critical", "negative"],
    ["Change success", "98.7%", "+0.4% this week", "positive"],
  ].forEach(([label, value, note, tone]) => {
    lines.push(`          <article class="metric-card" data-tone="${tone}">`);
    lines.push(`            <h2>${label}</h2>`);
    lines.push(`            <strong>${value}</strong>`);
    lines.push(`            <p>${note}</p>`);
    lines.push('            <span class="metric-sparkline" aria-hidden="true"></span>');
    lines.push("          </article>");
  });
  lines.push("        </section>");
  lines.push('        <section id="services" class="panel" aria-labelledby="services-title">');
  lines.push('          <header class="panel-header">');
  lines.push("            <div>");
  lines.push('              <p class="eyebrow">Runtime inventory</p>');
  lines.push('              <h2 id="services-title">Production services</h2>');
  lines.push("            </div>");
  lines.push('            <label class="inline-field">');
  lines.push('              <span>Filter</span>');
  lines.push('              <input type="search" name="service-filter" placeholder="Name, team, or region">');
  lines.push("            </label>");
  lines.push("          </header>");
  lines.push('          <div class="table-scroll" tabindex="0">');
  lines.push('            <table class="data-table">');
  lines.push("              <caption>Current service revisions and reliability indicators</caption>");
  lines.push("              <thead>");
  lines.push("                <tr>");
  lines.push('                  <th scope="col">Service</th>');
  lines.push('                  <th scope="col">Region</th>');
  lines.push('                  <th scope="col">Owner</th>');
  lines.push('                  <th scope="col">Revision</th>');
  lines.push('                  <th scope="col">p99</th>');
  lines.push('                  <th scope="col">Budget</th>');
  lines.push('                  <th scope="col">State</th>');
  lines.push('                  <th scope="col"><span class="sr-only">Actions</span></th>');
  lines.push("                </tr>");
  lines.push("              </thead>");
  lines.push("              <tbody>");
  services.forEach((service) => {
    lines.push(`                <tr id="service-${service.id}" data-state="${service.status}" data-region="${service.region}">`);
    lines.push("                  <th scope=\"row\">");
    lines.push(`                    <a href="#service-${service.id}">${service.name}</a>`);
    lines.push(`                    <small>${service.replicas} replicas</small>`);
    lines.push("                  </th>");
    lines.push(`                  <td><code>${service.region}</code></td>`);
    lines.push(`                  <td>${service.team}</td>`);
    lines.push(`                  <td><code>${service.version}</code></td>`);
    lines.push(`                  <td><data value="${service.latency}">${service.latency} ms</data></td>`);
    lines.push(`                  <td><meter min="0" max="100" low="30" high="70" optimum="100" value="${service.errorBudget}">${service.errorBudget}%</meter></td>`);
    lines.push(`                  <td><span class="status-badge status-badge--${service.status}">${service.status}</span></td>`);
    lines.push("                  <td>");
    lines.push(`                    <button class="icon-button" type="button" aria-label="Open actions for ${service.name} in ${service.region}">•••</button>`);
    lines.push("                  </td>");
    lines.push("                </tr>");
  });
  lines.push("              </tbody>");
  lines.push("            </table>");
  lines.push("          </div>");
  lines.push("        </section>");
  lines.push('        <section id="rollouts" class="panel" aria-labelledby="rollouts-title">');
  lines.push('          <header class="panel-header">');
  lines.push("            <div>");
  lines.push('              <p class="eyebrow">Progressive delivery</p>');
  lines.push('              <h2 id="rollouts-title">Tenant feature rollouts</h2>');
  lines.push("            </div>");
  lines.push('            <button class="button button--secondary" type="button">Review approvals</button>');
  lines.push("          </header>");
  lines.push('          <div class="rollout-grid">');
  flags.forEach((flag, index) => {
    lines.push(`            <article class="rollout-card" data-state="${flag.state}">`);
    lines.push('              <header class="rollout-card__header">');
    lines.push(`                <span class="status-badge status-badge--${flag.state}">${flag.state}</span>`);
    lines.push(`                <time datetime="${flag.updatedAt}">${flag.updatedAt.slice(11, 16)}</time>`);
    lines.push("              </header>");
    lines.push(`              <h3><code>${flag.key}</code></h3>`);
    lines.push(`              <p>Tenant <strong>${flag.tenant}</strong> · owner ${flag.owner}</p>`);
    lines.push(`              <label for="rollout-${index}">Exposure <output>${flag.exposure}%</output></label>`);
    lines.push(`              <progress id="rollout-${index}" max="100" value="${flag.exposure}">${flag.exposure}%</progress>`);
    lines.push('              <footer class="rollout-card__actions">');
    lines.push('                <button class="button button--quiet" type="button">Inspect</button>');
    lines.push('                <button class="button button--quiet" type="button">Pause</button>');
    lines.push("              </footer>");
    lines.push("            </article>");
  });
  lines.push("          </div>");
  lines.push("        </section>");
  lines.push('        <section id="incidents" class="panel" aria-labelledby="incidents-title">');
  lines.push('          <header class="panel-header">');
  lines.push("            <div>");
  lines.push('              <p class="eyebrow">Operational response</p>');
  lines.push('              <h2 id="incidents-title">Incident timeline</h2>');
  lines.push("            </div>");
  lines.push('            <button class="button button--secondary" type="button">Open runbooks</button>');
  lines.push("          </header>");
  lines.push('          <ol class="incident-list">');
  incidents.forEach((incident, index) => {
    const started = String(7 + (index % 11)).padStart(2, "0");
    lines.push(`            <li class="incident-item" data-severity="${incident.severity}">`);
    lines.push('              <span class="incident-marker" aria-hidden="true"></span>');
    lines.push("              <article>");
    lines.push('                <header class="incident-item__header">');
    lines.push(`                  <strong>${incident.id}</strong>`);
    lines.push(`                  <span class="status-badge status-badge--${incident.severity}">${incident.severity}</span>`);
    lines.push(`                  <time datetime="2026-08-12T${started}:00:00+08:00">${started}:00</time>`);
    lines.push("                </header>");
    lines.push(`                <h3>${incident.summary}</h3>`);
    lines.push(`                <p><a href="#service-${incident.service.id}">${incident.service.name}</a> in <code>${incident.service.region}</code> is ${incident.phase}.</p>`);
    lines.push('                <details>');
    lines.push('                  <summary>Operator notes</summary>');
    lines.push(`                  <p>Traffic was shifted to ${regions[(index + 1) % regions.length]}; automated rollback guard remains armed.</p>`);
    lines.push("                </details>");
    lines.push("              </article>");
    lines.push("            </li>");
  });
  lines.push("          </ol>");
  lines.push("        </section>");
  lines.push('        <section id="audit" class="panel" aria-labelledby="audit-title">');
  lines.push('          <header class="panel-header">');
  lines.push("            <div>");
  lines.push('              <p class="eyebrow">Immutable activity</p>');
  lines.push('              <h2 id="audit-title">Audit stream</h2>');
  lines.push("            </div>");
  lines.push('            <label class="switch"><input type="checkbox" checked><span>Follow live events</span></label>');
  lines.push("          </header>");
  lines.push('          <pre class="log-view" aria-label="Recent audit events"><code>');
  services.slice(0, 32).forEach((service, index) => {
    const minute = String((index * 3) % 60).padStart(2, "0");
    lines.push(`2026-08-12T16:${minute}:00+08:00 INFO rollout.observed service=${service.name} region=${service.region} revision=${service.version} state=${service.status}`);
  });
  lines.push("          </code></pre>");
  lines.push("        </section>");
  lines.push("      </main>");
  lines.push("    </div>");
  lines.push('    <dialog id="new-rollout" class="dialog">');
  lines.push('      <form method="dialog" class="dialog__surface">');
  lines.push('        <header><h2>Plan a progressive rollout</h2><button class="icon-button" value="cancel" aria-label="Close">×</button></header>');
  lines.push('        <label>Service<select name="service" required><option value="">Select a service</option><option>flag-evaluator</option><option>policy-engine</option></select></label>');
  lines.push('        <label>Initial exposure<input name="exposure" type="number" min="1" max="25" value="5" required></label>');
  lines.push('        <label>Change reason<textarea name="reason" rows="4" required></textarea></label>');
  lines.push('        <footer><button class="button button--quiet" value="cancel">Cancel</button><button class="button button--primary" value="default">Create plan</button></footer>');
  lines.push("      </form>");
  lines.push("    </dialog>");
  lines.push('    <template id="toast-template">');
  lines.push('      <output class="toast" role="status"><strong data-toast-title></strong><span data-toast-message></span></output>');
  lines.push("    </template>");
  lines.push("  </body>");
  lines.push("</html>");
  return `${lines.join("\n")}\n`;
}

function cssDocument() {
  const lines = [];
  lines.push("@layer reset, tokens, base, layout, components, utilities, overrides;");
  lines.push("");
  lines.push("@layer tokens {");
  lines.push("  :root {");
  const tokens = {
    "color-canvas": "#f8f8f8",
    "color-surface": "#ffffff",
    "color-surface-muted": "#f1f3f5",
    "color-surface-raised": "#fbfcfd",
    "color-border": "#c9ced4",
    "color-border-strong": "#8b949e",
    "color-text": "#30343b",
    "color-text-muted": "#59636e",
    "color-heading": "#101c32",
    "color-accent": "#0071e3",
    "color-accent-hover": "#0066cc",
    "color-accent-soft": "#dbeaff",
    "color-positive": "#14732d",
    "color-positive-soft": "#e2f4e6",
    "color-warning": "#8a5a00",
    "color-warning-soft": "#fff1c7",
    "color-negative": "#b42318",
    "color-negative-soft": "#fde8e7",
    "color-purple": "#7431b8",
    "color-purple-soft": "#f0e5fb",
    "shadow-sm": "0 1px 2px rgb(16 28 50 / 8%)",
    "shadow-md": "0 8px 24px rgb(16 28 50 / 12%)",
    "shadow-lg": "0 20px 54px rgb(16 28 50 / 16%)",
    "radius-xs": "4px",
    "radius-sm": "6px",
    "radius-md": "10px",
    "radius-lg": "16px",
    "radius-pill": "999px",
    "font-sans": 'Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    "font-mono": '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
    "text-xs": "0.75rem",
    "text-sm": "0.875rem",
    "text-md": "1rem",
    "text-lg": "1.25rem",
    "text-xl": "1.625rem",
    "text-2xl": "2.25rem",
    "line-tight": "1.2",
    "line-normal": "1.55",
    "duration-fast": "120ms",
    "duration-normal": "200ms",
    "ease-standard": "cubic-bezier(0.2, 0, 0, 1)",
    "sidebar-width": "16rem",
    "topbar-height": "4rem",
    "content-max": "104rem",
  };
  Object.entries(tokens).forEach(([name, value]) => {
    lines.push(`    --${name}: ${value};`);
  });
  for (let index = 0; index <= 32; index += 1) {
    lines.push(`    --space-${index}: ${(index * 0.25).toFixed(2).replace(/\.00$/, "")}rem;`);
  }
  for (let index = 1; index <= 12; index += 1) {
    lines.push(`    --column-${index}: repeat(${index}, minmax(0, 1fr));`);
  }
  lines.push("    color: var(--color-text);");
  lines.push("    background: var(--color-canvas);");
  lines.push("    font-family: var(--font-sans);");
  lines.push("  }");
  lines.push("}");
  lines.push("");
  lines.push("@layer reset {");
  lines.push("  *,");
  lines.push("  *::before,");
  lines.push("  *::after {");
  lines.push("    box-sizing: border-box;");
  lines.push("  }");
  lines.push("");
  lines.push("  html {");
  lines.push("    min-width: 20rem;");
  lines.push("    min-height: 100%;");
  lines.push("    font-size: 100%;");
  lines.push("    scroll-behavior: smooth;");
  lines.push("  }");
  lines.push("");
  lines.push("  body {");
  lines.push("    min-height: 100vh;");
  lines.push("    margin: 0;");
  lines.push("    color: var(--color-text);");
  lines.push("    background: var(--color-canvas);");
  lines.push("    font: var(--text-sm) / var(--line-normal) var(--font-sans);");
  lines.push("    text-rendering: optimizeLegibility;");
  lines.push("  }");
  lines.push("");
  lines.push("  button,");
  lines.push("  input,");
  lines.push("  select,");
  lines.push("  textarea {");
  lines.push("    font: inherit;");
  lines.push("  }");
  lines.push("");
  lines.push("  button,");
  lines.push("  select {");
  lines.push("    cursor: pointer;");
  lines.push("  }");
  lines.push("");
  lines.push("  img,");
  lines.push("  svg {");
  lines.push("    display: block;");
  lines.push("    max-width: 100%;");
  lines.push("  }");
  lines.push("");
  lines.push("  table {");
  lines.push("    border-collapse: collapse;");
  lines.push("    border-spacing: 0;");
  lines.push("  }");
  lines.push("}");
  lines.push("");
  lines.push("@layer base {");
  lines.push("  :focus-visible {");
  lines.push("    outline: 2px solid var(--color-accent);");
  lines.push("    outline-offset: 3px;");
  lines.push("  }");
  lines.push("");
  lines.push("  ::selection {");
  lines.push("    color: var(--color-heading);");
  lines.push("    background: var(--color-accent-soft);");
  lines.push("  }");
  lines.push("");
  lines.push("  a {");
  lines.push("    color: var(--color-accent);");
  lines.push("    text-decoration-thickness: 0.08em;");
  lines.push("    text-underline-offset: 0.18em;");
  lines.push("  }");
  lines.push("");
  lines.push("  a:hover {");
  lines.push("    color: var(--color-accent-hover);");
  lines.push("  }");
  lines.push("");
  lines.push("  h1,");
  lines.push("  h2,");
  lines.push("  h3 {");
  lines.push("    margin-block: 0;");
  lines.push("    color: var(--color-heading);");
  lines.push("    font-weight: 650;");
  lines.push("    line-height: var(--line-tight);");
  lines.push("    text-wrap: balance;");
  lines.push("  }");
  lines.push("");
  lines.push("  p {");
  lines.push("    margin-block: 0;");
  lines.push("  }");
  lines.push("");
  lines.push("  code,");
  lines.push("  kbd,");
  lines.push("  pre {");
  lines.push("    font-family: var(--font-mono);");
  lines.push("    font-variant-ligatures: none;");
  lines.push("  }");
  lines.push("");
  lines.push("  code {");
  lines.push("    border: 1px solid color-mix(in srgb, var(--color-border), transparent 24%);");
  lines.push("    border-radius: var(--radius-xs);");
  lines.push("    padding: 0.12em 0.35em;");
  lines.push("    color: var(--color-heading);");
  lines.push("    background: var(--color-surface-muted);");
  lines.push("  }");
  lines.push("}");
  lines.push("");
  lines.push("@layer layout {");
  lines.push("  .app-shell {");
  lines.push("    display: grid;");
  lines.push("    grid-template:");
  lines.push('      "topbar topbar" var(--topbar-height)');
  lines.push('      "sidebar workspace" minmax(calc(100vh - var(--topbar-height)), auto)');
  lines.push("      / var(--sidebar-width) minmax(0, 1fr);");
  lines.push("  }");
  lines.push("");
  lines.push("  .topbar {");
  lines.push("    position: sticky;");
  lines.push("    z-index: 30;");
  lines.push("    top: 0;");
  lines.push("    grid-area: topbar;");
  lines.push("    display: grid;");
  lines.push("    grid-template-columns: minmax(12rem, var(--sidebar-width)) minmax(18rem, 42rem) auto;");
  lines.push("    align-items: center;");
  lines.push("    gap: var(--space-5);");
  lines.push("    min-height: var(--topbar-height);");
  lines.push("    padding-inline: var(--space-5);");
  lines.push("    border-bottom: 1px solid var(--color-border);");
  lines.push("    background: color-mix(in srgb, var(--color-surface), transparent 4%);");
  lines.push("    backdrop-filter: blur(16px) saturate(120%);");
  lines.push("  }");
  lines.push("");
  lines.push("  .sidebar {");
  lines.push("    position: sticky;");
  lines.push("    top: var(--topbar-height);");
  lines.push("    grid-area: sidebar;");
  lines.push("    display: flex;");
  lines.push("    flex-direction: column;");
  lines.push("    gap: var(--space-6);");
  lines.push("    height: calc(100vh - var(--topbar-height));");
  lines.push("    padding: var(--space-5) var(--space-3);");
  lines.push("    overflow: auto;");
  lines.push("    border-right: 1px solid var(--color-border);");
  lines.push("    background: var(--color-surface-muted);");
  lines.push("  }");
  lines.push("");
  lines.push("  .workspace {");
  lines.push("    grid-area: workspace;");
  lines.push("    display: grid;");
  lines.push("    gap: var(--space-6);");
  lines.push("    width: min(100%, var(--content-max));");
  lines.push("    margin-inline: auto;");
  lines.push("    padding: var(--space-8);");
  lines.push("  }");
  lines.push("");
  lines.push("  .metric-grid {");
  lines.push("    display: grid;");
  lines.push("    grid-template-columns: repeat(4, minmax(12rem, 1fr));");
  lines.push("    gap: var(--space-4);");
  lines.push("  }");
  lines.push("");
  lines.push("  .rollout-grid {");
  lines.push("    display: grid;");
  lines.push("    grid-template-columns: repeat(auto-fill, minmax(18rem, 1fr));");
  lines.push("    gap: var(--space-4);");
  lines.push("    padding: var(--space-5);");
  lines.push("    container: rollout-grid / inline-size;");
  lines.push("  }");
  lines.push("}");
  lines.push("");
  lines.push("@layer components {");
  lines.push("  .skip-link {");
  lines.push("    position: fixed;");
  lines.push("    z-index: 100;");
  lines.push("    inset: var(--space-2) auto auto var(--space-2);");
  lines.push("    padding: var(--space-2) var(--space-3);");
  lines.push("    border-radius: var(--radius-sm);");
  lines.push("    color: white;");
  lines.push("    background: var(--color-heading);");
  lines.push("    translate: 0 -160%;");
  lines.push("    transition: translate var(--duration-fast) var(--ease-standard);");
  lines.push("  }");
  lines.push("");
  lines.push("  .skip-link:focus {");
  lines.push("    translate: 0 0;");
  lines.push("  }");
  lines.push("");
  lines.push("  .brand-lockup {");
  lines.push("    display: inline-flex;");
  lines.push("    align-items: center;");
  lines.push("    gap: var(--space-3);");
  lines.push("    min-width: 0;");
  lines.push("  }");
  lines.push("");
  lines.push("  .brand-mark {");
  lines.push("    display: grid;");
  lines.push("    width: 2.25rem;");
  lines.push("    aspect-ratio: 1;");
  lines.push("    place-items: center;");
  lines.push("    border-radius: 28% 28% 42% 28%;");
  lines.push("    color: white;");
  lines.push("    background: linear-gradient(145deg, #0a84ff, #0066d6 62%, #5e5ce6);");
  lines.push("    box-shadow: var(--shadow-sm);");
  lines.push("    font-weight: 760;");
  lines.push("  }");
  lines.push("");
  lines.push("  .brand-copy {");
  lines.push("    display: grid;");
  lines.push("    min-width: 0;");
  lines.push("  }");
  lines.push("");
  lines.push("  .brand-copy small {");
  lines.push("    color: var(--color-text-muted);");
  lines.push("  }");
  lines.push("");
  lines.push("  .command-search {");
  lines.push("    display: grid;");
  lines.push("    grid-template-columns: minmax(0, 1fr) auto;");
  lines.push("    align-items: center;");
  lines.push("    gap: var(--space-2);");
  lines.push("    padding-inline: var(--space-3);");
  lines.push("    border: 1px solid var(--color-border);");
  lines.push("    border-radius: var(--radius-md);");
  lines.push("    background: var(--color-surface-muted);");
  lines.push("    transition: border-color var(--duration-fast), box-shadow var(--duration-fast);");
  lines.push("  }");
  lines.push("");
  lines.push("  .command-search:focus-within {");
  lines.push("    border-color: var(--color-accent);");
  lines.push("    box-shadow: 0 0 0 3px color-mix(in srgb, var(--color-accent), transparent 82%);");
  lines.push("  }");
  lines.push("");
  lines.push("  .command-search input {");
  lines.push("    min-width: 0;");
  lines.push("    padding-block: var(--space-2);");
  lines.push("    border: 0;");
  lines.push("    outline: 0;");
  lines.push("    color: var(--color-text);");
  lines.push("    background: transparent;");
  lines.push("  }");
  lines.push("");
  lines.push("  .command-search kbd {");
  lines.push("    padding: 0.1rem 0.4rem;");
  lines.push("    border: 1px solid var(--color-border);");
  lines.push("    border-bottom-color: var(--color-border-strong);");
  lines.push("    border-radius: var(--radius-xs);");
  lines.push("    color: var(--color-text-muted);");
  lines.push("    background: var(--color-surface);");
  lines.push("    box-shadow: var(--shadow-sm);");
  lines.push("    font-size: var(--text-xs);");
  lines.push("  }");
  lines.push("");
  lines.push("  .topbar-actions,");
  lines.push("  .page-actions,");
  lines.push("  .rollout-card__actions {");
  lines.push("    display: flex;");
  lines.push("    align-items: center;");
  lines.push("    justify-content: flex-end;");
  lines.push("    gap: var(--space-2);");
  lines.push("  }");
  lines.push("");
  lines.push("  .environment-chip,");
  lines.push("  .status-badge {");
  lines.push("    display: inline-flex;");
  lines.push("    align-items: center;");
  lines.push("    width: fit-content;");
  lines.push("    border-radius: var(--radius-pill);");
  lines.push("    font-size: var(--text-xs);");
  lines.push("    font-weight: 650;");
  lines.push("    letter-spacing: 0.01em;");
  lines.push("    text-transform: capitalize;");
  lines.push("  }");
  lines.push("");
  lines.push("  .environment-chip {");
  lines.push("    padding: 0.3rem 0.65rem;");
  lines.push("    color: var(--color-purple);");
  lines.push("    background: var(--color-purple-soft);");
  lines.push("  }");
  lines.push("");
  lines.push("  .avatar-button,");
  lines.push("  .icon-button {");
  lines.push("    display: inline-grid;");
  lines.push("    place-items: center;");
  lines.push("    border: 1px solid transparent;");
  lines.push("    border-radius: var(--radius-pill);");
  lines.push("    color: var(--color-heading);");
  lines.push("    background: transparent;");
  lines.push("  }");
  lines.push("");
  lines.push("  .avatar-button {");
  lines.push("    width: 2.25rem;");
  lines.push("    aspect-ratio: 1;");
  lines.push("    color: white;");
  lines.push("    background: var(--color-heading);");
  lines.push("    font-size: var(--text-xs);");
  lines.push("    font-weight: 700;");
  lines.push("  }");
  lines.push("");
  lines.push("  .icon-button {");
  lines.push("    min-width: 2rem;");
  lines.push("    min-height: 2rem;");
  lines.push("  }");
  lines.push("");
  lines.push("  .icon-button:hover {");
  lines.push("    border-color: var(--color-border);");
  lines.push("    background: var(--color-surface-muted);");
  lines.push("  }");
  lines.push("");
  lines.push("  .primary-nav {");
  lines.push("    display: grid;");
  lines.push("    gap: var(--space-1);");
  lines.push("  }");
  lines.push("");
  lines.push("  .nav-item {");
  lines.push("    display: flex;");
  lines.push("    align-items: center;");
  lines.push("    justify-content: space-between;");
  lines.push("    gap: var(--space-3);");
  lines.push("    padding: var(--space-2) var(--space-3);");
  lines.push("    border-radius: var(--radius-sm);");
  lines.push("    color: var(--color-text);");
  lines.push("    text-decoration: none;");
  lines.push("  }");
  lines.push("");
  lines.push("  .nav-item:hover {");
  lines.push("    background: color-mix(in srgb, var(--color-border), transparent 60%);");
  lines.push("  }");
  lines.push("");
  lines.push("  .nav-item.is-active {");
  lines.push("    color: var(--color-heading);");
  lines.push("    background: var(--color-accent-soft);");
  lines.push("    font-weight: 650;");
  lines.push("  }");
  lines.push("");
  lines.push("  .nav-item small {");
  lines.push("    color: var(--color-text-muted);");
  lines.push("  }");
  lines.push("");
  lines.push("  .sidebar-summary {");
  lines.push("    display: grid;");
  lines.push("    gap: var(--space-2);");
  lines.push("    margin-top: auto;");
  lines.push("    padding: var(--space-4);");
  lines.push("    border: 1px solid var(--color-border);");
  lines.push("    border-radius: var(--radius-md);");
  lines.push("    background: var(--color-surface);");
  lines.push("  }");
  lines.push("");
  lines.push("  .sidebar-summary h2 {");
  lines.push("    font-size: var(--text-sm);");
  lines.push("  }");
  lines.push("");
  lines.push("  .sidebar-summary strong {");
  lines.push("    color: var(--color-heading);");
  lines.push("    font-size: var(--text-xl);");
  lines.push("  }");
  lines.push("");
  lines.push("  .sidebar-summary p {");
  lines.push("    color: var(--color-text-muted);");
  lines.push("    font-size: var(--text-xs);");
  lines.push("  }");
  lines.push("");
  lines.push("  .page-heading,");
  lines.push("  .panel-header {");
  lines.push("    display: flex;");
  lines.push("    align-items: center;");
  lines.push("    justify-content: space-between;");
  lines.push("    gap: var(--space-5);");
  lines.push("  }");
  lines.push("");
  lines.push("  .page-heading h1 {");
  lines.push("    margin-top: var(--space-1);");
  lines.push("    font-size: var(--text-2xl);");
  lines.push("  }");
  lines.push("");
  lines.push("  .page-heading p:not(.eyebrow) {");
  lines.push("    margin-top: var(--space-2);");
  lines.push("    color: var(--color-text-muted);");
  lines.push("  }");
  lines.push("");
  lines.push("  .eyebrow {");
  lines.push("    color: var(--color-accent);");
  lines.push("    font-size: var(--text-xs);");
  lines.push("    font-weight: 700;");
  lines.push("    letter-spacing: 0.08em;");
  lines.push("    text-transform: uppercase;");
  lines.push("  }");
  lines.push("");
  lines.push("  .button {");
  lines.push("    min-height: 2.25rem;");
  lines.push("    padding: 0.45rem 0.85rem;");
  lines.push("    border: 1px solid transparent;");
  lines.push("    border-radius: var(--radius-sm);");
  lines.push("    font-weight: 620;");
  lines.push("    transition: background var(--duration-fast), border-color var(--duration-fast), translate var(--duration-fast);");
  lines.push("  }");
  lines.push("");
  lines.push("  .button:active:not(:disabled) {");
  lines.push("    translate: 0 1px;");
  lines.push("  }");
  lines.push("");
  lines.push("  .button:disabled {");
  lines.push("    cursor: not-allowed;");
  lines.push("    opacity: 0.52;");
  lines.push("  }");
  lines.push("");
  lines.push("  .button--primary {");
  lines.push("    color: white;");
  lines.push("    background: var(--color-accent);");
  lines.push("  }");
  lines.push("");
  lines.push("  .button--primary:hover {");
  lines.push("    background: var(--color-accent-hover);");
  lines.push("  }");
  lines.push("");
  lines.push("  .button--secondary {");
  lines.push("    border-color: var(--color-border);");
  lines.push("    color: var(--color-heading);");
  lines.push("    background: var(--color-surface);");
  lines.push("  }");
  lines.push("");
  lines.push("  .button--quiet {");
  lines.push("    color: var(--color-accent);");
  lines.push("    background: transparent;");
  lines.push("  }");
  lines.push("");
  lines.push("  .button--quiet:hover {");
  lines.push("    background: var(--color-accent-soft);");
  lines.push("  }");
  lines.push("");
  lines.push("  .metric-card,");
  lines.push("  .panel,");
  lines.push("  .rollout-card {");
  lines.push("    border: 1px solid var(--color-border);");
  lines.push("    background: var(--color-surface);");
  lines.push("    box-shadow: var(--shadow-sm);");
  lines.push("  }");
  lines.push("");
  lines.push("  .metric-card {");
  lines.push("    position: relative;");
  lines.push("    display: grid;");
  lines.push("    gap: var(--space-2);");
  lines.push("    min-height: 9rem;");
  lines.push("    padding: var(--space-5);");
  lines.push("    overflow: hidden;");
  lines.push("    border-radius: var(--radius-md);");
  lines.push("  }");
  lines.push("");
  lines.push("  .metric-card h2 {");
  lines.push("    font-size: var(--text-sm);");
  lines.push("  }");
  lines.push("");
  lines.push("  .metric-card strong {");
  lines.push("    color: var(--color-heading);");
  lines.push("    font-size: var(--text-xl);");
  lines.push("  }");
  lines.push("");
  lines.push("  .metric-card p {");
  lines.push("    color: var(--color-text-muted);");
  lines.push("  }");
  lines.push("");
  lines.push("  .metric-sparkline {");
  lines.push("    position: absolute;");
  lines.push("    inset: auto -1rem -2rem 42%;");
  lines.push("    height: 5rem;");
  lines.push("    border: 2px solid currentColor;");
  lines.push("    border-width: 2px 0 0;");
  lines.push("    border-radius: 55% 45% 0 0;");
  lines.push("    opacity: 0.22;");
  lines.push("    rotate: -8deg;");
  lines.push("  }");
  lines.push("");
  lines.push("  .metric-card[data-tone=\"positive\"] {");
  lines.push("    color: var(--color-positive);");
  lines.push("  }");
  lines.push("");
  lines.push("  .metric-card[data-tone=\"negative\"] {");
  lines.push("    color: var(--color-negative);");
  lines.push("  }");
  lines.push("");
  lines.push("  .metric-card[data-tone=\"neutral\"] {");
  lines.push("    color: var(--color-accent);");
  lines.push("  }");
  lines.push("");
  lines.push("  .panel {");
  lines.push("    min-width: 0;");
  lines.push("    overflow: clip;");
  lines.push("    border-radius: var(--radius-lg);");
  lines.push("  }");
  lines.push("");
  lines.push("  .panel-header {");
  lines.push("    padding: var(--space-5);");
  lines.push("    border-bottom: 1px solid var(--color-border);");
  lines.push("  }");
  lines.push("");
  lines.push("  .panel-header h2 {");
  lines.push("    margin-top: var(--space-1);");
  lines.push("    font-size: var(--text-lg);");
  lines.push("  }");
  lines.push("");
  lines.push("  .inline-field {");
  lines.push("    display: flex;");
  lines.push("    align-items: center;");
  lines.push("    gap: var(--space-2);");
  lines.push("    color: var(--color-text-muted);");
  lines.push("  }");
  lines.push("");
  lines.push("  input,");
  lines.push("  select,");
  lines.push("  textarea {");
  lines.push("    min-height: 2.25rem;");
  lines.push("    padding: 0.45rem 0.65rem;");
  lines.push("    border: 1px solid var(--color-border);");
  lines.push("    border-radius: var(--radius-sm);");
  lines.push("    color: var(--color-text);");
  lines.push("    background: var(--color-surface);");
  lines.push("  }");
  lines.push("");
  lines.push("  input:user-invalid,");
  lines.push("  select:user-invalid,");
  lines.push("  textarea:user-invalid {");
  lines.push("    border-color: var(--color-negative);");
  lines.push("  }");
  lines.push("");
  lines.push("  .table-scroll {");
  lines.push("    max-width: 100%;");
  lines.push("    overflow: auto;");
  lines.push("  }");
  lines.push("");
  lines.push("  .data-table {");
  lines.push("    width: 100%;");
  lines.push("    min-width: 68rem;");
  lines.push("  }");
  lines.push("");
  lines.push("  .data-table caption {");
  lines.push("    position: absolute;");
  lines.push("    width: 1px;");
  lines.push("    height: 1px;");
  lines.push("    overflow: hidden;");
  lines.push("    clip-path: inset(50%);");
  lines.push("  }");
  lines.push("");
  lines.push("  .data-table th,");
  lines.push("  .data-table td {");
  lines.push("    padding: var(--space-3) var(--space-4);");
  lines.push("    border-bottom: 1px solid var(--color-border);");
  lines.push("    text-align: left;");
  lines.push("    vertical-align: middle;");
  lines.push("    white-space: nowrap;");
  lines.push("  }");
  lines.push("");
  lines.push("  .data-table thead th {");
  lines.push("    position: sticky;");
  lines.push("    z-index: 1;");
  lines.push("    top: 0;");
  lines.push("    color: var(--color-text-muted);");
  lines.push("    background: var(--color-surface-raised);");
  lines.push("    font-size: var(--text-xs);");
  lines.push("    letter-spacing: 0.03em;");
  lines.push("    text-transform: uppercase;");
  lines.push("  }");
  lines.push("");
  lines.push("  .data-table tbody tr:hover {");
  lines.push("    background: color-mix(in srgb, var(--color-accent-soft), transparent 42%);");
  lines.push("  }");
  lines.push("");
  lines.push("  .data-table tbody th {");
  lines.push("    display: grid;");
  lines.push("    gap: 0.15rem;");
  lines.push("  }");
  lines.push("");
  lines.push("  .data-table tbody th small {");
  lines.push("    color: var(--color-text-muted);");
  lines.push("    font-weight: 400;");
  lines.push("  }");
  lines.push("");
  lines.push("  meter,");
  lines.push("  progress {");
  lines.push("    width: 100%;");
  lines.push("    height: 0.55rem;");
  lines.push("    border: 0;");
  lines.push("    border-radius: var(--radius-pill);");
  lines.push("    overflow: hidden;");
  lines.push("    accent-color: var(--color-accent);");
  lines.push("  }");
  lines.push("");
  lines.push("  .rollout-card {");
  lines.push("    display: grid;");
  lines.push("    gap: var(--space-3);");
  lines.push("    padding: var(--space-4);");
  lines.push("    border-radius: var(--radius-md);");
  lines.push("    transition: border-color var(--duration-fast), box-shadow var(--duration-fast), translate var(--duration-fast);");
  lines.push("  }");
  lines.push("");
  lines.push("  .rollout-card:hover {");
  lines.push("    border-color: var(--color-border-strong);");
  lines.push("    box-shadow: var(--shadow-md);");
  lines.push("    translate: 0 -1px;");
  lines.push("  }");
  lines.push("");
  lines.push("  .rollout-card__header,");
  lines.push("  .incident-item__header {");
  lines.push("    display: flex;");
  lines.push("    align-items: center;");
  lines.push("    justify-content: space-between;");
  lines.push("    gap: var(--space-2);");
  lines.push("  }");
  lines.push("");
  lines.push("  .rollout-card h3 {");
  lines.push("    font-size: var(--text-sm);");
  lines.push("    overflow-wrap: anywhere;");
  lines.push("  }");
  lines.push("");
  lines.push("  .rollout-card label {");
  lines.push("    display: flex;");
  lines.push("    justify-content: space-between;");
  lines.push("    color: var(--color-text-muted);");
  lines.push("    font-size: var(--text-xs);");
  lines.push("  }");
  lines.push("");
  lines.push("  .incident-list {");
  lines.push("    display: grid;");
  lines.push("    gap: 0;");
  lines.push("    margin: 0;");
  lines.push("    padding: var(--space-5);");
  lines.push("    list-style: none;");
  lines.push("  }");
  lines.push("");
  lines.push("  .incident-item {");
  lines.push("    display: grid;");
  lines.push("    grid-template-columns: auto minmax(0, 1fr);");
  lines.push("    gap: var(--space-4);");
  lines.push("    padding-bottom: var(--space-5);");
  lines.push("  }");
  lines.push("");
  lines.push("  .incident-marker {");
  lines.push("    width: 0.8rem;");
  lines.push("    height: 0.8rem;");
  lines.push("    margin-top: 0.35rem;");
  lines.push("    border: 3px solid var(--color-surface);");
  lines.push("    border-radius: 50%;");
  lines.push("    background: currentColor;");
  lines.push("    box-shadow: 0 0 0 1px currentColor;");
  lines.push("  }");
  lines.push("");
  lines.push("  .incident-item article {");
  lines.push("    display: grid;");
  lines.push("    gap: var(--space-2);");
  lines.push("    padding-bottom: var(--space-5);");
  lines.push("    border-bottom: 1px solid var(--color-border);");
  lines.push("  }");
  lines.push("");
  lines.push("  .incident-item details {");
  lines.push("    color: var(--color-text-muted);");
  lines.push("  }");
  lines.push("");
  lines.push("  .log-view {");
  lines.push("    max-height: 32rem;");
  lines.push("    margin: 0;");
  lines.push("    padding: var(--space-5);");
  lines.push("    overflow: auto;");
  lines.push("    color: #d8dee9;");
  lines.push("    background: #18212f;");
  lines.push("    font-size: var(--text-xs);");
  lines.push("    line-height: 1.7;");
  lines.push("  }");
  lines.push("");
  lines.push("  .log-view code {");
  lines.push("    padding: 0;");
  lines.push("    border: 0;");
  lines.push("    color: inherit;");
  lines.push("    background: transparent;");
  lines.push("  }");
  lines.push("");
  lines.push("  .switch {");
  lines.push("    display: inline-flex;");
  lines.push("    align-items: center;");
  lines.push("    gap: var(--space-2);");
  lines.push("    color: var(--color-text-muted);");
  lines.push("  }");
  lines.push("");
  lines.push("  .dialog {");
  lines.push("    width: min(36rem, calc(100% - 2rem));");
  lines.push("    padding: 0;");
  lines.push("    border: 0;");
  lines.push("    border-radius: var(--radius-lg);");
  lines.push("    box-shadow: var(--shadow-lg);");
  lines.push("  }");
  lines.push("");
  lines.push("  .dialog::backdrop {");
  lines.push("    background: rgb(16 28 50 / 42%);");
  lines.push("    backdrop-filter: blur(3px);");
  lines.push("  }");
  lines.push("");
  lines.push("  .dialog__surface {");
  lines.push("    display: grid;");
  lines.push("    gap: var(--space-4);");
  lines.push("    padding: var(--space-6);");
  lines.push("  }");
  lines.push("");
  lines.push("  .dialog__surface > label {");
  lines.push("    display: grid;");
  lines.push("    gap: var(--space-2);");
  lines.push("    color: var(--color-heading);");
  lines.push("    font-weight: 620;");
  lines.push("  }");
  lines.push("");
  lines.push("  .dialog__surface > header,");
  lines.push("  .dialog__surface > footer {");
  lines.push("    display: flex;");
  lines.push("    align-items: center;");
  lines.push("    justify-content: space-between;");
  lines.push("    gap: var(--space-3);");
  lines.push("  }");
  lines.push("");
  lines.push("  .toast {");
  lines.push("    position: fixed;");
  lines.push("    z-index: 80;");
  lines.push("    right: var(--space-5);");
  lines.push("    bottom: var(--space-5);");
  lines.push("    display: grid;");
  lines.push("    gap: var(--space-1);");
  lines.push("    max-width: 26rem;");
  lines.push("    padding: var(--space-4);");
  lines.push("    border: 1px solid var(--color-border);");
  lines.push("    border-radius: var(--radius-md);");
  lines.push("    background: var(--color-surface);");
  lines.push("    box-shadow: var(--shadow-lg);");
  lines.push("  }");
  lines.push("}");
  lines.push("");
  lines.push("@layer utilities {");
  lines.push("  .sr-only {");
  lines.push("    position: absolute;");
  lines.push("    width: 1px;");
  lines.push("    height: 1px;");
  lines.push("    padding: 0;");
  lines.push("    margin: -1px;");
  lines.push("    overflow: hidden;");
  lines.push("    clip: rect(0, 0, 0, 0);");
  lines.push("    white-space: nowrap;");
  lines.push("    border: 0;");
  lines.push("  }");
  lines.push("");
  const statusPalette = {
    healthy: ["var(--color-positive)", "var(--color-positive-soft)"],
    deploying: ["var(--color-accent)", "var(--color-accent-soft)"],
    degraded: ["var(--color-warning)", "var(--color-warning-soft)"],
    paused: ["var(--color-text-muted)", "var(--color-surface-muted)"],
    running: ["var(--color-accent)", "var(--color-accent-soft)"],
    completed: ["var(--color-positive)", "var(--color-positive-soft)"],
    info: ["var(--color-accent)", "var(--color-accent-soft)"],
    warning: ["var(--color-warning)", "var(--color-warning-soft)"],
    critical: ["var(--color-negative)", "var(--color-negative-soft)"],
    resolved: ["var(--color-positive)", "var(--color-positive-soft)"],
  };
  Object.entries(statusPalette).forEach(([name, [foreground, background]]) => {
    lines.push(`  .status-badge--${name} {`);
    lines.push("    padding: 0.25rem 0.55rem;");
    lines.push(`    color: ${foreground};`);
    lines.push(`    background: ${background};`);
    lines.push("  }");
    lines.push("");
    lines.push(`  [data-severity=\"${name}\"] {`);
    lines.push(`    color: ${foreground};`);
    lines.push("  }");
    lines.push("");
  });
  for (let index = 0; index <= 32; index += 1) {
    lines.push(`  .m-${index} {`);
    lines.push(`    margin: var(--space-${index});`);
    lines.push("  }");
    lines.push("");
    lines.push(`  .mt-${index} {`);
    lines.push(`    margin-top: var(--space-${index});`);
    lines.push("  }");
    lines.push("");
    lines.push(`  .mb-${index} {`);
    lines.push(`    margin-bottom: var(--space-${index});`);
    lines.push("  }");
    lines.push("");
    lines.push(`  .p-${index} {`);
    lines.push(`    padding: var(--space-${index});`);
    lines.push("  }");
    lines.push("");
    lines.push(`  .gap-${index} {`);
    lines.push(`    gap: var(--space-${index});`);
    lines.push("  }");
    lines.push("");
  }
  for (let index = 1; index <= 12; index += 1) {
    lines.push(`  .grid-cols-${index} {`);
    lines.push(`    grid-template-columns: var(--column-${index});`);
    lines.push("  }");
    lines.push("");
    lines.push(`  .col-span-${index} {`);
    lines.push(`    grid-column: span ${index} / span ${index};`);
    lines.push("  }");
    lines.push("");
  }
  lines.push("}");
  lines.push("");
  lines.push("@container rollout-grid (width < 48rem) {");
  lines.push("  .rollout-card__actions {");
  lines.push("    justify-content: stretch;");
  lines.push("  }");
  lines.push("");
  lines.push("  .rollout-card__actions .button {");
  lines.push("    flex: 1;");
  lines.push("  }");
  lines.push("}");
  lines.push("");
  lines.push("@supports not (backdrop-filter: blur(1px)) {");
  lines.push("  .topbar {");
  lines.push("    background: var(--color-surface);");
  lines.push("  }");
  lines.push("}");
  lines.push("");
  lines.push("@media (width < 78rem) {");
  lines.push("  .metric-grid {");
  lines.push("    grid-template-columns: repeat(2, minmax(12rem, 1fr));");
  lines.push("  }");
  lines.push("");
  lines.push("  .topbar {");
  lines.push("    grid-template-columns: auto minmax(16rem, 1fr) auto;");
  lines.push("  }");
  lines.push("}");
  lines.push("");
  lines.push("@media (width < 52rem) {");
  lines.push("  .app-shell {");
  lines.push("    grid-template:");
  lines.push('      "topbar" auto');
  lines.push('      "workspace" auto');
  lines.push("      / minmax(0, 1fr);");
  lines.push("  }");
  lines.push("");
  lines.push("  .topbar {");
  lines.push("    position: static;");
  lines.push("    grid-template-columns: 1fr auto;");
  lines.push("    padding-block: var(--space-3);");
  lines.push("  }");
  lines.push("");
  lines.push("  .command-search {");
  lines.push("    grid-column: 1 / -1;");
  lines.push("    grid-row: 2;");
  lines.push("  }");
  lines.push("");
  lines.push("  .sidebar {");
  lines.push("    display: none;");
  lines.push("  }");
  lines.push("");
  lines.push("  .workspace {");
  lines.push("    padding: var(--space-4);");
  lines.push("  }");
  lines.push("");
  lines.push("  .page-heading,");
  lines.push("  .panel-header {");
  lines.push("    align-items: flex-start;");
  lines.push("    flex-direction: column;");
  lines.push("  }");
  lines.push("");
  lines.push("  .metric-grid {");
  lines.push("    grid-template-columns: minmax(0, 1fr);");
  lines.push("  }");
  lines.push("}");
  lines.push("");
  lines.push("@media (prefers-reduced-motion: reduce) {");
  lines.push("  *,");
  lines.push("  *::before,");
  lines.push("  *::after {");
  lines.push("    scroll-behavior: auto !important;");
  lines.push("    transition-duration: 0.01ms !important;");
  lines.push("    animation-duration: 0.01ms !important;");
  lines.push("    animation-iteration-count: 1 !important;");
  lines.push("  }");
  lines.push("}");
  lines.push("");
  lines.push("@media (prefers-contrast: more) {");
  lines.push("  :root {");
  lines.push("    --color-border: #6a737d;");
  lines.push("    --color-text-muted: #3d4650;");
  lines.push("  }");
  lines.push("");
  lines.push("  .button,");
  lines.push("  input,");
  lines.push("  select,");
  lines.push("  textarea {");
  lines.push("    border-width: 2px;");
  lines.push("  }");
  lines.push("}");
  lines.push("");
  lines.push("@media print {");
  lines.push("  .topbar,");
  lines.push("  .sidebar,");
  lines.push("  .page-actions,");
  lines.push("  .button,");
  lines.push("  .icon-button {");
  lines.push("    display: none !important;");
  lines.push("  }");
  lines.push("");
  lines.push("  .app-shell,");
  lines.push("  .workspace {");
  lines.push("    display: block;");
  lines.push("    width: auto;");
  lines.push("    max-width: none;");
  lines.push("    padding: 0;");
  lines.push("  }");
  lines.push("");
  lines.push("  .panel,");
  lines.push("  .metric-card {");
  lines.push("    break-inside: avoid;");
  lines.push("    box-shadow: none;");
  lines.push("  }");
  lines.push("}");
  return `${lines.join("\n")}\n`;
}

function markdownDocument() {
  const lines = [];
  lines.push("---");
  lines.push("title: Kiron Fleet Control Plane Engineering Handbook");
  lines.push("owner: release-platform");
  lines.push("classification: internal-test-fixture");
  lines.push("last_reviewed: 2026-08-12");
  lines.push("review_interval_days: 30");
  lines.push("---");
  lines.push("");
  lines.push("# Kiron Fleet Control Plane engineering handbook");
  lines.push("");
  lines.push("> [!NOTE]");
  lines.push("> This is an original, deterministic theme fixture. It models a realistic multi-tenant release control plane without containing production secrets or copied runbooks.");
  lines.push("");
  lines.push("## 1. Mission and operating boundaries");
  lines.push("");
  lines.push("Kiron Fleet coordinates progressive delivery across four regions. It evaluates tenant policy, creates immutable release plans, observes service-level indicators, pauses unsafe changes, and records every operator decision in the audit ledger.");
  lines.push("");
  lines.push("The control plane never proxies customer traffic. Data-plane services continue serving the last accepted configuration when Kiron is unavailable. This separation keeps a control-plane incident from becoming an immediate request-path outage.");
  lines.push("");
  lines.push("### Reliability objectives");
  lines.push("");
  lines.push("| Capability | SLI | Target | Window | Paging threshold |");
  lines.push("| --- | --- | ---: | --- | --- |");
  lines.push("| Plan admission | valid decisions / requests | 99.99% | 30 days | two 5-minute windows below 99.5% |");
  lines.push("| Audit delivery | events delivered under 60 s | 99.95% | 7 days | p99 over 5 minutes for 10 minutes |");
  lines.push("| Flag propagation | acknowledgements under 30 s | 99.90% | 24 hours | any region below 98% for 5 minutes |");
  lines.push("| Rollback initiation | guard to command latency | 99.99% under 10 s | 30 days | one command over 30 seconds |");
  lines.push("");
  lines.push("## 2. Architecture");
  lines.push("");
  lines.push("```mermaid");
  lines.push("flowchart LR");
  lines.push("  Operator[Operator or CI] --> Gateway[Access gateway]");
  lines.push("  Gateway --> Planner[Change planner]");
  lines.push("  Planner --> Policy[Policy engine]");
  lines.push("  Planner --> Ledger[(Audit ledger)]");
  lines.push("  Planner --> Coordinator[Deployment coordinator]");
  lines.push("  Coordinator --> Regions{Regional agents}");
  lines.push("  Regions --> Runtime[Data-plane services]");
  lines.push("  Runtime --> Health[Health aggregator]");
  lines.push("  Health --> Coordinator");
  lines.push("  Health --> Incident[Incident broker]");
  lines.push("```");
  lines.push("");
  lines.push("### 2.1 Request lifecycle");
  lines.push("");
  lines.push("1. The caller submits a declarative change with an idempotency key.");
  lines.push("2. The access gateway authenticates workload identity and resolves tenant scope.");
  lines.push("3. The policy engine evaluates maintenance windows, segregation of duties, and blast-radius limits.");
  lines.push("4. The planner freezes an immutable plan containing stages, checks, rollback actions, and evidence requirements.");
  lines.push("5. The coordinator releases one stage at a time and waits for regional acknowledgements.");
  lines.push("6. The health aggregator evaluates fast-burn and slow-burn SLO windows.");
  lines.push("7. Any failed guard moves the plan to `paused`; critical guards also enqueue rollback.");
  lines.push("8. The audit ledger links the request, policy decision, operator action, and observed outcome.");
  lines.push("");
  lines.push("### 2.2 State machine");
  lines.push("");
  lines.push("| Current state | Command | Guard | Next state | Side effect |");
  lines.push("| --- | --- | --- | --- | --- |");
  lines.push("| `draft` | submit | schema and ownership valid | `pending_approval` | write plan digest |");
  lines.push("| `pending_approval` | approve | distinct authorized reviewer | `scheduled` | freeze stages |");
  lines.push("| `scheduled` | start | window open and capacity available | `running` | dispatch stage zero |");
  lines.push("| `running` | observe | all gates pass | `running` | advance exposure |");
  lines.push("| `running` | observe | a gate fails | `paused` | page owner |");
  lines.push("| `paused` | rollback | rollback token valid | `rolling_back` | dispatch prior revision |");
  lines.push("| `rolling_back` | observe | prior revision healthy | `rolled_back` | close mitigation task |");
  lines.push("| `running` | complete | final dwell elapsed | `completed` | seal evidence bundle |");
  lines.push("");
  lines.push("## 3. API contract");
  lines.push("");
  lines.push("### Create a release plan");
  lines.push("");
  lines.push("```http");
  lines.push("POST /v1/tenants/northwind/release-plans HTTP/1.1");
  lines.push("Host: control.kiron.example");
  lines.push("Authorization: Bearer <workload-token>");
  lines.push("Content-Type: application/json");
  lines.push("Idempotency-Key: release-2026-08-12-flag-evaluator");
  lines.push("");
  lines.push("{");
  lines.push('  "service": "flag-evaluator",');
  lines.push('  "artifact": "sha256:6d8f...9a2c",');
  lines.push('  "regions": ["ap-northeast-2", "ap-southeast-1"],');
  lines.push('  "strategy": {');
  lines.push('    "type": "progressive",');
  lines.push('    "steps": [1, 5, 10, 25, 50, 100],');
  lines.push('    "dwell_seconds": 900');
  lines.push("  }");
  lines.push("}");
  lines.push("```");
  lines.push("");
  lines.push("### Error envelope");
  lines.push("");
  lines.push("```json");
  lines.push("{");
  lines.push('  "type": "https://control.kiron.example/problems/policy-denied",');
  lines.push('  "title": "Release policy denied the request",');
  lines.push('  "status": 403,');
  lines.push('  "detail": "A production change requires an independent reviewer",');
  lines.push('  "instance": "/v1/tenants/northwind/release-plans/rp_01J5...",');
  lines.push('  "trace_id": "4c812f42aa864adca27be9eb9eb93c9e"');
  lines.push("}");
  lines.push("```");
  lines.push("");
  lines.push("## 4. Release procedure");
  lines.push("");
  lines.push("### Preflight checklist");
  lines.push("");
  [
    "Artifact digest is immutable and present in the production registry.",
    "Database migrations are backward compatible with the active revision.",
    "Dashboards include revision, tenant, and region dimensions.",
    "Fast-burn and slow-burn alerts have valid links to this handbook.",
    "Rollback was exercised against the same artifact family in staging.",
    "The change owner and independent approver are on shift.",
    "Capacity headroom remains above 30% in every target region.",
    "No overlapping freeze or regional maintenance window is active.",
  ].forEach((item) => lines.push(`- [ ] ${item}`));
  lines.push("");
  lines.push("### Operator commands");
  lines.push("");
  lines.push("```bash");
  lines.push("kiron auth whoami --format json");
  lines.push("kiron plans validate ./release-plan.json --strict");
  lines.push("kiron plans create --tenant northwind --file ./release-plan.json");
  lines.push("kiron plans watch rp_01J5KIRON --until terminal --timeout 2h");
  lines.push("kiron evidence export rp_01J5KIRON --output ./evidence.tar.zst");
  lines.push("```");
  lines.push("");
  lines.push("## 5. Incident command protocol");
  lines.push("");
  lines.push("> [!WARNING]");
  lines.push("> Do not restart the coordinator before confirming whether an active lease exists. A blind restart can create duplicate regional commands even though plan APIs are idempotent.");
  lines.push("");
  lines.push("1. Declare the incident and assign incident commander, operations lead, and communications lead.");
  lines.push("2. Freeze new production plans without cancelling in-flight rollback actions.");
  lines.push("3. Record UTC timestamps and query boundaries before collecting evidence.");
  lines.push("4. Prefer scoped traffic reduction over full regional evacuation.");
  lines.push("5. Require two operators for manual audit repair or policy bypass.");
  lines.push("6. Restore service, observe for one slow-burn window, then close mitigation.");
  lines.push("");
  lines.push("## 6. Service runbooks");
  lines.push("");
  services.forEach((service, index) => {
    const alternate = regions[(regions.indexOf(service.region) + 1) % regions.length];
    const incident = incidents[index % incidents.length];
    lines.push(`### 6.${index + 1} ${service.name} in ${service.region}`);
    lines.push("");
    lines.push(`- **Owner:** \`${service.team}\``);
    lines.push(`- **Current revision:** \`${service.version}\``);
    lines.push(`- **Desired replicas:** ${service.replicas}`);
    lines.push(`- **p99 latency:** ${service.latency} ms`);
    lines.push(`- **Remaining error budget:** ${service.errorBudget}%`);
    lines.push(`- **Representative incident:** \`${incident.id}\``);
    lines.push("");
    lines.push("#### Symptoms");
    lines.push("");
    lines.push(`Operators may see delayed acknowledgements from \`${service.region}\`, a growing command queue, or a revision mismatch between the coordinator and ${service.name}. A single late heartbeat is not sufficient evidence of an outage.`);
    lines.push("");
    lines.push("#### Triage query");
    lines.push("");
    lines.push("```text");
    lines.push(`sum by (revision, result) (rate(kiron_${service.name.replaceAll("-", "_")}_requests_total{region="${service.region}"}[5m]))`);
    lines.push(`histogram_quantile(0.99, sum by (le) (rate(kiron_${service.name.replaceAll("-", "_")}_latency_seconds_bucket{region="${service.region}"}[5m])))`);
    lines.push("```");
    lines.push("");
    lines.push("#### Mitigation");
    lines.push("");
    lines.push(`1. Pause plans targeting \`${service.name}\` in \`${service.region}\` while leaving other services untouched.`);
    lines.push(`2. Compare the last accepted revision with \`${service.version}\` and verify the artifact digest.`);
    lines.push(`3. If the regional error rate remains above 2%, shift new commands to \`${alternate}\` and retain read-only status polling.`);
    lines.push(`4. If recovery fails after two probe intervals, roll back the active stage and attach \`${incident.id}\` to the evidence bundle.`);
    lines.push("");
    lines.push("#### Recovery validation");
    lines.push("");
    lines.push(`- [ ] ${service.name} has reported the same revision for three consecutive heartbeats.`);
    lines.push(`- [ ] The p99 latency in ${service.region} is below ${Math.max(200, service.latency + 100)} ms.`);
    lines.push("- [ ] No new policy denials or audit delivery gaps appeared during the observation window.");
    lines.push("- [ ] The operator timeline contains the plan ID, trace ID, queries, and decision owner.");
    lines.push("");
  });
  lines.push("## 7. Architecture decisions");
  lines.push("");
  const decisions = [
    ["ADR-001", "Keep the control plane out of the data request path", "Accepted"],
    ["ADR-002", "Use immutable plans instead of mutable deployment records", "Accepted"],
    ["ADR-003", "Store audit events before dispatching regional commands", "Accepted"],
    ["ADR-004", "Evaluate rollout health with multi-window burn rates", "Accepted"],
    ["ADR-005", "Require workload identity instead of long-lived API tokens", "Accepted"],
    ["ADR-006", "Prefer regional leases over a global coordinator lock", "Trial"],
    ["ADR-007", "Seal evidence bundles with content digests", "Accepted"],
    ["ADR-008", "Expose declarative plans through HTTP and event streams", "Accepted"],
  ];
  decisions.forEach(([id, title, status]) => {
    lines.push(`### ${id}: ${title}`);
    lines.push("");
    lines.push(`**Status:** ${status}`);
    lines.push("");
    lines.push("The decision favors deterministic recovery, explicit ownership, and bounded blast radius. Alternatives were evaluated against operator load, partial failure behavior, and the ability to reconstruct a release from immutable evidence.");
    lines.push("");
    lines.push("Consequences include additional storage and stricter schema evolution, but the operating model remains inspectable under incident pressure.");
    lines.push("");
  });
  lines.push("## 8. Review record");
  lines.push("");
  lines.push("| Date | Reviewer | Scope | Outcome |");
  lines.push("| --- | --- | --- | --- |");
  for (let index = 0; index < 24; index += 1) {
    lines.push(`| 2026-${String(1 + Math.floor(index / 4)).padStart(2, "0")}-${String(3 + (index * 3) % 25).padStart(2, "0")} | ${teams[index % teams.length]} | ${serviceRoots[index % serviceRoots.length]} runbook | ${index % 5 === 0 ? "follow-up filed" : "approved"} |`);
  }
  lines.push("");
  lines.push("End of deterministic engineering fixture.");
  return `${lines.join("\n")}\n`;
}

const outputs = new Map([
  [new URL("./demo.html", import.meta.url), htmlDocument()],
  [new URL("./demo.css", import.meta.url), cssDocument()],
  [new URL("./demo.md", import.meta.url), markdownDocument()],
]);

for (const [target, content] of outputs) {
  writeFileSync(target, content, "utf8");
}

for (const [target, content] of outputs) {
  const lineCount = content.split("\n").length - 1;
  if (lineCount < 1_100) {
    throw new Error(`${target.pathname} contains only ${lineCount} lines`);
  }
  console.log(`${target.pathname}: ${lineCount} lines`);
}
