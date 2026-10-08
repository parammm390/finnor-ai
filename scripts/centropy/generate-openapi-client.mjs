import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import openapiTS, { astToString } from "openapi-typescript"

const input = new URL("../../finnor-os/openapi.json", import.meta.url)
const outputs = [
  new URL("../../src/lib/centropy/openapi-types.ts", import.meta.url),
  new URL("../../src/lib/jarvis/openapi-types.ts", import.meta.url),
]
const source = readFileSync(input, "utf8")
const digest = createHash("sha256").update(source).digest("hex")
const document = `// Generated from finnor-os/openapi.json, SHA-256 ${digest}.\n` +
  astToString(await openapiTS(JSON.parse(source)))
for (const output of outputs) {
  if (process.argv.includes("--check")) {
    if (readFileSync(output, "utf8") !== document) throw new Error(`OpenAPI client ${output.pathname} is stale; run npm run centropy:client`)
  } else {
    mkdirSync(dirname(output.pathname), { recursive: true })
    writeFileSync(output, document)
  }
}
console.log(`CENTROPY OpenAPI client: ${digest}`)
