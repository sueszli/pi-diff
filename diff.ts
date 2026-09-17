import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { execFile } from "node:child_process"
import { existsSync, readdirSync, statSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

type Code = { bin: string, env?: NodeJS.ProcessEnv }

const exec = promisify(execFile)

// vscode paths
const CODE_CANDIDATES = ["/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code", "/usr/share/code/bin/code", "/usr/bin/code", "/snap/bin/code"]

// editors that unpack a server with a remote-cli proxy, as [server dir prefix, cli name]
const REMOTE_EDITORS = [["vscode", "code"], ["cursor", "cursor"], ["windsurf", "windsurf"], ["positron", "positron"]]

// git stdout, throws on non-zero exit
const git = (cwd: string, ...args: string[]) => exec("git", args, { cwd }).then((r) => r.stdout.trim())

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

// open the checkout in the current VS Code window, its git ui takes over from there
const showDiff = async (cwd: string) => {
  const { bin, env } = await findCode()
  // --show-toplevel keeps linked worktrees on themselves, git's own error names no path
  const root = await git(cwd, "rev-parse", "--show-toplevel").catch(() => { throw new Error(`not a git repository: ${cwd}`) })
  await exec(bin, ["-r", root], { env })
  return root
}

export default (pi: ExtensionAPI) =>
  pi.registerCommand("diff", {
    description: "Open the current git worktree in VS Code",
    handler: (_args, ctx) =>
      showDiff(ctx.cwd)
        .then((root) => ctx.ui.notify(`${root} -> VS Code`, "info"))
        // git puts the useful message on stderr, not in err.message
        .catch((err) => ctx.ui.notify(`/diff: ${err.stderr || err.message}`.trim(), "error")),
  })
