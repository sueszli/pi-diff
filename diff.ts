import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { execFile } from "node:child_process"
import { existsSync, readdirSync, statSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { promisify } from "node:util"

type Code = { bin: string, env?: NodeJS.ProcessEnv }

const exec = promisify(execFile)

// vscode paths
const CODE_CANDIDATES = ["/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code", "/usr/share/code/bin/code", "/usr/bin/code", "/snap/bin/code"]

// editors that unpack a server with a remote-cli proxy, as [server dir prefix, cli name]
const REMOTE_EDITORS = [["vscode", "code"], ["cursor", "cursor"], ["windsurf", "windsurf"], ["positron", "positron"]]


// directory entries, empty when the directory is missing
const listDir = (dir: string) => (existsSync(dir) ? readdirSync(dir) : [])

// most recently touched path, the newest server build and newest socket are the live ones
const newest = (paths: string[]) =>
  paths
    .filter(existsSync)
    .map((path) => [statSync(path).mtimeMs, path] as const)
    .sort((a, b) => b[0] - a[0])[0]?.[1]

// socket reaching the attached window, env first then newest on disk since tmux outlives its terminal
const findIpcSocket = () => {
  const fromEnv = process.env.VSCODE_IPC_HOOK_CLI
  const runtime = process.env.XDG_RUNTIME_DIR ?? tmpdir()
  const sockets = listDir(runtime).filter((name) => /^vscode-ipc-.*\.sock$/.test(name))
  return (fromEnv && existsSync(fromEnv) ? fromEnv : undefined) ?? newest(sockets.map((name) => join(runtime, name)))
}

// remote-cli proxy from an unpacked server, forwards over the ssh channel and resolves paths remotely
const findRemoteCli = () =>
  newest(
    REMOTE_EDITORS.flatMap(([dir, cli]) =>
      listDir(join(homedir(), `.${dir}-server`, "bin")).map((build) => join(homedir(), `.${dir}-server`, "bin", build, "bin", "remote-cli", cli)),
    ),
  )

// only a cli that answers --version is live, so a dead socket fails here instead of silently doing nothing
const probe = (code: Code) =>
  exec(code.bin, ["--version"], { env: code.env }).then(
    () => code,
    () => undefined,
  )

// remote proxy first so the folder lands in the attached window, then PATH, then a local gui install
const codeCandidates = (): Code[] => {
  const [socket, remote] = [findIpcSocket(), findRemoteCli()]
  const proxy = socket && remote ? [{ bin: remote, env: { ...process.env, VSCODE_IPC_HOOK_CLI: socket } }] : []
  return [...proxy, { bin: "code" }, ...CODE_CANDIDATES.filter(existsSync).map((bin) => ({ bin }))]
}

// a headless box has no gui install, so the generic PATH hint would be misleading there
const notFound = () =>
  new Error(
    process.env.SSH_CONNECTION || process.env.SSH_TTY
      ? "no VS Code reachable over ssh: run pi in the integrated terminal of a Remote-SSH window"
      : "VS Code not found: put `code` on PATH",
  )

// first live candidate, sequential because probing is cheap and order encodes preference
const findCode = async () => {
  for (const candidate of codeCandidates()) {
    const live = await probe(candidate)
    if (live) return live
  }
  throw notFound()
}
// absolute paths only, a relative tool-call path has no cwd to resolve against
const PATH_TOKEN = /\/(?:Users|home)\/[^\s"'`;:,)\]}>|&]+/g

// repos touched incidentally but never meant: package clones, and pi's own copy of this extension
const DENY = [join(homedir(), ".pi"), join(homedir(), ".claude"), join(homedir(), ".codex"), "/opt/homebrew", "/tmp", "/var"]

// bash mutates files far more often than the edit tool, so scanning only edits picks a stale repo
const mutatedPaths = (entries: readonly any[]) =>
  entries.flatMap((entry) =>
    (entry?.message?.content ?? [])
      .filter((block: any) => block?.type === "toolCall")
      .flatMap((block: any) => {
        const name = block.name
        const args = block.arguments ?? {}
        const blob = name === "edit" || name === "write" ? String(args.path ?? "") : name === "bash" ? String(args.command ?? "") : ""
        return blob.match(PATH_TOKEN) ?? []
      }),
  )

// nearest enclosing checkout, .git is a directory in a main repo but a file in a linked worktree
const gitRoot = (path: string) => {
  let dir = existsSync(path) && statSync(path).isDirectory() ? path : dirname(path)
  while (dir !== dirname(dir)) {
    if (existsSync(join(dir, ".git"))) return dir
    dir = dirname(dir)
  }
}

// checkouts edited this session, newest first, so the repo just worked in opens first
const editedRoots = (entries: readonly any[]) => {
  const roots: string[] = []
  for (const path of mutatedPaths(entries).reverse()) {
    const root = gitRoot(path.replace(/\/+$/, ""))
    if (root && !roots.includes(root) && !DENY.some((deny) => root === deny || root.startsWith(`${deny}/`))) roots.push(root)
  }
  return roots
}

// history first, it survives a cwd that is merely the parent of the repos being edited
const findRoots = (cwd: string, entries: readonly any[]) => {
  const edited = editedRoots(entries)
  if (edited.length) return edited
  const root = gitRoot(cwd)
  if (!root) throw new Error(`no git repository edited this session, and ${cwd} is not one`)
  return [root]
}

// -r reuses the window, so roots after the first need -n or they replace each other
const showDiff = async (cwd: string, entries: readonly any[]) => {
  const { bin, env } = await findCode()
  const roots = findRoots(cwd, entries)
  for (const [index, root] of roots.entries()) await exec(bin, [index ? "-n" : "-r", root], { env })
  return roots
}

export default (pi: ExtensionAPI) =>
  pi.registerCommand("diff", {
    description: "Open the git worktrees edited this session in VS Code",
    handler: (_args, ctx) =>
      // buildContextEntries drops abandoned branches, so a rewound edit no longer votes
      showDiff(ctx.cwd, ctx.sessionManager.buildContextEntries())
        .then((roots) => ctx.ui.notify(`${roots.join(", ")} -> VS Code`, "info"))
        // git puts the useful message on stderr, not in err.message
        .catch((err) => ctx.ui.notify(`/diff: ${err.stderr || err.message}`.trim(), "error")),
  })
