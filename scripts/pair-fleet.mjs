#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { loadInventory, selectTargets } from "./lib/fleet-inventory.mjs";
import { executeSource } from "./lib/fleet-transport.mjs";

// Default scopes and the 30-day session lifetime belong to upstream T3.
// This reduced set preserves the original helper's --scopes standard option.
const reduced = [
  "orchestration:read",
  "orchestration:operate",
  "settings:write",
  "providers:manage",
  "environment:maintain",
  "preview:operate",
  "diagnostics:read",
  "terminal:read",
  "terminal:operate",
  "source-control:write",
  "filesystem:read",
  "filesystem:write",
  "relay:read",
];
export function pairingArgs(
  operation,
  { scopes = "full", scope, ttl = "30m", label = "Fleet workspace", ids = [] } = {},
) {
  if (operation === "sessions") return ["auth", "session", "list", "--json"];
  if (operation === "revoke") {
    if (ids.length !== 1 || !/^[-a-zA-Z0-9_:]+$/.test(ids[0]) || ids[0].startsWith("-"))
      throw Error("One session id is required per revoke call.");
    return ["auth", "session", "revoke", ids[0]];
  }
  if (operation !== "codes" || !["full", "standard"].includes(scopes))
    throw Error("Choose codes, sessions or revoke; --scopes full|standard.");
  const selected = scope ?? (scopes === "standard" ? reduced : []);
  return [
    "auth",
    "pairing",
    "create",
    "--ttl",
    ttl,
    "--label",
    label,
    "--json",
    ...selected.flatMap((s) => ["--scope", s]),
  ];
}
export function sessionSummary(s, now = Date.now()) {
  const daysRemaining = Math.floor((Date.parse(s.expiresAt) - now) / 86400_000);
  return {
    sessionId: s.sessionId,
    label: s.client?.label ?? s.subject,
    connected: s.connected ?? false,
    expiresAt: s.expiresAt,
    lastConnectedAt: s.lastConnectedAt ?? null,
    daysRemaining,
    expiry: daysRemaining < 0 ? "expired" : daysRemaining < 7 ? "renew-soon" : "valid",
    scopeCount: s.scopes.length,
    connectionsSettings: s.scopes.includes("access:write") ? "allowed" : "missing-permission",
  };
}
const escapeHtml = (v) =>
  String(v).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
// T3 mobile scans the server's pairing URL and extracts host and code from it.
export const pairingUrl = (url, code) => {
  const u = new URL(url);
  u.pathname = "/pair";
  u.search = "";
  u.hash = new URLSearchParams([["token", code]]).toString();
  return u.toString();
};
// Pinned with SRI: the page renders QR codes locally and never sends codes anywhere.
const QR_LIB =
  '<script src="https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js" integrity="sha384-mZT2gIty7ZDdOGkxfP6joZcYdMW1Jvj9dRlfpTmaJAKKXTqzygtB22k7FLe+KZC1" crossorigin="anonymous" referrerpolicy="no-referrer"></script>';
