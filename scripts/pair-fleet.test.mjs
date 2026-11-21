import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { validateInventory, selectTargets } from "./lib/fleet-inventory.mjs";
import { pairingArgs, sessionSummary, runPair, pairingPage } from "./pair-fleet.mjs";
import { executeSource, shellQuote } from "./lib/fleet-transport.mjs";
import { atomicJson } from "./lib/ko-release.mjs";

const target = {
  name: "test",
  environmentId: "00000000-0000-4000-8000-000000000001",
  platform: process.platform,
  arch: process.arch,
  node: process.execPath,
  root: path.join(os.tmpdir(), "fleet-unused"),
  availability: "online",
};
const temporary = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test("one inventory rejects duplicate identities, ambiguous selections and credentials", () => {
  const i = { schemaVersion: 1, targets: [target] };
  assert.equal(validateInventory(i).targets.length, 1);
  assert.throws(
    () => validateInventory({ ...i, targets: [target, { ...target, name: "second" }] }),
    /Duplicate/,
  );
  assert.throws(
    () => validateInventory({ ...i, targets: [{ ...target, token: "secret" }] }),
    /Credentials/,
  );
  assert.throws(() => selectTargets(i, "test,missing"), /Unknown/);
  assert.throws(() => selectTargets(i, "test,test"), /duplicate/);
  assert.throws(
    () => validateInventory({ ...i, targets: [{ ...target, ssh: "-oProxyCommand=bad" }] }),
    /SSH/,
  );
});
test("pairing delegates default scopes/lifetime to upstream and never turns expiry into a credential", () => {
  const args = pairingArgs("codes");
  assert.ok(!args.includes("--scope"));
  assert.ok(!args.includes("--session-ttl"));
  assert.equal(
    pairingArgs("codes", { scopes: "standard" }).filter((x) => x === "--scope").length,
    13,
  );
  assert.throws(() => pairingArgs("revoke", { ids: ["--all"] }));
  const summary = sessionSummary(
    { sessionId: "one", subject: "browser", scopes: [], expiresAt: "2026-11-08T00:00:00Z" },
    Date.parse("2026-11-06T00:00:00Z"),
  );
  assert.equal(summary.expiry, "renew-soon");
  assert.equal(summary.connectionsSettings, "missing-permission");
  assert.ok(!("token" in summary));
  assert.equal(summary.lastConnectedAt, null);
});
test("pairing page offers host and code copies, escapes values and skips failed targets", () => {
  const html = pairingPage([
    { name: "pc", url: "https://pc.example.ts.net/", code: "ABC123", expiresAt: "2026-11-18T08:41:00Z" },
    { name: "<b>x</b>", url: "https://x.example.ts.net/", code: "Q\"'<", expiresAt: "2026-11-18T08:41:00Z" },
    { name: "down", status: "failed" },
  ]);
  assert.match(html, /data-copy="pc\.example\.ts\.net"/);
  assert.match(html, /data-copy="ABC123"/);
  assert.ok(!html.includes("<b>x</b>") && !html.includes("Q\"'<"));
  assert.ok(!html.includes("down"));
  assert.match(html, /data-qr="https:\/\/pc\.example\.ts\.net\/pair#token=ABC123"/);
  assert.match(html, /integrity="sha384-/);
});
test("transport preserves literal paths and Unicode without shell interpolation", async () => {
  const value = "quote ' dollar $() backtick ` umlaut ü";
  const result = await executeSource(
    target,
    `console.log(JSON.stringify({value:${JSON.stringify(value)}}))`,
  );
  assert.equal(result.value, value);
  assert.equal(shellQuote("a'b", "linux"), "'a'\\''b'");
  await assert.rejects(
    executeSource(target, "console.error('SECRET-do-not-relay');process.exit(1)"),
    (e) => !e.message.includes("SECRET"),
  );
});
test("pairing verifies target identity before invoking its CLI", async (t) => {
  const root = temporary(t);
  atomicJson(path.join(root, "config.json"), {
    root,
    baseDir: path.join(root, "home"),
    node: process.execPath,
  });
  const t2 = { ...target, root };
  await assert.rejects(runPair(t2, pairingArgs("sessions")), /worker failure/);
});
