// /diff — open the repo in VS Code with one diff tab per changed file (working tree vs HEAD).
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";

type Change = { path: string; headPath?: string; deleted: boolean };

const exec = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<Buffer> {
  const { stdout } = await exec("git", args, { cwd, encoding: "buffer", maxBuffer: 1 << 28 });
  return stdout;
}

// `code` on PATH, else the CLI bundled inside common VS Code install locations.
const CODE_CANDIDATES = [
  "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
  join(homedir(), "Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"),
  "/usr/share/code/bin/code",
  "/usr/bin/code",
  "/snap/bin/code",
  join(process.env.LOCALAPPDATA ?? "", "Programs/Microsoft VS Code/bin/code.cmd"),
  "C:/Program Files/Microsoft VS Code/bin/code.cmd",
];

async function findCode(): Promise<string> {
  const onPath = await exec("code", ["--version"]).then(() => "code", () => undefined);
  const found = onPath ?? CODE_CANDIDATES.find(existsSync);
  if (!found) throw new Error("VS Code not found: put `code` on PATH");
  return found;
}

async function vscode(code: string, ...args: string[]) {
  await exec(code, ["-r", ...args], { shell: code.endsWith(".cmd") });
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

async function openChange(code: string, root: string, change: Change) {
  const current = join(root, change.path);
  if (!change.headPath) return vscode(code, current); // new or untracked
  const old = await snapshotHead(root, change.headPath);
  if (change.deleted) return vscode(code, old); // nothing left to diff against
  return vscode(code, "--diff", old, current);
}

async function showDiff(cwd: string) {
  const code = await findCode();
  const root = await findRepoRoot(cwd);
  const changes = await listChanges(root);
  await vscode(code, root);
  for (const change of changes) await openChange(code, root, change);
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