// A local page with copy buttons for terminals where selecting text is awkward,
// and QR codes for the T3 mobile app. Codes are single-use and short-lived; the
// page hides them once they expire.
export function pairingPage(codes) {
  const rows = codes
    .filter((c) => c.code)
    .map((c) => {
      const host = c.url ? new URL(c.url).host : c.name;
      const field = (label, value) =>
        `<div class="row"><span class="lbl">${label}</span><code>${escapeHtml(value)}</code><button data-copy="${escapeHtml(value)}">Copy</button></div>`;
      const qr = c.url ? `<div class="qr" data-qr="${escapeHtml(pairingUrl(c.url, c.code))}"></div>` : "";
      return `<div class="card" data-expires="${escapeHtml(c.expiresAt)}"><h2>${escapeHtml(c.name)}</h2>${field("Host", host)}${field("Code", c.code)}${qr}<div class="exp"></div></div>`;
    })
    .join("\n");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>T3 Pairing Codes</title><style>
:root{--bg:#fff;--fg:#1a1a1a;--muted:#666;--line:#ddd;--btn:#2b59c3;--ok:#1a7f37}
@media (prefers-color-scheme:dark){:root{--bg:#161616;--fg:#eee;--muted:#999;--line:#333;--btn:#5b8def;--ok:#3fb950}}
body{background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif;margin:0 auto;padding:24px 16px;max-width:760px}
h1{font-size:20px;margin:0 0 4px}p{color:var(--muted);margin:0 0 20px}
.card{border:1px solid var(--line);border-radius:8px;padding:12px 14px;margin-bottom:12px}.card h2{font-size:15px;margin:0 0 8px}
.row{display:flex;gap:8px;align-items:center;margin:4px 0;flex-wrap:wrap}.lbl{width:44px;color:var(--muted);font-size:13px}
code{font:14px ui-monospace,Consolas,monospace;flex:1;min-width:0;word-break:break-all}.exp{color:var(--muted);font-size:13px}
button{background:var(--btn);color:#fff;border:0;border-radius:6px;padding:5px 12px;cursor:pointer;font:inherit;font-size:13px}button.done{background:var(--ok)}
.qr{margin:8px 0 4px;line-height:0}.qr svg{width:220px;height:220px;background:#fff;border-radius:6px}
.expired code,.expired button,.expired .qr{display:none}
</style></head><body><h1>T3 pairing codes</h1>
<p>Single-use. Enter the primary workspace's own code on its page; add each remote at the primary workspace under + Add environment → Remote link. For the T3 mobile app, scan each QR code from the app's add-connection screen; never scan it with the camera app or open a /pair#token= link in a browser, which spends the code on that page. Delete this file when done.</p>
${rows}
${QR_LIB}
<script>
for(const q of document.querySelectorAll(".qr[data-qr]")){try{const g=qrcode(0,"M");g.addData(q.dataset.qr);g.make();q.innerHTML=g.createSvgTag({cellSize:4,margin:4,scalable:true})}catch{q.textContent="QR unavailable (library did not load); type host and code instead."}}
document.addEventListener("click",async(e)=>{const b=e.target.closest("button[data-copy]");if(!b)return;const v=b.dataset.copy;try{await navigator.clipboard.writeText(v)}catch{const t=document.createElement("textarea");t.value=v;document.body.append(t);t.select();document.execCommand("copy");t.remove()}b.textContent="Copied";b.classList.add("done")});
const tick=()=>{for(const c of document.querySelectorAll(".card")){const ms=Date.parse(c.dataset.expires)-Date.now();const exp=c.querySelector(".exp");if(ms<=0){c.classList.add("expired");exp.textContent="Expired — issue a new code."}else exp.textContent="Expires in "+Math.ceil(ms/60000)+" min"}};tick();setInterval(tick,15000);
</script></body></html>
`;
}
function writePairingPage(codes, open) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-pair-"));
  const file = path.join(dir, "pair-codes.html");
  fs.writeFileSync(file, pairingPage(codes), { mode: 0o600 });
  if (open) {
    const [cmd, args] =
      process.platform === "win32"
        ? ["cmd.exe", ["/c", "start", "", file]]
        : [process.platform === "darwin" ? "open" : "xdg-open", [file]];
    spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: true }).unref();
  }
  return file;
}
export async function runPair(target, args, transport = executeSource) {
  const input = JSON.stringify({
    root: target.root,
    environmentId: target.environmentId,
    platform: target.platform,
    arch: target.arch,
    args,
  });
  const source = `try{const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),i=${input};if(process.platform!==i.platform||process.arch!==i.arch)throw Error();const c=JSON.parse(fs.readFileSync(path.join(i.root,'config.json'),'utf8'));if(path.resolve(c.root)!==path.resolve(i.root)||fs.readFileSync(path.join(c.baseDir,'userdata/environment-id'),'utf8').trim()!==i.environmentId)throw Error();const j=JSON.parse(fs.readFileSync(path.join(i.root,'activation.json'),'utf8'));if(j.phase!=='active')throw Error();const target=i.platform==='linux'?fs.realpathSync(path.join(i.root,'current')):JSON.parse(fs.readFileSync(path.join(i.root,'current.json'),'utf8')).target;const r=cp.spawnSync(c.node,[path.join(target,'node_modules/t3/dist/bin.mjs'),...i.args,'--base-dir',c.baseDir],{encoding:'utf8',timeout:30000,maxBuffer:1048576,windowsHide:true});if(r.status!==0)throw Error();console.log(JSON.stringify({stdout:r.stdout}));}catch{console.error('Pairing operation failed; inspect identity, active release and native auth CLI.');process.exitCode=1;}`;
  return (await transport(target, source)).stdout;
}
export async function pairMain(argv) {
  const {
    values: f,
    positionals: [operation, ...rest],
  } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      fleet: { type: "string" },
      only: { type: "string" },
      scopes: { type: "string", default: "full" },
      scope: { type: "string", multiple: true },
      ttl: { type: "string", default: "30m" },
      label: { type: "string", default: "Fleet workspace" },
      json: { type: "boolean" },
      page: { type: "boolean" },
      "no-open": { type: "boolean" },
    },
  });
  const inventory = loadInventory(
    f.fleet ??
      process.env.T3_FLEET ??
      path.join(os.homedir(), ".config/t3-code-ko/fleet.local.json"),
  );
  const targets = selectTargets(inventory, operation === "revoke" ? rest[0] : f.only),
    results = [];
  if (operation === "revoke" && rest.length < 2) throw Error("Usage: revoke TARGET SESSION_ID...");
  for (const t of targets) {
    try {
      if (operation === "revoke") {
        for (const id of rest.slice(1)) await runPair(t, pairingArgs(operation, { ids: [id] }));
        results.push({ name: t.name, status: "revoked" });
      } else {
        const output = JSON.parse(await runPair(t, pairingArgs(operation, f)));
        results.push(
          operation === "sessions"
            ? { name: t.name, sessions: output.map((s) => sessionSummary(s)) }
            : { name: t.name, url: t.url, code: output.credential, expiresAt: output.expiresAt },
        );
      }
    } catch {
      results.push({ name: t.name, status: "failed" });
    }
  }
  console.log(JSON.stringify(results, null, 2));
  if (operation === "codes" && f.page && results.some((r) => r.code)) {
    const file = writePairingPage(results, !f["no-open"]);
    console.log(`Copy page (delete after use): ${file}`);
  }
  if (operation === "codes" && !f.json)
    console.log(
      "Enter each single-use code at the primary workspace: + Add environment > Remote link. Agent links separately require Settings > Labs > Linked environments.",
    );
  return results.some((r) => r.status === "failed") ? 1 : 0;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = await pairMain(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
}
