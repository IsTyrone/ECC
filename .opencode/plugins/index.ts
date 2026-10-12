/**
 * ECC Plugin Hooks for OpenCode v2
 *
 * V2 port of the original V1 ECC hooks plugin. V1 plugins (default-exported
 * setup function returning a hooks map) do not run on OpenCode v2, so every
 * hook is re-registered here through the v2 Promise API:
 *
 *   V1 hook                        V2 registration
 *   ------------------------------ -------------------------------------------
 *   tool.execute.before            ctx.tool.hook("execute.before", ...)
 *   tool.execute.after             ctx.tool.hook("execute.after", ...)
 *   file.edited                    folded into execute.after for edit/write
 *                                    (v2 has no file.edited hook)
 *   session.created/idle/deleted   ctx.event.subscribe() filtered by type
 *   file.watcher.updated           "filesystem.changed" server event
 *                                    (data: { file, event: add|change|unlink })
 *   todo.updated                   DROPPED — v2 has no todo event
 *   shell.env                      ctx.shell.hook("create.before", ...) mutating
 *                                    event.env (also uses per-call event.cwd)
 *   experimental.session.compacting ctx.session.hook("compaction", ...) pushing
 *                                    the ECC block onto event.system
 *   permission.ask                 ctx.permission.hook("evaluate", ...) setting
 *                                    event.effect / event.message
 *   tool map                       ctx.tool.transform(editor.add(...))
 *
 * Behaviour notes vs v1:
 * - Bash command sniffing (git push reminder, gh pr create log, formatter and
 *   test auto-approvals) now reads the `command` input field directly. The v1
 *   code stringified the whole args object ("[object Object]"), so those
 *   branches silently never fired; they work as originally intended now.
 * - console.log auditing uses direct file reads instead of spawning grep.
 * - Shell commands run through a lazily imported bun shell so this module can
 *   still be imported under plain Node (tests); every shell call site already
 *   tolerates failure.
 */

import { Plugin } from "@opencode/plugin"
import * as fs from "fs"
import * as path from "path"
import { createRequire } from "node:module"

// import.meta.dir is bun-specific; fall back so node-based tooling can still
// parse/evaluate this module without throwing at import time.
const PLUGIN_DIR: string =
  (import.meta as unknown as { dir?: unknown }).dir &&
  typeof (import.meta as unknown as { dir?: unknown }).dir === "string"
    ? ((import.meta as unknown as { dir: string }).dir as string)
    : process.cwd()

type HookProfile = "minimal" | "standard" | "strict"

interface ToolArgs {
  filePath?: unknown
  file_path?: unknown
  path?: unknown
  command?: unknown
  [key: string]: unknown
}

function normalizeProfile(value: string | undefined): HookProfile {
  if (value === "minimal" || value === "strict") return value
  return "standard"
}

/** Extract a file path from a tool input object, tolerating shape drift. */
function getFilePath(input: unknown): string | null {
  if (!input || typeof input !== "object") return null
  const args = input as ToolArgs
  const p = args.filePath ?? args.file_path ?? args.path
  return typeof p === "string" && p.trim() ? p : null
}

function getCommand(input: unknown): string {
  if (typeof input === "string") return input
  if (!input || typeof input !== "object") return ""
  const cmd = (input as ToolArgs).command
  return typeof cmd === "string" ? cmd : ""
}

function countConsoleLogs(filePath: string): number {
  try {
    const text = fs.readFileSync(filePath, "utf-8")
    const matches = text.match(/console\.log\b/g)
    return matches ? matches.length : 0
  } catch {
    return 0
  }
}

/**
 * Read the ECC version from the nearest package.json, probing both the TS
 * source layout (`<root>/package.json`) and the compiled dist layout
 * (`<root>/dist/...` -> `<root>/package.json`). Kept in sync with release.sh
 * and tests/plugin-manifest.test.js via the `## Active Plugin: ECC vX.Y.Z`
 * banner below — do not remove that literal.
 */
