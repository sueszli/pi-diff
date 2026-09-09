// /diff opens the repo in VS Code with one diff tab per changed file, working tree vs HEAD
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";

type Change = { path: string; headPath?: string; deleted: boolean };

const exec = promisify(execFile);

const CODE_CANDIDATES = [
  "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
  join(homedir(), "Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"),
  "/usr/share/code/bin/code",
  "/usr/bin/code",
  "/snap/bin/code",
  join(process.env.LOCALAPPDATA ?? "", "Programs/Microsoft VS Code/bin/code.cmd"),
  "C:/Program Files/Microsoft VS Code/bin/code.cmd",
];

// run git, return stdout as raw bytes so binary blobs survive, throw on non-zero exit
const git = (cwd: string, ...args: string[]) =>
  exec("git", args, { cwd, encoding: "buffer", maxBuffer: 1 << 28 }).then((r) => r.stdout);

// prefer code from PATH, fall back to the CLI bundled with a known VS Code install
const findCode = () =>
  exec("code", ["--version"]).then(
    () => "code",
    () => CODE_CANDIDATES.find(existsSync) ?? Promise.reject(new Error("VS Code not found: put `code` on PATH")),
  );

// open paths in the current VS Code window
const vscode = (code: string, ...args: string[]) => exec(code, ["-r", ...args], { shell: code.endsWith(".cmd") });

// absolute path of the repo containing cwd
const findRepoRoot = (cwd: string) => git(cwd, "rev-parse", "--show-toplevel").then((b) => b.toString().trim());

// parse one porcelain entry "XY path" plus a trailing old path for renames and copies
const takeChange = (fields: string[]): Change => {
  const [x, y, path] = [fields[0][0], fields[0][1], fields.shift()!.slice(3)];
  const headPath = "RC".includes(x) ? fields.shift() : "?A".includes(x) ? undefined : path;
  return { path, headPath, deleted: x === "D" || y === "D" };
};

// list all working tree changes vs HEAD, untracked files included
const listChanges = (root: string) =>
  git(root, "status", "--porcelain", "-z", "-uall").then((b) => {
    const fields = b.toString().split("\0").filter(Boolean);
    const changes: Change[] = [];
    while (fields.length) changes.push(takeChange(fields));
    return changes;
  });

// write the HEAD version of a file to tmp and return its path
const snapshotHead = (root: string, headPath: string) =>
  git(root, "show", `HEAD:${headPath}`).then((blob) => {
    const file = join(tmpdir(), "pi-diff", basename(root), headPath);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, blob);
    return file;
  });

// added file opens as is, deleted file opens the HEAD copy, otherwise diff HEAD vs current
const openChange = (code: string, root: string, { path, headPath, deleted }: Change) =>
  !headPath
    ? vscode(code, join(root, path))
    : snapshotHead(root, headPath).then((old) => (deleted ? vscode(code, old) : vscode(code, "--diff", old, join(root, path))));

// open the repo, then one tab per change, resolve to the change count
const showDiff = async (cwd: string) => {
  const [code, root] = await Promise.all([findCode(), findRepoRoot(cwd)]);
  const changes = await listChanges(root);
  await vscode(code, root);
  for (const change of changes) await openChange(code, root, change);
  return changes.length;
};

// take the first line of stderr or message for the notify bar
const firstLine = (err: any) => String(err.stderr || err.message || err).trim().split("\n")[0];

export default (pi: ExtensionAPI) =>
  pi.registerCommand("diff", {
    description: "Show working tree changes in VS Code",
    handler: (_args, ctx) =>
      showDiff(ctx.cwd)
        .then((n) => ctx.ui.notify(n ? `${n} file(s) → VS Code` : "clean working tree", "info"))
        .catch((err) => ctx.ui.notify(`/diff: ${firstLine(err)}`, "error")),
  });
