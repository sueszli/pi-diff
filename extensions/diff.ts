/**
 * /diff [ref] [--max N]
 *
 * Opens the current git repo in VS Code and shows the changed files as
 * side-by-side diff tabs (base version vs. working tree).
 *
 *   /diff            -> working tree vs HEAD (staged + unstaged + untracked)
 *   /diff main       -> working tree vs `main`
 *   /diff HEAD~3     -> working tree vs 3 commits ago
 *   /diff --max 50   -> raise the tab cap (default 20)
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, basename, extname } from "node:path";

type Status = "M" | "A" | "D" | "R" | "?" | "T" | "U";
type Change = { status: Status; path: string; oldPath?: string };

const DEFAULT_MAX = 20;

export default function (pi: ExtensionAPI) {
  const git = async (args: string[], cwd: string) => {
    const r = await pi.exec("git", args, { cwd, timeout: 15_000 });
    if (r.code !== 0) throw new Error(r.stderr.trim() || `git ${args.join(" ")} failed`);
    return r.stdout;
  };

  async function collectChanges(root: string, base: string | undefined): Promise<Change[]> {
    const changes = new Map<string, Change>();

    if (!base) {
      // porcelain v1 with -z: "XY path\0" and for renames "XY new\0old\0"
      const out = await git(["status", "--porcelain=v1", "-z", "--untracked-files=all"], root);
      const parts = out.split("\0");
      for (let i = 0; i < parts.length; i++) {
        const entry = parts[i];
        if (!entry) continue;
        const x = entry[0];
        const y = entry[1];
        const path = entry.slice(3);
        let oldPath: string | undefined;
        if (x === "R" || x === "C") oldPath = parts[++i];
        let status: Status;
        if (x === "?" && y === "?") status = "?";
        else if (x === "D" || y === "D") status = "D";
        else if (x === "A") status = "A";
        else if (x === "R") status = "R";
        else if (x === "U" || y === "U") status = "U";
        else status = "M";
        changes.set(path, { status, path, oldPath });
      }
    } else {
      const out = await git(["diff", "--name-status", "-z", "-M", base], root);
      const parts = out.split("\0");
      for (let i = 0; i < parts.length; i++) {
        const code = parts[i];
        if (!code) continue;
        const kind = code[0] as Status;
        if (kind === "R" || (kind as string) === "C") {
          const oldPath = parts[++i];
          const path = parts[++i];
          changes.set(path, { status: "R", path, oldPath });
        } else {
          const path = parts[++i];
          changes.set(path, { status: kind === "T" ? "M" : kind, path });
        }
      }
      const untracked = await git(["ls-files", "--others", "--exclude-standard", "-z"], root);
      for (const p of untracked.split("\0")) if (p) changes.set(p, { status: "?", path: p });
    }

    return [...changes.values()].sort((a, b) => a.path.localeCompare(b.path));
  }

  pi.registerCommand("diff", {
    description: "Open repo in VS Code with diff tabs for changed files (optional: base ref)",
    handler: async (args, ctx) => {
      // --- parse args
      const tokens = (args ?? "").trim().split(/\s+/).filter(Boolean);
      let max = DEFAULT_MAX;
      let base: string | undefined;
      for (let i = 0; i < tokens.length; i++) {
        if (tokens[i] === "--max") max = Number(tokens[++i]) || DEFAULT_MAX;
        else base = tokens[i];
      }

      // --- locate repo
      let root: string;
      try {
        root = (await git(["rev-parse", "--show-toplevel"], ctx.cwd)).trim();
      } catch {
        ctx.ui.notify(`Not a git repository: ${ctx.cwd}`, "error");
        return;
      }
      if (base) {
        try {
          await git(["rev-parse", "--verify", "--quiet", `${base}^{commit}`], root);
        } catch {
          ctx.ui.notify(`Unknown ref: ${base}`, "error");
          return;
        }
      }
      const baseRef = base ?? "HEAD";

      // --- collect
      let changes: Change[];
      try {
        changes = await collectChanges(root, base);
      } catch (e) {
        ctx.ui.notify(`git failed: ${(e as Error).message}`, "error");
        return;
      }

      if (changes.length === 0) {
        ctx.ui.notify(`No changes vs ${baseRef} in ${root}`, "info");
        await pi.exec("code", ["-r", root]);
        return;
      }

      // --- open folder
      const folder = await pi.exec("code", ["-r", root]);
      if (folder.code !== 0) {
        ctx.ui.notify(`Could not launch VS Code: ${folder.stderr.trim()}`, "error");
        return;
      }

      // --- open a diff tab per file
      const tmpRoot = join(tmpdir(), "pi-vscode-diff", basename(root), baseRef.replace(/[^\w.-]/g, "_"));
      const opened: Change[] = [];
      const skipped: Change[] = [];

      for (const c of changes) {
        if (opened.length >= max) {
          skipped.push(c);
          continue;
        }
        const abs = join(root, c.path);
        try {
          if (c.status === "?" || c.status === "A") {
            await pi.exec("code", ["-r", abs]);
          } else {
            const srcPath = c.oldPath ?? c.path;
            const show = await pi.exec("git", ["show", `${baseRef}:${srcPath}`], { cwd: root });
            if (show.code !== 0) throw new Error(show.stderr.trim());
            // keep extension so VS Code picks the right language
            const tmp = join(tmpRoot, dirname(srcPath), `${basename(srcPath, extname(srcPath))}@${baseRef.replace(/[^\w.-]/g, "_")}${extname(srcPath)}`);
            mkdirSync(dirname(tmp), { recursive: true });
            writeFileSync(tmp, show.stdout);
            if (c.status === "D" || !existsSync(abs)) {
              await pi.exec("code", ["-r", tmp]);
            } else {
              await pi.exec("code", ["-r", "--diff", tmp, abs]);
            }
          }
          opened.push(c);
        } catch (e) {
          skipped.push(c);
        }
      }

      // --- report in pi
      pi.appendEntry("vscode-diff", { root, base: baseRef, opened, skipped, max });
      ctx.ui.notify(
        `Opened ${opened.length} diff${opened.length === 1 ? "" : "s"} vs ${baseRef} in VS Code` +
          (skipped.length ? ` (${skipped.length} not opened, cap ${max})` : ""),
        "info",
      );
    },
  });

  pi.registerEntryRenderer("vscode-diff", (entry, { expanded }, theme) => {
    const d = entry.data as { root: string; base: string; opened: Change[]; skipped: Change[]; max: number };
    const box = new Box(1, 1, (t) => theme.bg("customMessageBg", t));
    const label: Record<Status, string> = {
      M: theme.fg("warning", "M"),
      A: theme.fg("success", "A"),
      "?": theme.fg("success", "?"),
      D: theme.fg("error", "D"),
      R: theme.fg("accent", "R"),
      T: theme.fg("warning", "T"),
      U: theme.fg("error", "U"),
    };
    const lines = [theme.bold(`/diff vs ${d.base}`) + theme.fg("dim", `  ${d.root}`)];
    const list = expanded ? d.opened : d.opened.slice(0, 15);
    for (const c of list) {
      const rename = c.oldPath ? theme.fg("dim", ` (from ${c.oldPath})`) : "";
      lines.push(`  ${label[c.status] ?? c.status} ${c.path}${rename}`);
    }
    if (!expanded && d.opened.length > list.length) lines.push(theme.fg("dim", `  … ${d.opened.length - list.length} more`));
    if (d.skipped.length) lines.push(theme.fg("dim", `  ${d.skipped.length} not opened (cap ${d.max}, use /diff --max N)`));
    box.addChild(new Text(lines.join("\n")));
    return box;
  });
}
