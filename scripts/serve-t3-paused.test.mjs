import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { atomicJson } from "./lib/ko-release.mjs";

// A release's first start can stay unresponsive for minutes while it migrates a large
// database. The wrapper pauses recovery during the activation; once it ends, a child
// that became healthy meanwhile must be kept, while one that is still hung is replaced.
test(
  "a child that recovers while wrapper recovery is paused keeps running",
  { timeout: 90000 },
  async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "serve-t3-paused-"));
    const freePort = async () => {
      const s = net.createServer();
      await new Promise((r) => s.listen(0, "127.0.0.1", r));
      const p = s.address().port;
      await new Promise((r) => s.close(r));
      return p;
    };
    const c = {
      platform: process.platform,
      root,
      baseDir: path.join(root, "home"),
      node: process.execPath,
      port: await freePort(),
      supervisorPort: await freePort(),
      supervision: { startupGraceMs: 0, intervalMs: 100, failureLimit: 2, failureSpanMs: 100 },
    };
    fs.mkdirSync(path.join(c.baseDir, "userdata"), { recursive: true });
    fs.writeFileSync(path.join(c.baseDir, "userdata/environment-id"), "fixture");
    atomicJson(path.join(root, "config.json"), c);
    const target = path.join(root, "release"),
      cli = path.join(target, "node_modules/t3/dist/bin.mjs");
    fs.mkdirSync(path.dirname(cli), { recursive: true });
    fs.writeFileSync(
      cli,
      `import http from 'node:http';import fs from 'node:fs';import path from 'node:path';const arg=k=>process.argv[process.argv.indexOf(k)+1];const home=arg('--base-dir');http.createServer((req,res)=>{if(fs.existsSync(path.join(home,'hang')))return;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({environmentId:'fixture'}));}).listen(Number(arg('--port')),'127.0.0.1');`,
    );
    const wrapper = spawn(
      c.node,
      [path.join(import.meta.dirname, "serve-t3.mjs"), path.join(root, "config.json"), target],
      { stdio: "ignore", windowsHide: true },
    );
    const exited = once(wrapper, "exit");
    const runtime = () => JSON.parse(fs.readFileSync(path.join(root, "service-runtime.json"), "utf8"));
    const log = () => fs.readFileSync(path.join(root, "service-supervisor.log"), "utf8");
    t.after(async () => {
      if (wrapper.exitCode === null) {
        try {
          const r = runtime();
          await fetch(r.controlOrigin + "/stop", {
            method: "POST",
            headers: { authorization: `Bearer ${r.token}` },
          });
        } catch {
          wrapper.kill();
        }
        await exited;
      }
      fs.rmSync(root, { recursive: true, force: true });
    });
    const until = async (condition, message) => {
      for (let i = 0; i < 400; i++) {
        try {
          if (await condition()) return;
        } catch {}
        await delay(100);
      }
      throw Error(message + "\n" + (fs.existsSync(path.join(root, "service-supervisor.log")) ? log() : ""));
    };
    const pause = (on) =>
      on
        ? fs.writeFileSync(path.join(root, "activation.lock"), "1")
        : fs.rmSync(path.join(root, "activation.lock"), { force: true });
    const hang = (on) =>
      on
        ? fs.writeFileSync(path.join(c.baseDir, "hang"), "")
        : fs.rmSync(path.join(c.baseDir, "hang"), { force: true });

    await until(() => runtime().phase === "ready", "fixture never became ready");
    const first = runtime().childPid;

    // Unresponsive while paused, healthy again before the pause ends: keep the child.
    pause(true);
    hang(true);
    await until(() => runtime().phase === "blocked", "wrapper never paused recovery");
    hang(false);
    pause(false);
    await until(() => /monitoring resumed/.test(log()), "wrapper did not resume monitoring");
    await until(() => runtime().phase === "ready", "kept child is not monitored as ready");
    assert.equal(runtime().childPid, first);
    assert.equal(runtime().generation, 1);
    assert.doesNotMatch(log(), /ended reason=unresponsive/);

    // Still hung when the pause ends: the existing recovery replaces the child.
    pause(true);
    hang(true);
    await until(() => runtime().phase === "blocked", "wrapper never paused recovery again");
    pause(false);
    await until(() => /generation=1 ended reason=unresponsive/.test(log()), "hung child was kept");
    hang(false);
    await until(
      () => runtime().generation === 2 && runtime().phase === "ready",
      "replacement child never became ready",
    );
    assert.notEqual(runtime().childPid, first);
  },
);
