/**
 * Tests for the OpenCode v2 hook plugin surface.
 *
 * The plugin default-exports a v2 definition ({ id, setup }); setup registers
 * hooks/transforms on the provided context. Tests drive setup with a fake
 * context, capture the registered callbacks, and invoke them with v2-shaped
 * events. Run with: node tests/opencode-plugin-hooks.test.js
 */

const assert = require("node:assert")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { spawnSync } = require("node:child_process")
const { pathToFileURL } = require("node:url")

function runTest(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(`  ✓ ${name}`)
      return { passed: 1, failed: 0 }
    })
    .catch((error) => {
      console.log(`  ✗ ${name}`)
      console.error(`    ${error.stack || error.message}`)
      return { passed: 0, failed: 1 }
    })
}

async function loadPlugin() {
  const repoRoot = path.join(__dirname, "..")
  const buildResult = spawnSync("node", [path.join(repoRoot, "scripts", "build-opencode.js")], {
    cwd: repoRoot,
    encoding: "utf8",
  })
  assert.strictEqual(buildResult.status, 0, buildResult.stderr || buildResult.stdout)
  const pluginUrl = pathToFileURL(
    path.join(repoRoot, ".opencode", "dist", "plugins", "index.js")
  ).href
  return import(pluginUrl)
}

async function captureConsole(fn) {
  const out = []
  const methods = ["log", "warn", "error", "debug"]
  const original = {}
  for (const method of methods) {
    original[method] = console[method]
    console[method] = (...args) => {
      out.push({ level: method, message: args.map(String).join(" ") })
    }
  }
  try {
    const result = await fn()
    return { out, result }
  } finally {
    for (const method of methods) {
      console[method] = original[method]
    }
  }
}

function withProfile(value, fn) {
  const previous = process.env.ECC_HOOK_PROFILE
  process.env.ECC_HOOK_PROFILE = value
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (previous === undefined) delete process.env.ECC_HOOK_PROFILE
      else process.env.ECC_HOOK_PROFILE = previous
    })
}

/**
 * Minimal fake of the v2 promise plugin context. Hook registrations are
 * captured so tests can invoke them directly; `events` scripts the server
 * event stream consumed by the session-lifecycle subscription.
 */
function createCtx(projectDir, events = []) {
  const captured = {
    toolBefore: [],
    toolAfter: [],
    shell: [],
    permission: [],
    session: {},
    tools: [],
  }
  const noopRegistration = { dispose: async () => {} }
  const ctx = {
    location: {
      directory: projectDir,
      project: { id: "test-project", directory: projectDir },
    },
    options: {},
    session: {
      get: async () => ({ directory: projectDir }),
      hook: async (name, callback) => {
        captured.session[name] = callback
        return noopRegistration
      },
    },
    tool: {
      hook: async (name, callback) => {
        if (name === "execute.before") captured.toolBefore.push(callback)
        else captured.toolAfter.push(callback)
        return noopRegistration
      },
      transform: async (callback) => {
        const added = []
        callback({
          add: (definition) => added.push(definition),
          update: () => {},
          remove: () => {},
          list: () => [],
          get: () => undefined,
          namespace: () => {},
        })
        captured.tools.push(...added)
        return noopRegistration
      },
    },
    shell: {
      hook: async (_name, callback) => {
        captured.shell.push(callback)
        return noopRegistration
      },
    },
    permission: {
      hook: async (_name, callback) => {
        captured.permission.push(callback)
        return noopRegistration
      },
    },
    event: {
      subscribe: () => {
        async function* stream() {
          for (const event of events) {
            yield event
          }
        }
        return stream()
      },
    },
  }
  return { ctx, captured }
}

async function setupPlugin(plugin, projectDir, events = []) {
  const { ctx, captured } = createCtx(projectDir, events)
  let cleanup
  const { out } = await captureConsole(async () => {
    cleanup = await plugin.default.setup(ctx)
    // Let the event-subscription loop drain the scripted events.
    for (let i = 0; i < 10; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setImmediate(resolve))
    }
  })
  return { captured, logs: out, cleanup }
}

