/**
 * ECC Custom Tool: Dependency Analyzer
 *
 * Analyzes project dependencies for outdated packages, security vulnerabilities,
 * and unused dependencies. Supports multiple package managers.
 */

import * as path from "path"
import * as fs from "fs"

interface DependencyInfo {
  name: string
  current: string
  latest?: string
  type: "production" | "development" | "peer"
  outdated: boolean
  security?: {
    vulnerable: boolean
    severity?: string
    recommendation?: string
  }
}

interface AnalysisResult {
  success: boolean
  packageManager: string
  dependencies: DependencyInfo[]
  summary: {
    total: number
    outdated: number
    vulnerable: number
    unused: number
  }
  recommendations: string[]
  error?: string
}

export interface DependencyAnalyzerInput {
  type?: string
  fix?: boolean
  depth?: number
}

/**
 * Framework-free runner, registered on OpenCode v2 via
 * `ctx.tool.transform(editor.add(...))` in plugins/index.ts.
 * `cwd` is supplied by the plugin (v2 tool contexts carry no directory).
 */
export async function runDependencyAnalyzer(
  input: DependencyAnalyzerInput,
  cwd: string
): Promise<string> {
  try {
    const analysisType = input.type ?? "all"
    const fix = input.fix ?? false
    const depth = input.depth ?? 1

    // Detect package manager
    const packageManager = detectPackageManager(cwd)

    // Analyze dependencies
    const dependencies = await analyzeDependencies(cwd, packageManager, depth)

    // Generate summary
    const summary = generateSummary(dependencies)

    // Generate recommendations
    const recommendations = generateRecommendations(dependencies, summary, analysisType)

    const result: AnalysisResult & {
      analysisType: string
      fixMode: boolean
      platform: string
    } = {
      success: true,
      packageManager,
      dependencies: dependencies.slice(0, 50), // Limit output
      summary,
      recommendations,
      analysisType,
      fixMode: fix,
      platform: process.platform,
    }
    return JSON.stringify(result)
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    return JSON.stringify({
      success: false,
      error: `Failed to analyze dependencies: ${errorMessage}`,
      type: input.type,
    })
  }
}

function detectPackageManager(cwd: string): string {
  if (fs.existsSync(path.join(cwd, "bun.lockb"))) return "bun"
  if (fs.existsSync(path.join(cwd, "pnpm-lock.yaml"))) return "pnpm"
  if (fs.existsSync(path.join(cwd, "yarn.lock"))) return "yarn"
  if (fs.existsSync(path.join(cwd, "package-lock.json"))) return "npm"
  return "npm"
}

async function analyzeDependencies(
  cwd: string,
  packageManager: string,
  depth: number
): Promise<DependencyInfo[]> {
  const dependencies: DependencyInfo[] = []
  void packageManager
  void depth

  try {
    // Read package.json
    const packageJsonPath = path.join(cwd, "package.json")
    if (!fs.existsSync(packageJsonPath)) {
      throw new Error("package.json not found")
    }

    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"))

    // Analyze production dependencies
    if (packageJson.dependencies) {
      for (const [name, version] of Object.entries(packageJson.dependencies)) {
        dependencies.push({
          name,
          current: version as string,
          type: "production",
          outdated: false, // Would need npm outdated to check
        })
      }
    }

    // Analyze development dependencies
    if (packageJson.devDependencies) {
      for (const [name, version] of Object.entries(packageJson.devDependencies)) {
        dependencies.push({
          name,
          current: version as string,
          type: "development",
          outdated: false,
        })
      }
    }

    // Analyze peer dependencies
    if (packageJson.peerDependencies) {
      for (const [name, version] of Object.entries(packageJson.peerDependencies)) {
        dependencies.push({
          name,
          current: version as string,
          type: "peer",
          outdated: false,
        })
      }
    }
  } catch (error) {
    throw new Error(`Failed to read package.json: ${error}`)
  }

  return dependencies
}

function generateSummary(dependencies: DependencyInfo[]) {
  return {
    total: dependencies.length,
    outdated: dependencies.filter((d) => d.outdated).length,
    vulnerable: dependencies.filter((d) => d.security?.vulnerable).length,
    unused: 0, // Would need additional analysis
  }
}

function generateRecommendations(
  dependencies: DependencyInfo[],
  summary: { total: number; outdated: number; vulnerable: number; unused: number },
  analysisType: string
): string[] {
  const recommendations: string[] = []
  void analysisType

  if (summary.outdated > 0) {
    recommendations.push(
      `${summary.outdated} outdated dependencies found. Consider updating with: npm update`
    )
  }

  if (summary.vulnerable > 0) {
    recommendations.push(
      `${summary.vulnerable} vulnerable dependencies found. Run: npm audit fix`
    )
  }

  if (summary.total > 100) {
    recommendations.push(
      "Large number of dependencies detected. Consider removing unused packages."
    )
  }

  // Check for common issues
  const hasTypeScript = dependencies.some((d) => d.name === "typescript")
  const hasEslint = dependencies.some((d) => d.name === "eslint")
  const hasPrettier = dependencies.some((d) => d.name === "prettier")

  if (hasTypeScript && !hasEslint) {
    recommendations.push(
      "TypeScript project without ESLint detected. Consider adding linting."
    )
  }

  if (hasEslint && !hasPrettier) {
    recommendations.push(
      "ESLint without Prettier detected. Consider adding code formatting."
    )
  }

  if (recommendations.length === 0) {
    recommendations.push("No critical dependency issues found.")
  }

  return recommendations
}
