import { cpSync, mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync, realpathSync, statSync, linkSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, relative, resolve, dirname } from "node:path"

// The API's remote root is relative to finnor-os, but source custody and Next's
// tracing root include the repository root. Give the real builder that complete
// root rather than flattening it or duplicating finnor-os in traced paths.
export function apiBuildContext(repoRoot) {
  const directory = mkdtempSync(join(tmpdir(), "finnor-api-build-"))
  const backend = join(repoRoot, "finnor-os")
  cpSync(backend, join(directory, "finnor-os"), {
    recursive: true,
    filter: source => !relative(backend, source).split(/[\\/]/).some(part =>
      ["node_modules", ".next", ".vercel", ".git", "evidence"].includes(part) || /^\.env(?:\.|$)/.test(part)),
  })
  for (const path of ["package.json", "package-lock.json", "infra/deployment/production.contract.json"]) {
    cpSync(join(repoRoot, path), join(directory, path), { recursive: true })
  }
  return { directory, cleanup: () => rmSync(directory, { recursive: true, force: true }) }
}

export function normalizeApiProjectRoot(component, project, contract) {
  if (component !== "api") return project
  const original = project.settings?.rootDirectory
  const expected = "apps/api"
  if (original !== expected) throw new Error("API project build root differs from the canonical observed settings")
  return { ...project, settings: { ...project.settings, rootDirectory: join(contract.topology.api.releaseWorkingDirectory, expected).replaceAll("\\", "/") } }
}

export function vercelBuildConfiguration(component, configuration) {
  // Vercel runs npm ci from the app workspace. Its native handlers also use the
  // locked backend root runtime dependencies, which npm otherwise omits there.
  // Scope this option to installation. Leaving it in npm's environment also
  // runs the subsequent build script at the workspace root, which has no build.
  return component === "api" ? { ...configuration, installCommand: "npm ci --include-workspace-root" } : configuration
}

// The local Next builder writes references to the build context instead of
// copying traced files. Freeze those files before discarding the installation.
export function materializeApiFunctions(context) {
  const root = realpathSync(context)
  const output = join(root, ".vercel/output/functions")
  const inside = (base, path) => path.startsWith(`${base}/`)
  // Preserved TS producers use Node imports, not webpack's bundled copies.
  // Retain their locked production dependency closure, including nested versions.
  const packages = JSON.parse(readFileSync(join(root, "finnor-os/package-lock.json"), "utf8")).packages
  const seen = new Set(), dependencies = [], workspaces = []
  function dependency(path) {
    if (seen.has(path) || !packages[path]) return
    seen.add(path)
    const entry = packages[path]
    if (entry.link) { workspaces.push([path, entry.resolved]); dependency(entry.resolved); return }
    if (path.startsWith("node_modules/")) dependencies.push(path)
    for (const name of Object.keys({ ...entry.dependencies, ...entry.optionalDependencies })) {
      let base = path, candidate
      for (;;) {
        candidate = `${base ? `${base}/` : ""}node_modules/${name}`
        if (packages[candidate] || !base) break
        base = dirname(base) === "." ? "" : dirname(base)
      }
      dependency(candidate)
    }
  }
  dependency("packages/private-equity")
  dependency("packages/source-custody")
  function retain(source, target) {
    if (source.endsWith(".map")) return // Debug maps are not executable producer inputs.
    if (!inside(root, realpathSync(source))) throw new Error("Native dependency escapes its build context")
    if (statSync(source).isDirectory()) {
      mkdirSync(target, { recursive: true })
      for (const entry of readdirSync(source)) retain(join(source, entry), join(target, entry))
    } else if (statSync(source).isFile() && !existsSync(target)) {
      mkdirSync(dirname(target), { recursive: true })
      linkSync(source, target)
      files++
    }
  }
  let files = 0
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const path = join(directory, entry.name)
      if (!entry.name.endsWith(".func")) { visit(path); continue }
      const configPath = join(path, ".vc-config.json")
      const config = JSON.parse(readFileSync(configPath, "utf8"))
      for (const [destination, original] of Object.entries(config.filePathMap || {})) {
        if (destination.endsWith(".map") && destination.includes("/node_modules/")) continue
        const target = resolve(path, destination)
        const input = resolve(root, original)
        if (!inside(path, target) || !inside(root, input)) throw new Error("API file map escapes its function/build context")
        if (existsSync(target)) continue // Generated launcher is already emitted.
        const source = realpathSync(input)
        if (!inside(root, source)) throw new Error("API file map source escapes its build context")
        mkdirSync(dirname(target), { recursive: true })
        if (statSync(source).isFile()) linkSync(source, target)
        else if (statSync(source).isDirectory()) cpSync(source, target, { recursive: true, dereference: true })
        else throw new Error("API file map source is not a regular file/directory")
        files++
      }
      if (existsSync(join(path, "finnor-os/packages/source-custody/index.cjs"))) {
        for (const [alias, workspace] of workspaces) {
          const destination = join(path, "finnor-os", workspace)
          retain(join(root, "finnor-os", workspace), destination)
          const target = join(path, "finnor-os", alias)
          if (!existsSync(target)) {
            mkdirSync(dirname(target), { recursive: true })
            symlinkSync(relative(dirname(target), destination), target)
          }
        }
        for (const dependency of dependencies) {
          const source = join(root, "finnor-os", dependency)
          if (existsSync(source)) retain(source, join(path, "finnor-os", dependency))
        }
      }
      delete config.filePathMap
      writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`)
    }
  }
  visit(output)
  return files
}
