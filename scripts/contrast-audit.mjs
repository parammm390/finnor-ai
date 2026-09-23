// CI contrast gate for the active Centropy product and authentication palettes.

import { readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")

function read(path) {
  return readFileSync(join(repoRoot, path), "utf8")
}

function hexToken(source, name, file) {
  const pattern = new RegExp("--" + name + "\\s*:\\s*(#[0-9a-fA-F]{6})\\s*;")
  const match = source.match(pattern)
  if (!match) throw new Error("Missing hex color token --" + name + " in " + file)
  return match[1]
}

function parseColor(input) {
  const clean = input.replace("#", "")
  if (clean.length !== 6) throw new Error("Expected a six-digit hex color: " + input)
  const value = Number.parseInt(clean, 16)
  return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255 }
}

function relativeLuminance({ r, g, b }) {
  const channel = (value) => {
    const srgb = value / 255
    return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

function contrastRatio(foreground, background) {
  const first = relativeLuminance(parseColor(foreground))
  const second = relativeLuminance(parseColor(background))
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05)
}

const checks = []
function check(label, foreground, background) {
  const ratio = contrastRatio(foreground, background)
  checks.push({ label, ratio: Math.round(ratio * 100) / 100, minimum: 4.5, pass: ratio >= 4.5 })
}

const workstationPath = "src/components/centropy/product/workstation.css"
const workstation = read(workstationPath)
const surfaces = ["pw-bg", "pw-panel", "pw-panel-2", "pw-panel-3"]
const textColors = ["pw-text", "pw-muted", "pw-faint", "pw-cyan", "pw-green", "pw-amber", "pw-red"]
const workstationColors = Object.fromEntries(
  [...surfaces, ...textColors].map((name) => [name, hexToken(workstation, name, workstationPath)]),
)
for (const text of textColors) {
  for (const surface of surfaces) {
    check("--" + text + " on --" + surface, workstationColors[text], workstationColors[surface])
  }
}

const themePath = "src/components/centropy/centropy-theme.css"
const theme = read(themePath)
const loginFormPath = "src/components/centropy/lib/LoginForm.tsx"
const resetFormPath = "src/components/centropy/lib/ResetPasswordForm.tsx"
function formBackground(path) {
  const match = read(path).match(/bg-\[#([0-9a-fA-F]{6})\]/)
  if (!match) throw new Error("Could not find the form background color in " + path)
  return "#" + match[1]
}
const authBackground = formBackground(loginFormPath)
if (formBackground(resetFormPath) !== authBackground) {
  throw new Error("Login and reset forms must share the audited background color.")
}
for (const name of ["j-text", "j-text-dim", "j-text-faint", "j-cyan"]) {
  check("--" + name + " on Centropy authentication background", hexToken(theme, name, themePath), authBackground)
}

const failed = checks.filter((result) => !result.pass)
console.log(JSON.stringify({ checks, failedCount: failed.length }, null, 2))
if (failed.length) {
  console.error("contrast-audit: " + failed.length + " text pairing(s) are below WCAG AA 4.5:1.")
  process.exit(1)
}