function toolBeforeEvent(tool, input) {
  return { tool, input, id: "call-1", sessionID: "session-1" }
}

function toolAfterEvent(tool, input) {
  return { tool, input, id: "call-1", sessionID: "session-1", status: "completed", result: {} }
}

function shellEvent(cwd, env = {}) {
  return { command: "", cwd, timeout: 1000, shell: "sh", env }
}

function permissionEvent(action, resources) {
  return { sessionID: "session-1", action, resources, effect: "ask" }
}

async function withTempProject(files, fn) {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecc-opencode-plugin-"))
  try {
    for (const file of files) {
      const filePath = path.join(projectDir, file)
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      fs.writeFileSync(filePath, "")
    }
    return await fn(projectDir)
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true })
  }
}

async function main() {
  console.log("\n=== Testing OpenCode v2 plugin hooks ===\n")

  const plugin = await loadPlugin()
  const tests = [
    [
      "plugin default-exports a v2 definition with id and setup",
      async () => {
        assert.ok(plugin.default && typeof plugin.default === "object", "Expected an object default export")
        assert.strictEqual(plugin.default.id, "ecc-hooks")
        assert.strictEqual(typeof plugin.default.setup, "function")
      },
    ],
    [
      "plugin initializes and keeps working when plugins/lib is missing",
      async () => withTempProject([], async (projectDir) => {
        const repoRoot = path.join(__dirname, "..")
        const libDir = path.join(repoRoot, ".opencode", "dist", "plugins", "lib")
        const backupDir = path.join(
          repoRoot,
          ".opencode",
          "dist",
          "plugins",
          "lib.missing-store-test-backup"
        )
        fs.renameSync(libDir, backupDir)
        try {
          // Plugin setup must resolve even though changed-files-store.js
          // cannot be found -- it must not throw and crash session startup (#2530).
          const { captured, logs } = await withProfile("standard", () =>
            setupPlugin(plugin, projectDir, [
              { type: "session.deleted", data: {} },
            ])
          )

          const disabledWarnings = logs.filter(
            (entry) =>
              entry.level === "warn" &&
              entry.message.includes("[ECC] changed-files tracking disabled") &&
              entry.message.includes("ecc repair --target opencode")
          )
          assert.strictEqual(
            disabledWarnings.length,
            1,
            "Expected exactly one warning when plugins/lib/changed-files-store.js cannot be loaded"
          )

          // Every store-touching hook must remain callable and must not throw.
          await captured.toolAfter[0](toolAfterEvent("edit", { path: "src/other.ts" }))
          const compaction = { system: [], messages: [], options: {}, tools: {} }
          await captured.session.compaction(compaction)
          assert.ok(compaction.system.length > 0, "Expected compaction to push ECC context")
        } finally {
          fs.renameSync(backupDir, libDir)
        }
      }),
    ],
    [
      "changed-files tracking records and clears through the v2 hooks",
      async () => withTempProject([], async (projectDir) => {
        const { captured, logs } = await withProfile("standard", () =>
          setupPlugin(plugin, projectDir, [])
        )

        assert.ok(
          !logs.some(
            (entry) => entry.level === "warn" && entry.message.includes("changed-files tracking disabled")
          ),
          "Did not expect a disabled warning when plugins/lib is present"
        )

        const storeUrl = pathToFileURL(
          path.join(__dirname, "..", ".opencode", "dist", "plugins", "lib", "changed-files-store.js")
        ).href
        const store = await import(storeUrl)

        await captured.toolAfter[0](toolAfterEvent("edit", { path: "src/other.ts" }))
        assert.ok(
          store
            .getChangedPaths()
            .some((entry) => entry.path === path.normalize("src/other.ts")),
          "Expected execute.after to record a change for the edit tool"
        )

        // v1 file.watcher.updated is now the filesystem.changed server event.
        const { captured: captured2 } = await withProfile("standard", () =>
          setupPlugin(plugin, projectDir, [
            { type: "filesystem.changed", data: { file: "src/example.ts", event: "change" } },
            { type: "session.deleted", data: {} },
          ])
        )
        assert.ok(captured2, "Expected second setup to resolve")
        assert.ok(!store.hasChanges(), "Expected session.deleted to clear tracked changes")
      }),
    ],
    [
      "shell hook detects project markers without shelling out to test -f",
      async () => withTempProject(
        ["pnpm-lock.yaml", "tsconfig.json", "pyproject.toml"],
        async (projectDir) => {
          const { captured } = await withProfile("standard", () =>
            setupPlugin(plugin, projectDir, [])
          )

          assert.strictEqual(captured.shell.length, 1, "Expected one shell hook registration")
          const event = shellEvent(projectDir)
          await captured.shell[0](event)
          const env = event.env

          assert.strictEqual(env.PROJECT_ROOT, projectDir)
          assert.strictEqual(env.PACKAGE_MANAGER, "pnpm")
          assert.strictEqual(env.DETECTED_LANGUAGES, "typescript,python")
          assert.strictEqual(env.PRIMARY_LANGUAGE, "typescript")
          // Verify ECC_VERSION is not hardcoded
          assert.ok(env.ECC_VERSION !== "1.8.0", "ECC_VERSION should not be hardcoded to 1.8.0")
          assert.ok(env.ECC_VERSION.match(/^\d+\.\d+\.\d+$/), "ECC_VERSION should be a valid semver version")
        }
      ),
    ],
    [
      "session.created checks CLAUDE.md through fs instead of shell test",
      async () => withTempProject(["CLAUDE.md"], async (projectDir) => {
        const { logs } = await withProfile("standard", () =>
          setupPlugin(plugin, projectDir, [
            { type: "session.created", data: { directory: projectDir } },
          ])
        )

        assert.ok(
          logs.some((entry) => entry.message === "[ECC] Found CLAUDE.md - loading project context"),
          "Expected CLAUDE.md detection log"
        )
      }),
    ],
    [
      "session.created ignores directories named CLAUDE.md",
      async () => {
        const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecc-opencode-plugin-"))
        try {
          fs.mkdirSync(path.join(projectDir, "CLAUDE.md"))

          const { logs } = await withProfile("standard", () =>
            setupPlugin(plugin, projectDir, [
              { type: "session.created", data: { directory: projectDir } },
            ])
          )

          assert.ok(
            !logs.some((entry) => entry.message === "[ECC] Found CLAUDE.md - loading project context"),
            "Directory named CLAUDE.md should not be treated as project context"
          )
        } finally {
          fs.rmSync(projectDir, { recursive: true, force: true })
        }
      },
    ],
    [
      "shell hook ignores directories named like lockfiles and language markers",
      async () => {
        const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecc-opencode-plugin-"))
        try {
          fs.mkdirSync(path.join(projectDir, "pnpm-lock.yaml"))
          fs.mkdirSync(path.join(projectDir, "tsconfig.json"))

          const { captured } = await withProfile("standard", () =>
            setupPlugin(plugin, projectDir, [])
          )

          const event = shellEvent(projectDir)
          await captured.shell[0](event)

          assert.ok(!("PACKAGE_MANAGER" in event.env), "Lockfile directory should not set PACKAGE_MANAGER")
          assert.ok(!("DETECTED_LANGUAGES" in event.env), "Marker directory should not set DETECTED_LANGUAGES")
          assert.ok(!("PRIMARY_LANGUAGE" in event.env), "Marker directory should not set PRIMARY_LANGUAGE")
        } finally {
          fs.rmSync(projectDir, { recursive: true, force: true })
        }
      },
    ],
    [
      "permission hook handles read-only actions correctly",
      async () => withTempProject(
        [],
        async (projectDir) => {
          const { captured } = await withProfile("standard", () =>
            setupPlugin(plugin, projectDir, [])
          )
          assert.strictEqual(captured.permission.length, 1, "Expected one permission hook registration")

          for (const action of ["read", "glob", "grep"]) {
            const event = permissionEvent(action, [])
            // eslint-disable-next-line no-await-in-loop
            await captured.permission[0](event)
            assert.strictEqual(event.effect, "allow", `Expected allow for ${action}`)
            assert.strictEqual(event.message, "Read-only operation")
          }
        }
      ),
    ],
    [
      "permission hook handles formatters correctly",
      async () => withTempProject(
        [],
        async (projectDir) => {
          const { captured } = await withProfile("standard", () =>
            setupPlugin(plugin, projectDir, [])
          )

          const prettierEvent = permissionEvent("bash", ["npx prettier --write src/index.ts"])
          await captured.permission[0](prettierEvent)
          assert.strictEqual(prettierEvent.effect, "allow")
          assert.strictEqual(prettierEvent.message, "Formatter execution")

          const biomeEvent = permissionEvent("bash", ["npx @biomejs/biome format --write src/index.ts"])
          await captured.permission[0](biomeEvent)
          assert.strictEqual(biomeEvent.effect, "allow")
          assert.strictEqual(biomeEvent.message, "Formatter execution")
        }
      ),
    ],
    [
      "permission hook handles test execution correctly",
      async () => withTempProject(
        [],
        async (projectDir) => {
          const { captured } = await withProfile("standard", () =>
            setupPlugin(plugin, projectDir, [])
          )

          const npmTestEvent = permissionEvent("bash", ["npm test"])
          await captured.permission[0](npmTestEvent)
          assert.strictEqual(npmTestEvent.effect, "allow")
          assert.strictEqual(npmTestEvent.message, "Test execution")

          const vitestEvent = permissionEvent("bash", ["npx vitest run"])
          await captured.permission[0](vitestEvent)
          assert.strictEqual(vitestEvent.effect, "allow")
          assert.strictEqual(vitestEvent.message, "Test execution")
        }
      ),
    ],
    [
      "compaction hook preserves ECC context with version banner",
      async () => withTempProject(
        [],
        async (projectDir) => {
          const { captured } = await withProfile("standard", () =>
            setupPlugin(plugin, projectDir, [])
          )

          const event = { system: [], messages: [], options: {}, tools: {} }
          await captured.session.compaction(event)
          assert.strictEqual(event.system.length, 1, "Expected one system block")
          assert.match(event.system[0].text, /## Active Plugin: ECC v\d+\.\d+\.\d+/)
        }
      ),
    ],
    [
      "tool transform registers the changed-files and dependency-analyzer tools",
      async () => withTempProject(
        [],
        async (projectDir) => {
          const { captured } = await withProfile("standard", () =>
            setupPlugin(plugin, projectDir, [
              { type: "session.deleted", data: {} },
            ])
          )

          const names = captured.tools.map((tool) => tool.name).sort()
          assert.deepStrictEqual(names, ["changed-files", "dependency-analyzer"])

          const changedFiles = captured.tools.find((tool) => tool.name === "changed-files")
          const emptyResult = await changedFiles.execute({})
          assert.ok(
            emptyResult.content.includes('"changed":false'),
            `Expected empty-store payload, got: ${emptyResult.content}`
          )

          const analyzer = captured.tools.find((tool) => tool.name === "dependency-analyzer")
          const analysis = JSON.parse((await analyzer.execute({})).content)
          assert.strictEqual(analysis.success, false, "Temp project has no package.json")
        }
      ),
    ],
  ]

  let passed = 0
  let failed = 0
  for (const [name, fn] of tests) {
    const result = await runTest(name, fn)
    passed += result.passed
    failed += result.failed
  }

  console.log(`\nPassed: ${passed}`)
  console.log(`Failed: ${failed}`)
  process.exit(failed > 0 ? 1 : 0)
}

main()
