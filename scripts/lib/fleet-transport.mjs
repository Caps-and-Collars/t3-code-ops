// Remote execution for the pairing helper: one validated target, no shell interpolation.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { validateTarget } from "./fleet-inventory.mjs";
const exec = promisify(execFile);
export const shellQuote = (text, platform) =>
  platform === "win32"
    ? "'" + text.replaceAll("'", "''") + "'"
    : "'" + text.replaceAll("'", "'\\''") + "'";

// No shell, host discovery, arbitrary error output or configuration guessing on the client.
// The only remote shell input is a quoted executable and a base64-encoded fixed dispatcher.
export async function executeSource(
  target,
  source,
  { timeout = 120_000, ssh = process.env.T3_FLEET_SSH ?? "ssh" } = {},
) {
  validateTarget(target);
  const program = Buffer.from(source, "utf8").toString("base64");
  const expression = "eval(Buffer.from(process.argv[1],'base64').toString('utf8'))";
  try {
    const result = target.ssh
      ? await exec(
          ssh,
          [
            "-T",
            "-n",
            "-o",
            "BatchMode=yes",
            "-o",
            "ConnectTimeout=15",
            target.ssh,
            `${target.platform === "win32" ? "& " : ""}${shellQuote(target.node, target.platform)} -e ${shellQuote(expression, target.platform)} ${shellQuote(program, target.platform)}`,
          ],
          { timeout, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
        )
      : await exec(target.node, ["-e", expression, program], {
          timeout,
          maxBuffer: 16 * 1024 * 1024,
          windowsHide: true,
        });
    return JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
  } catch (error) {
    // execFile errors include the full command (and can contain credentials/output). Never relay them.
    throw new Error(
      `Transport or worker failure for ${target.name} (${error.killed ? "deadline" : (error.code ?? "invalid-result")}).`,
    );
  }
}
