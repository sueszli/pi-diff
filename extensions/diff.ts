// /diff — open the repo in VS Code with a diff tab for every changed file (vs HEAD).
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("diff", {
    description: "Show working tree changes in VS Code",
    handler: async (_args, ctx) => {
      const top = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd: ctx.cwd });
      if (top.code !== 0) return ctx.ui.notify("not a git repo", "error");
      const root = top.stdout.trim();

      // "XY path\0" (renames: "XY new\0old\0")
      const status = await pi.exec("git", ["status", "--porcelain", "-z", "-uall"], { cwd: root });
      const parts = status.stdout.split("\0");
      const files: { path: string; base?: string; deleted: boolean }[] = [];
      for (let i = 0; i < parts.length; i++) {
        const e = parts[i];
        if (!e) continue;
        const [x, y] = [e[0], e[1]];
        const path = e.slice(3);
        const base = x === "R" || x === "C" ? parts[++i] : x === "?" || x === "A" ? undefined : path;
        files.push({ path, base, deleted: x === "D" || y === "D" });
      }

      await pi.exec("code", ["-r", root]);
      if (files.length === 0) return ctx.ui.notify("clean working tree", "info");

      const tmp = join(tmpdir(), "pi-diff", basename(root));
      for (const f of files) {
        const cur = join(root, f.path);
        if (!f.base) {
          await pi.exec("code", ["-r", cur]);
          continue;
        }
        const old = join(tmp, f.base);
        mkdirSync(dirname(old), { recursive: true });
        const show = await pi.exec("git", ["show", `HEAD:${f.base}`], { cwd: root });
        writeFileSync(old, show.stdout);
        await pi.exec("code", f.deleted ? ["-r", old] : ["-r", "--diff", old, cur]);
      }
      ctx.ui.notify(`${files.length} file${files.length === 1 ? "" : "s"} → VS Code`, "info");
    },
  });
}
