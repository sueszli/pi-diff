// /diff — open the repo in VS Code with one diff tab per changed file (working tree vs HEAD).
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";

type Change = { path: string; headPath?: string; deleted: boolean };

const exec = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<Buffer> {
  const { stdout } = await exec("git", args, { cwd, encoding: "buffer", maxBuffer: 1 << 28 });
  return stdout;
}

async function vscode(...args: string[]) {
  await exec("code", ["-r", ...args]);
}

async function findRepoRoot(cwd: string) {
  return (await git(cwd, "rev-parse", "--show-toplevel")).toString().trim();
}

// Consumes one porcelain entry: "XY path", plus a trailing "oldpath" for renames/copies.
function takeChange(fields: string[]): Change {
  const entry = fields.shift()!;
  const [x, y, path] = [entry[0], entry[1], entry.slice(3)];
  const isRenamed = x === "R" || x === "C";
  const isNew = x === "?" || x === "A";
  const headPath = isRenamed ? fields.shift() : isNew ? undefined : path;
  return { path, headPath, deleted: x === "D" || y === "D" };
}

async function listChanges(root: string): Promise<Change[]> {
  const out = await git(root, "status", "--porcelain", "-z", "-uall");
  const fields = out.toString().split("\0").filter(Boolean);
  const changes: Change[] = [];
  while (fields.length) changes.push(takeChange(fields));
  return changes;
}

async function snapshotHead(root: string, headPath: string) {
  const file = join(tmpdir(), "pi-diff", basename(root), headPath);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, await git(root, "show", `HEAD:${headPath}`));
  return file;
}

async function openChange(root: string, change: Change) {
  const current = join(root, change.path);
  if (!change.headPath) return vscode(current); // new or untracked
  const old = await snapshotHead(root, change.headPath);
  if (change.deleted) return vscode(old); // nothing left to diff against
  return vscode("--diff", old, current);
}

async function showDiff(cwd: string) {
  const root = await findRepoRoot(cwd);
  const changes = await listChanges(root);
  await vscode(root);
  for (const change of changes) await openChange(root, change);
  return changes.length;
}

const firstLine = (err: any) => String(err.stderr || err.message || err).trim().split("\n")[0];

export default function (pi: ExtensionAPI) {
  pi.registerCommand("diff", {
    description: "Show working tree changes in VS Code",
    handler: (_args, ctx) =>
      showDiff(ctx.cwd)
        .then((n) => ctx.ui.notify(n ? `${n} file(s) → VS Code` : "clean working tree", "info"))
        .catch((err) => ctx.ui.notify(`/diff: ${firstLine(err)}`, "error")),
  });
}