function readPackageVersion(): string {
  const candidates = [
    path.join(PLUGIN_DIR, "..", "package.json"),
    path.join(PLUGIN_DIR, "..", "..", "package.json"),
  ]
  for (const file of candidates) {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf-8"))
      const version =
        parsed && typeof parsed === "object"
          ? (parsed as Record<string, unknown>).version
          : undefined
      if (typeof version === "string" && version) return version
    } catch {
      // try the next candidate
    }
  }
  return "2.0.0"
}

type BunShell = (
  strings: TemplateStringsArray,
  ...values: unknown[]
) => Promise<unknown> & { text(): Promise<string> }

// The plugin runs inside OpenCode's bun runtime, but `tsc` builds and plain
// Node test runs must still import this module. Resolve the bun shell lazily
// via require() so non-bun runtimes get `undefined` (every call site already
// tolerates a missing shell) instead of a hard module-load failure.
let shellProbed = false
let cachedShell: BunShell | undefined
function getShell(): BunShell | undefined {
  if (!shellProbed) {
    shellProbed = true
    try {
      const require = createRequire(import.meta.url)
      cachedShell = (require("bun") as { $: BunShell }).$
    } catch {
      cachedShell = undefined
    }
  }
  return cachedShell
}

export default Plugin.define({
  id: "ecc-hooks",
  async setup(ctx) {
    const locationDir: string = ctx.location.directory || process.cwd()
    const projectDir: string =
      (ctx.location.project &&
        typeof ctx.location.project === "object" &&
        typeof (ctx.location.project as { directory?: unknown }).directory === "string"
        ? ((ctx.location.project as { directory: string }).directory as string)
        : locationDir) || locationDir

    // Call sites already carry the "[ECC]" prefix (kept from v1); pass through.
    const log = (level: "debug" | "info" | "warn" | "error", message: string) => {
      if (level === "warn") console.warn(message)
      else if (level === "error") console.error(message)
      else if (level === "debug") console.debug(message)
      else console.log(message)
    }

    const editedFiles = new Set<string>()
    const pendingToolChanges = new Map<string, { path: string; type: "added" | "modified" }>()
    const sessionDirs = new Map<string, string>()

    const currentProfile = normalizeProfile(process.env.ECC_HOOK_PROFILE)
    const disabledHooks = new Set(
      (process.env.ECC_DISABLED_HOOKS || "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
    )
    const profileOrder: Record<HookProfile, number> = {
      minimal: 0,
      standard: 1,
      strict: 2,
    }
    const hookEnabled = (
      hookId: string,
      required: HookProfile | HookProfile[] = "standard"
    ): boolean => {
      if (disabledHooks.has(hookId)) return false
      const need = Array.isArray(required) ? required : [required]
      return need.some((entry) => profileOrder[currentProfile] >= profileOrder[entry])
    }

    function resolvePath(p: string, base: string): string {
      if (path.isAbsolute(p)) return p
      return path.join(base, p)
    }

    function hasProjectFile(relativePath: string, base: string): boolean {
      try {
        return fs.statSync(resolvePath(relativePath, base)).isFile()
      } catch {
        return false
      }
    }

    /** Best-effort per-session working directory, cached. */
    async function sessionDir(sessionID: string): Promise<string> {
      const cached = sessionDirs.get(sessionID)
      if (cached) return cached
      try {
        const info = (await ctx.session.get({ sessionID })) as unknown as
          | Record<string, unknown>
          | undefined
        if (info && typeof info === "object") {
          for (const key of ["directory", "worktree", "cwd"]) {
            const value = info[key]
            if (typeof value === "string" && value) {
              sessionDirs.set(sessionID, value)
              return value
            }
          }
        }
      } catch {
        // fall through to the plugin location directory
      }
      return projectDir
    }

    // Lazily loaded so a missing or partial plugins/lib directory only
    // disables changed-files tracking instead of failing plugin setup.
    // (See original v1 comment re: interrupted installs.)
    let changedFilesStore:
      | typeof import("./lib/changed-files-store.js")
      | undefined
    try {
      const store = await import("./lib/changed-files-store.js")
      store.initStore(projectDir)
      changedFilesStore = store
    } catch {
      log(
        "warn",
        "[ECC] changed-files tracking disabled: could not load the changed-files store. " +
          "Run `ecc repair --target opencode` to restore the missing files. Other ECC hooks are unaffected."
      )
    }

    async function runPrettier(filePath: string): Promise<void> {
      const $ = getShell()
      if (!$) {
        log("debug", `[ECC] Skipping prettier (no shell runtime): ${filePath}`)
        return
      }
      try {
        await $`prettier --write ${filePath}`
        log("info", `[ECC] Formatted: ${filePath}`)
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error)
        log("debug", `[ECC] Prettier formatting failed for ${filePath}: ${msg}`)
      }
    }

    async function runTypeCheck(): Promise<void> {
      const $ = getShell()
      if (!$) {
        log("debug", "[ECC] Skipping tsc check (no shell runtime)")
        return
      }
      try {
        await $`npx tsc --noEmit`
        log("info", "[ECC] TypeScript check passed")
      } catch (error: unknown) {
        log("warn", "[ECC] TypeScript errors detected")
        const stdout = (error as { stdout?: unknown }).stdout
        if (typeof stdout === "string") {
          for (const line of stdout.split("\n").slice(0, 5)) log("warn", `  ${line}`)
        } else {
          const msg = error instanceof Error ? error.message : String(error)
          if (msg) log("warn", `  ${msg.split("\n")[0]}`)
        }
      }
    }

    // ------------------------------------------------------------------
    // tool.execute.before — pre-tool security nudges + write tracking
    // ------------------------------------------------------------------
    await ctx.tool.hook("execute.before", async (event) => {
      const toolName = event.tool
      const input = event.input
      const filePath = getFilePath(input)

      if (toolName === "write" && filePath) {
        const base = await sessionDir(event.sessionID)
        const absPath = resolvePath(filePath, base)
        let type: "added" | "modified" = "modified"
        try {
          type = fs.existsSync(absPath) ? "modified" : "added"
        } catch {
          type = "modified"
        }
        pendingToolChanges.set(String(event.id), { path: filePath, type })
      }

      const command = getCommand(input)

      if (
        hookEnabled("pre:bash:git-push-reminder", "strict") &&
        toolName === "bash" &&
        command.includes("git push")
      ) {
        log("info", "[ECC] Remember to review changes before pushing: git diff origin/main...HEAD")
      }

      if (
        hookEnabled("pre:write:doc-file-warning", ["standard", "strict"]) &&
        toolName === "write" &&
        typeof filePath === "string" &&
        filePath.match(/\.(md|txt)$/i) &&
        !filePath.includes("README") &&
        !filePath.includes("CHANGELOG") &&
        !filePath.includes("LICENSE") &&
        !filePath.includes("CONTRIBUTING")
      ) {
        log("warn", `[ECC] Creating ${filePath} - consider if this documentation is necessary`)
      }

      if (hookEnabled("pre:bash:tmux-reminder", "strict") && toolName === "bash") {
        if (
          command.match(/^(npm|pnpm|yarn|bun)\s+(install|build|test|run)/) ||
          command.match(/^cargo\s+(build|test|run)/) ||
          command.match(/^go\s+(build|test|run)/)
        ) {
          log("info", "[ECC] Long-running command detected - consider using background execution")
        }
      }
    })

    // ------------------------------------------------------------------
    // tool.execute.after — change tracking, format, typecheck
    // (absorbs the v1 file.edited hook; v2 has no equivalent event)
    // ------------------------------------------------------------------
    await ctx.tool.hook("execute.after", async (event) => {
      if (event.status !== "completed") return
      const toolName = event.tool
      const input = event.input
      const filePath = getFilePath(input)

      if (toolName === "edit" && filePath) {
        changedFilesStore?.recordChange(filePath, "modified")
      }
      if (toolName === "write" && filePath) {
        const key = String(event.id)
        const pending = pendingToolChanges.get(key)
        if (pending) {
          changedFilesStore?.recordChange(pending.path, pending.type)
          pendingToolChanges.delete(key)
        } else {
          changedFilesStore?.recordChange(filePath, "modified")
        }
      }

      if ((toolName === "edit" || toolName === "write") && filePath) {
        editedFiles.add(filePath)

        if (hookEnabled("post:edit:format", ["strict"]) && filePath.match(/\.(ts|tsx|js|jsx)$/)) {
          await runPrettier(filePath)
        }

        if (
          hookEnabled("post:edit:console-warn", ["standard", "strict"]) &&
          filePath.match(/\.(ts|tsx|js|jsx)$/)
        ) {
          const count = countConsoleLogs(resolvePath(filePath, projectDir))
          if (count > 0) {
            log("warn", `[ECC] console.log found in ${filePath} (${count} occurrence${count > 1 ? "s" : ""})`)
          }
        }
      }

      if (
        hookEnabled("post:edit:typecheck", ["strict"]) &&
        toolName === "edit" &&
        typeof filePath === "string" &&
        filePath.match(/\.tsx?$/)
      ) {
        await runTypeCheck()
      }

      const command = getCommand(input)
      if (
        hookEnabled("post:bash:pr-created", ["standard", "strict"]) &&
        toolName === "bash" &&
        command.includes("gh pr create")
      ) {
        log("info", "[ECC] PR created - check GitHub Actions status")
      }
    })

    // ------------------------------------------------------------------
    // shell.create.before — environment injection (v1 shell.env)
    // ------------------------------------------------------------------
    await ctx.shell.hook("create.before", (event) => {
      event.env.ECC_VERSION = readPackageVersion()
      event.env.ECC_PLUGIN = "true"
      event.env.ECC_HOOK_PROFILE = currentProfile
      event.env.ECC_DISABLED_HOOKS = process.env.ECC_DISABLED_HOOKS || ""
      event.env.PROJECT_ROOT = event.cwd || projectDir

      const base = event.cwd || projectDir
      const lockfiles: Record<string, string> = {
        "bun.lockb": "bun",
        "pnpm-lock.yaml": "pnpm",
        "yarn.lock": "yarn",
        "package-lock.json": "npm",
      }
      for (const [lockfile, pm] of Object.entries(lockfiles)) {
        if (hasProjectFile(lockfile, base)) {
          event.env.PACKAGE_MANAGER = pm
          break
        }
      }

      const langDetectors: Record<string, string> = {
        "tsconfig.json": "typescript",
        "go.mod": "go",
        "pyproject.toml": "python",
        "Cargo.toml": "rust",
        "Package.swift": "swift",
      }
      const detected: string[] = []
      for (const [file, lang] of Object.entries(langDetectors)) {
        if (hasProjectFile(file, base)) detected.push(lang)
      }
      if (detected.length > 0) {
        event.env.DETECTED_LANGUAGES = detected.join(",")
        event.env.PRIMARY_LANGUAGE = detected[0]
      }
    })

    // ------------------------------------------------------------------
    // permission.evaluate — audit + auto-approve safe ops (v1 permission.ask)
    // ------------------------------------------------------------------
    await ctx.permission.hook("evaluate", async (event) => {
      log(
        "info",
        `[ECC] Permission requested: action=${event.action} resources=${event.resources.join(", ")}`
      )
      try {
        const resourcesText = event.resources.join("\n")

        if (["read", "glob", "grep", "search", "list"].includes(event.action)) {
          log("debug", `[ECC] Auto-approved read-only action: ${event.action}`)
          event.effect = "allow"
          event.message = "Read-only operation"
          return
        }

        if (
          event.action === "bash" &&
          /^(npx )?(@biomejs\/biome|prettier|black|gofmt|rustfmt|swift-format)/.test(
            resourcesText.trim()
          )
        ) {
          log("debug", "[ECC] Auto-approved formatter")
          event.effect = "allow"
          event.message = "Formatter execution"
          return
        }

        if (
          event.action === "bash" &&
          /^(npm test|npx vitest|npx jest|pytest|go test|cargo test)/.test(resourcesText.trim())
        ) {
          log("debug", "[ECC] Auto-approved test execution")
          event.effect = "allow"
          event.message = "Test execution"
          return
        }

        log("debug", `[ECC] Permission requires user decision: ${event.action}`)
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error)
        log("error", `[ECC] Permission handling error for ${event.action}: ${msg}`)
        event.effect = "deny"
        event.message = `Error: ${msg}`
      }
    })

    // ------------------------------------------------------------------
    // compaction — preserve ECC context across compaction
    // (v1 experimental.session.compacting; v2 exposes system/messages)
    // ------------------------------------------------------------------
    await ctx.session.hook("compaction", (event) => {
      const lines = [
        "# ECC Context (preserve across compaction)",
        "",
        "## Active Plugin: ECC v2.2.0",
        "- Hooks: tool.execute.before/after, session lifecycle, shell env, compaction, permission",
        "- Tools: changed-files, dependency-analyzer",
        "- Agents: specialized (planner, architect, tdd-guide, code-reviewer, security-reviewer, build-error-resolver, e2e-runner, refactor-cleaner, doc-updater, go-reviewer, go-build-resolver, database-reviewer, python-reviewer)",
        "",
        "## Key Principles",
        "- TDD: write tests first, 80%+ coverage",
        "- Immutability: never mutate, always return new copies",
        "- Security: validate inputs, no hardcoded secrets",
        "",
        "Focus on preserving: 1) Current task status and progress, 2) Key decisions made, 3) Files created/modified, 4) Remaining work items, 5) Any security concerns flagged. Discard: verbose tool outputs, intermediate exploration, redundant file listings.",
        "",
      ]
      if (editedFiles.size > 0) {
        lines.push("## Recently Edited Files")
        for (const f of editedFiles) lines.push(`- ${f}`)
        lines.push("")
      }
      event.system.push({ type: "text", text: lines.join("\n") })
    })

    // ------------------------------------------------------------------
    // Custom tools (v1 `tool` map -> ctx.tool.transform)
    // ------------------------------------------------------------------
    await ctx.tool.transform((editor) => {
      editor.add({
        name: "changed-files",
        description:
          "List files changed by agents in this session as a navigable tree. Shows added (+), modified (~), and deleted (-) indicators. Use filter to show only specific change types. Returns paths for git diff.",
        input: {
          type: "object",
          properties: {
            filter: {
              type: "string",
              enum: ["all", "added", "modified", "deleted"],
              description: "Filter by change type (default: all)",
            },
            format: {
              type: "string",
              enum: ["tree", "json"],
              description: "Output format: tree for terminal display, json for structured data (default: tree)",
            },
          },
          additionalProperties: false,
        },
        execute: async (raw) => {
          const { runChangedFiles } = await import("../tools/changed-files.js")
          const args = (raw ?? {}) as { filter?: string; format?: string }
          return { content: await runChangedFiles(args) }
        },
      })

      editor.add({
        name: "dependency-analyzer",
        description:
          "Analyze project dependencies for outdated packages, security vulnerabilities, and unused dependencies. Supports npm, pnpm, yarn, and bun.",
        input: {
          type: "object",
          properties: {
            type: {
              type: "string",
              enum: ["all", "outdated", "security", "unused"],
              description: "Type of analysis to run (default: all)",
            },
            fix: {
              type: "boolean",
              description: "Attempt to fix issues automatically (default: false)",
            },
            depth: {
              type: "number",
              description: "Depth of dependency analysis (default: 1)",
            },
          },
          additionalProperties: false,
        },
        execute: async (raw) => {
          const { runDependencyAnalyzer } = await import("../tools/dependency-analyzer.js")
          const args = (raw ?? {}) as { type?: string; fix?: boolean; depth?: number }
          return { content: await runDependencyAnalyzer(args, projectDir) }
        },
      })
    })

    // ------------------------------------------------------------------
    // Session lifecycle + filesystem events via server event stream.
    // ------------------------------------------------------------------
    const onSessionCreated = (data: Record<string, unknown>) => {
      if (!hookEnabled("session:start", ["minimal", "standard", "strict"])) return
      log("info", `[ECC] Session started - profile=${currentProfile}`)
      const dir = typeof data.directory === "string" ? data.directory : projectDir
      if (hasProjectFile("CLAUDE.md", dir)) {
        log("info", "[ECC] Found CLAUDE.md - loading project context")
      }
    }

    const onSessionIdle = async () => {
      if (!hookEnabled("stop:check-console-log", ["minimal", "standard", "strict"])) return
      if (editedFiles.size === 0) return
      log("info", "[ECC] Session idle - running console.log audit")

      let total = 0
      const filesWithLogs: string[] = []
      for (const file of editedFiles) {
        if (!file.match(/\.(ts|tsx|js|jsx)$/)) continue
        const count = countConsoleLogs(resolvePath(file, projectDir))
        if (count > 0) {
          total += count
          filesWithLogs.push(file)
        }
      }

      if (total > 0) {
        log("warn", `[ECC] Audit: ${total} console.log statement(s) in ${filesWithLogs.length} file(s)`)
        for (const f of filesWithLogs) log("warn", `  - ${f}`)
        log("warn", "[ECC] Remove console.log statements before committing")
      } else {
        log("info", "[ECC] Audit passed: No console.log statements found")
      }

      try {
        const $ = getShell()
        if (!$) {
          log("debug", "[ECC] Skipping desktop notification (no shell runtime)")
        } else if (process.platform === "darwin") {
          await $`osascript -e 'display notification "Task completed!" with title "OpenCode ECC"'`
        } else if (process.platform === "win32") {
          await $`powershell -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show('Task completed!', 'OpenCode ECC', 'OK', 'Information')"`
        } else if (process.platform === "linux") {
          await $`notify-send "OpenCode ECC" "Task completed!"`
        }
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error)
        log("debug", `[ECC] Desktop notification failed: ${msg}`)
      }

      editedFiles.clear()
    }

    const onSessionDeleted = () => {
      if (!hookEnabled("session:end-marker", ["minimal", "standard", "strict"])) return
      log("info", "[ECC] Session ended - cleaning up")
      editedFiles.clear()
      changedFilesStore?.clearChanges()
      pendingToolChanges.clear()
    }

    const controller = new AbortController()
    void (async () => {
      try {
        for await (const raw of ctx.event.subscribe({ signal: controller.signal })) {
          const evt = raw as unknown as { type?: unknown; data?: unknown }
          if (typeof evt.type !== "string") continue
          const data =
            evt.data && typeof evt.data === "object"
              ? (evt.data as Record<string, unknown>)
              : {}
          try {
            switch (evt.type) {
              case "session.created":
                onSessionCreated(data)
                break
              case "session.idle":
                await onSessionIdle()
                break
              case "session.deleted":
                onSessionDeleted()
                break
              case "filesystem.changed": {
                // data: { file, event: add | change | unlink }
                const file = data.file
                const kind = data.event
                if (typeof file !== "string" || !file) break
                const changeType =
                  kind === "add" ? "added" : kind === "unlink" ? "deleted" : "modified"
                changedFilesStore?.recordChange(file, changeType)
                if (kind === "change" && file.match(/\.(ts|tsx|js|jsx)$/)) {
                  editedFiles.add(file)
                }
                break
              }
              default:
                break
            }
          } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error)
            log("debug", `[ECC] Event handler error (${evt.type}): ${msg}`)
          }
        }
      } catch {
        // Aborted on unload — expected.
      }
    })()

    log("info", `[ECC] Plugin loaded - profile=${currentProfile}`)
    return () => controller.abort()
  },
})
