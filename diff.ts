// /diff - open the repo in VS Code with one diff tab per changed file (working tree vs HEAD)
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { execFile } from "node:child_process"
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { promisify } from "node:util"

type Change = { path: string, headPath?: string }
type Code = { bin: string, env?: NodeJS.ProcessEnv }

const exec = promisify(execFile)

// vscode paths
const CODE_CANDIDATES = ["/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code", "/usr/share/code/bin/code", "/usr/bin/code", "/snap/bin/code"]

// editors that unpack a server with a remote-cli proxy, as [server dir prefix, cli name]
const REMOTE_EDITORS = [["vscode", "code"], ["cursor", "cursor"], ["windsurf", "windsurf"], ["positron", "positron"]]

// git stdout as raw bytes so binary blobs survive, throws on non-zero exit
const git = (cwd: string, ...args: string[]) => exec("git", args, { cwd, encoding: "buffer", maxBuffer: 1 << 28 }).then((r) => r.stdout)

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

// only a cli that answers --version is live, so a dead socket fails here and not halfway through the tabs
const probe = (code: Code) =>
  exec(code.bin, ["--version"], { env: code.env }).then(
    () => code,
    () => undefined,
  )

// remote proxy first so tabs land in the attached window, then PATH, then a local gui install
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

// open paths in the current VS Code window, env carries the ipc socket for the remote proxy
const vscode = ({ bin, env }: Code, ...args: string[]) => exec(bin, ["-r", ...args], { env })

// one porcelain entry "XY path" (+ trailing "oldpath" for renames/copies) -> Change
const takeChange = (fields: string[]): Change => {
  const entry = fields.shift()!
  const [x, path] = [entry[0], entry.slice(3)]
  return { path, headPath: "RC".includes(x) ? fields.shift() : "?A".includes(x) ? undefined : path }
}

// all working tree changes vs HEAD, untracked files included
const listChanges = (root: string) =>
  git(root, "status", "--porcelain", "-z", "-uall").then((b) => {
    const fields = b.toString().split("\0").filter(Boolean)
    const changes: Change[] = []
    while (fields.length) changes.push(takeChange(fields))
    return changes
  })

// write HEAD's version of a file to tmp, return its path
const snapshotHead = (root: string, headPath: string) =>
  git(root, "show", `HEAD:${headPath}`).then((blob) => {
    const file = join(tmpdir(), "pi-diff", basename(root), headPath)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, blob)
    return file
  })

// new -> open file, deleted -> open old, else diff old vs current
const openChange = (code: Code, root: string, { path, headPath }: Change) => {
  const current = join(root, path)
  if (!headPath) return vscode(code, current)
  return snapshotHead(root, headPath).then((old) => (existsSync(current) ? vscode(code, "--diff", old, current) : vscode(code, old)))
}

// open repo, then one tab per change, resolves to change count
const showDiff = async (cwd: string) => {
  const code = await findCode()
  const root = (await git(cwd, "rev-parse", "--show-toplevel")).toString().trim()
  const changes = await listChanges(root)
  await vscode(code, root)
  for (const change of changes) await openChange(code, root, change)
  return changes.length
}

export default (pi: ExtensionAPI) =>
  pi.registerCommand("diff", {
    description: "Show working tree changes in VS Code",
    handler: (_args, ctx) =>
      showDiff(ctx.cwd)
        .then((n) => ctx.ui.notify(n ? `${n} file(s) -> VS Code` : "clean working tree", "info"))
        // git puts the useful message on stderr, not in err.message
        .catch((err) => ctx.ui.notify(`/diff: ${err.stderr || err.message}`.trim(), "error")),
  })
