# T3 fleet maintenance

Operations for `nobody0/t3code`. Stable candidates are prepared every four hours; an agent performs deployments only after the owner approves the exact candidate. The same maintenance window covers the fleet's CLIProxyAPI provider gateways, which are updated by hand; see [Provider gateway updates](#provider-gateway-updates). Browser reminders never dispatch commands. Authentication remains upstream's policy: 30-day sessions, which devices paired directly since 0.1.11 renew while in use.

## Preparation

The `Prepare stable T3 candidate` workflow merges the newest stable upstream release into a candidate branch descended from the fork's main branch. When it fails, read the job log (`gh run view RUN_ID --log-failed`) and check that fork main equals the deployed release (rollout step 2). Resolve a conflict by pushing the finished merge, with the package versions and fork repository URL that `prepare.mjs` sets, as `candidate/<tag>-<main12>-<ops12>`. An existing branch is built as-is, any operations commit changes the expected name, and failed preparations retry on schedule. It tests the ownership guards, packages the browser/server once, then tests locked installs, native terminals and isolated startup on Linux x64, Windows x64 and both Mac architectures. GitHub-hosted validation does not replace target-specific NixOS/Mac checks.

Candidate IDs contain both source and operations commits. Unchanged successful candidates are not rebuilt. Four-hour checks refresh `maintenance-status/latest.json`. Schedule delays and outages are represented by timestamps. Workflows never connect to production machines. `T3_FORK_DEPLOY_KEY` is a dedicated write deploy key for the fork only; the build jobs never receive it.

