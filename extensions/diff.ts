// /diff — open the repo in VS Code with one diff tab per changed file (working tree vs HEAD).
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";

type Change = { path: string; base?: string; deleted: boolean };

const run = promisify(execFile);
const git = async (cwd: string, ...args: string[]) =>
  (await run("git", args, { cwd, encoding: "buffer", maxBuffer: 1 << 28 })).stdout;
const code = (...args: string[]) => run("code", args);

const repoRoot = async (cwd: string) => (await git(cwd, "rev-parse", "--show-toplevel")).toString().trim();

// porcelain -z: "XY path\0"; renames/copies: "XY new\0old\0"
async function changedFiles(root: string): Promise<Change[]> {
  const fields = (await git(root, "status", "--porcelain", "-z", "-uall")).toString().split("\0");
  const changes: Change[] = [];
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i];
    if (!entry) continue;
    const [x, y, path] = [entry[0], entry[1], entry.slice(3)];
    const isNew = x === "?" || x === "A";
    const base = x === "R" || x === "C" ? fields[++i] : isNew ? undefined : path;
    changes.push({ path, base, deleted: x === "D" || y === "D" });
  }
  return changes;
}

async function snapshotHead(root: string, base: string) {
  const file = join(tmpdir(), "pi-diff", basename(root), base);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, await git(root, "show", `HEAD:${base}`));
  return file;
}

async function openDiff(root: string, change: Change) {
  const current = join(root, change.path);
  if (!change.base) return code("-r", current);
  const old = await snapshotHead(root, change.base);
  return change.deleted ? code("-r", old) : code("-r", "--diff", old, current);
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("diff", {
    description: "Show working tree changes in VS Code",
    handler: async (_args, ctx) => {
      try {
        const root = await repoRoot(ctx.cwd);
        const changes = await changedFiles(root);
        await code("-r", root);
        for (const change of changes) await openDiff(root, change);
        ctx.ui.notify(changes.length ? `${changes.length} file(s) → VS Code` : "clean working tree", "info");
      } catch (err) {
        ctx.ui.notify(`/diff: ${(err as Error).message.split("\n")[0]}`, "error");
      }
    },
  });
}