GitHub can disable public-repository schedules after 60 days without repository activity. GitHub also delays and drops scheduled runs: the four-hourly schedule reported every 8.6 hours (median) and at most 12.6 hours apart in October-November 2026. The observer therefore marks preparation stale after sixteen hours instead of showing a false all-clear. If disabled, an agent re-enables `prepare.yml` and starts a check. See [GitHub's scheduling rules](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule).

`scripts/build-ko-release.mjs SOURCE OUTPUT` requires a clean published source; `T3_SOURCE_REF` selects an explicit candidate ref. `tools/scripts/ko-session.mjs` under each deployment root is an operations-only helper with `check` and `idle` release gates. It does not launch agents or maintain launch receipts, and new runtime archives do not bundle it. Agent launches and delegation use T3's native MCP tools through the target environment's authorized connection; see KO's `t3-work` skill.

## Agent rollout

1. Read the KO fleet and deployment entities, verify the target paths and refs, and obtain approval for the exact release in conversation. Check the report is ready and every target platform has a tested lock.
2. Fetch the candidate branch and fast-forward fork main to its exact commit after reviewing the diff. If main diverged, prepare a new candidate; do not force-push or rebuild the approved artifact.
3. Download the release archive and compare its SHA-256 with the reviewed report. Extract to a new incoming directory; keep the manifest and platform locks. Run `node tools/scripts/install-ko-release.mjs INCOMING RELEASES_ROOT`. This stages files and never restarts production.
4. On each target prepare a clean candidate source checkout with its frozen build dependencies. Set `migrationSource` in the local deployment config to that checkout, and `baselineVersion` to the approved candidate's upstream version. This enables database-only rehearsal without adding migration commands to T3 itself.
5. Run the external helper `check` and `idle` with the documented home, loopback origin, environment ID and installed CLI argv. Defer active turns or terminal subprocesses. Ask the user to pause new work during the brief cutover; idle checks are not an atomic application maintenance lock.
6. Run `node tools/scripts/manage-ko-release.mjs activate CONFIG RELEASE_ID`. The manager verifies the package, isolates a startup check, rechecks idle state, stops the native service, backs up the existing home, rehearses migrations on a copy and then activates. The original home, identities, service names and Tailscale mappings stay intact.
7. Verify authenticated API and provider readiness, DB integrity and migration report, running commit/receipt, HTTPS descriptor, frontend entry assets and stable process. Update Klarstand first, then Windows, Oldy and Caps; update the Mac while it is awake and its operator is logged in. Stop the rollout after a failure. Update KO deployment entities with the actual result using `baseRev`; update local observer configurations with the verified commit/release.

For a first Mac installation, verify architecture, launchd and the existing installation while the device is awake and the operator is logged in. Configure `initialCli` with the verified existing CLI argv and retain its original launchd definition. No startup checker installs software.

## Provider gateway updates

Gateways run a pinned [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) release under a native service, one account per provider. KO's gateway instances record paths, service names and accounts; nothing here installs them. Update one gateway at a time:

- **Choose** a stable release a few days old, read the notes since the deployed version and get approval. A `config-version` change needs review first. Do not enable account pooling, cross-account failover or new cloaking options.
- **Verify** the archive against the release's `checksums.txt`.
- **Swap** while the user pauses work on that route, since nothing fails over: back up `config.yaml`, stop the native service, keep the old executable as `.previous`, install the new one and start it.
- **Check** the `-help` version line, HTTP 401 on the tailnet listener without a key, a ready route in the helper's `check`, and one short request. Roll back with the previous executable and `config.yaml`.
- **Record** the version, date and hashes on the KO instance using `baseRev`, then delete the backups.

Never run a second gateway on the same auth directory: concurrent token refreshes can invalidate the login.

## Recovery

Activation journals record the previous service, backup and before/after migration state. Backups live under the deployment root with owner-only directory permissions. Treat them as credentials; never upload them to GitHub.

If an activation with a real database fails, the manager attempts to stop the candidate and records `recovery-required`. On Windows a stopped task stays disabled, so its triggers cannot start it, until a service definition is registered again. It never automatically restarts an older binary against a migrated DB. Inspect the journal and service logs. Keep both failed data and the pre-upgrade snapshot. Only restore data after proving no newer work will be lost or obtaining explicit incident-specific approval. Restore a matched database/settings/secrets/identity snapshot and its corresponding previous service, then revalidate. Binary-only rollback is reserved for disposable installations without databases. An interrupted transaction blocks a second activation.

A release's first start migrates the live database before it serves and answers 503 meanwhile, so after a database upgrade the manager waits up to 30 minutes (the rehearsal ceiling) for the new release instead of the ordinary minute. While an activation holds its lock or journal, the wrapper pauses recovery; a child that is healthy again when the pause ends keeps running.

If the candidate was selected and then failed validation, `node scripts/manage-ko-release.mjs complete CONFIG.json RELEASE_ID` finishes the upgrade forward. It requires the `recovery-required` journal for that release, the release still selected, the service stopped, the journal's stopped-home backup and passed rehearsal report, and a live database that is the backed-up one plus a prefix of the rehearsed migrations. It then starts the release with the same 30-minute ceiling and records `completion` and `after` in the journal; on failure it stops the candidate and records `recovery-required` again. Otherwise restore the snapshot as above.

## Client pairing

`node scripts/pair-fleet.mjs codes` issues explicitly requested single-use pairing codes for every inventory target, using upstream's default scopes and lifetime. Enter them at the primary workspace under **+ Add environment → Remote link**. Add `--page` to also write a local copy-button page (owner-only, in the OS temp directory) and open it in the default browser, or `--page --no-open` to only print its path; the page hides codes once they expire, and you delete it after use. Codes are never saved to KO or receipts. `sessions` reports expiry (warning below seven days), last connection and Connections permission mismatches; `revoke NAME SESSION_ID...` revokes only named sessions. `--only`, repeated `--scope`, `--ttl` and `--label` remain available; `--scopes standard` explicitly reduces permissions to 13. Healthy sessions are not re-paired. Agent links separately require Settings → Labs → Linked environments.

The inventory is private and local: `$T3_FLEET` or `~/.config/t3-code-ko/fleet.local.json`, following [the example schema](templates/fleet.example.json). Environment UUIDs are stable keys; credentials are rejected. Each command verifies the target's environment identity over SSH before invoking its installed T3 CLI.

## Read-only reminder

`node scripts/observe.mjs CONFIG.local.json` refreshes preparation status and public fleet descriptors. It never mints T3 credentials, starts jobs or installs anything. Run at operator login and every five minutes. Its cache is `<KO checkout>/.cache/t3-maintenance/status.json`; author the ordinary KO note from `templates/maintenance.html` through the content API. `ko.readText` stays same-origin. Opening the note checks the cache, which can be up to five minutes old. A machine is pending only when the candidate's source commit differs from its verified commit; operations-only candidates reuse the deployed source, and their tooling is installed separately. Reports older than sixteen hours or observations older than ten minutes are explicitly stale.

The note is opened on demand; nothing changes the browser homepage or opens tabs at login. Instead the observer raises a desktop notification (a Windows toast that opens the note when clicked, or a macOS notification) once when something changes: a candidate whose source is not yet verified on a recorded machine, failed or stale preparation, a preparation report unavailable for over an hour, the observer failing, or a machine unreachable longer than its `offlineAlertMinutes` (default 60; `null` disables it, as for a Mac that sleeps). Announced conditions are remembered in the cache's `announced` list, so a persisting or returning condition is not repeated; `alerts` lists the current ones, and a failed delivery is logged and retried. `noteUrl` overrides the clicked link. Verify delivery on each machine with `node scripts/observe.mjs --test-notification`; on macOS run it from the observer's LaunchAgent context, because notifications from SSH sessions are not shown. Each run records preparation, machine and observer failures in the cache's `log`, which the note shows as its observer log, so failures are visible the same way on Windows and macOS. `templates/install-observer.ps1` installs the Windows login and five-minute task through a headless console host, so runs never flash a window; the Mac launch-agent equivalent is `templates/install-observer-macos.mjs`. The note offers only permanent links and a copyable agent request. KO remains documentation, not a job dispatcher.

For the Mac, first install KO's native service using `node KO_ROOT/tools/install-ko-service.mjs KO_ROOT BUN_PATH`. Then run `node templates/install-observer-macos.mjs CONFIG.local.json`. Keep the KO observer cache machine-local and publish the note through that machine's running KO API.

## Checks

Run `node --test scripts/*.test.mjs`. For actual native supervision fixtures set `KO_TEST_NATIVE=1` on Windows/macOS or `KO_TEST_SYSTEMD=1` on Linux; these use disposable service names and homes. Never point tests at production data. Review Node, provider CLIs, Tailscale and NixOS upgrades separately.

## Service supervision

Each app has one ownership chain: **native service → app wrapper → app child**. T3 uses `serve-t3.mjs` on Windows, macOS and both Linux roots. KO uses its canonical `server/service.ts` wrapper on Windows and macOS. Native managers recover wrapper exits; wrappers recover child exits and HTTP hangs. There are no separate T3 watchdog jobs. The observer remains a read-only client.

Install T3 supervision with `node scripts/install-t3-supervisor.mjs DEPLOYMENT_ROOT/config.json`. The installer checks idle state and recovery records, retires legacy watchdog tasks/timers, archives their local tooling, and replaces the configured primary service. It preserves the selected release, home, environment identity, credentials and Tailscale routes. The installed tooling receipt is `supervisor-installed.json`.

Control T3 with `node DEPLOYMENT_ROOT/tools/scripts/control-t3-service.mjs status|start|stop DEPLOYMENT_ROOT/config.json`. Intentional stop persists a `service-stopped` marker and disables Windows/macOS startup; Linux's unit condition prevents startup until the marker is cleared. Start resumes the same primary service. Mutating controls use the deployment lock and reject unresolved recovery. Status is read-only. Do not add another direct T3 launcher or an external recovery job.

The primary Windows task is hidden, runs at login and retries once a minute with `IgnoreNew`, so an existing task never overlaps a second instance. macOS uses one `RunAtLoad`/`KeepAlive` LaunchAgent; Linux uses a lingering user service with `Restart=always`. Windows and macOS still require an awake device and logged-in operator. No sleep or wake policy is changed.

The T3 wrapper waits 90 seconds after startup/wake, confirms failed loopback descriptor probes spanning at least 60 seconds, and backs repeated restarts off up to five minutes. It owns only the child it spawned, holds an exclusive loopback control listener, and pauses recovery during deployment locks or unresolved migration records. Provider login, quota and Tailscale failures do not trigger app restarts. Its private `service-runtime.json` contains controller credentials and must never be edited, committed or shared.

If a native wrapper dies while its app wrapper runs on, the replacement does not fail beside it or start a second app: it verifies the running owner through its control token, adopts it and holds the native service until that owner exits, then exits so the native service starts a fresh wrapper. `status` reports `ownership: native|adopted`; `stop` also stops an adopted owner. On Windows the app wrapper writes `service.stdout.log`/`service.stderr.log` itself (rotating near 64 MiB), so losing the PowerShell wrapper cannot break the app's output. It ignores broken console pipes, records fatal errors and child exit codes in `service-supervisor.log` (rotating near 1 MiB), and the PowerShell wrapper adds the supervisor's exit code there. macOS and Linux app output follows the native service's log paths.

`scripts/lib/service-monitor.mjs` is the common liveness/backoff implementation. KO vendors the same file under `tools/service-monitor.mjs` so either repository runs independently. Update it here, then run `node scripts/sync-service-monitor.mjs KO_ROOT`; verify parity with `--check` and review both repository changes together.

Run `KO_TEST_SUPERVISOR=1 node --test scripts/service-supervisor*.test.mjs` on each target OS (PowerShell: `$env:KO_TEST_SUPERVISOR='1'`). Fixtures use disposable native services and homes to verify crash/hang recovery, wrapper adoption (on Windows also after killing only the native wrapper) and clean intentional stop. Validate production local/HTTPS descriptors and native wrapper ownership after installation; do not fault-inject or reboot an active production machine.
