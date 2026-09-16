// Bundles the smoke test through esbuild (already present via Vite) so the
// `@/` aliases and TypeScript syntax resolve, then runs it in this process.
import { build } from 'esbuild'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, resolve } from 'node:path'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const result = await build({
  entryPoints: [resolve(root, 'scripts/smoke.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  write: false,
  alias: { '@': resolve(root, 'src') },
})

const dir = mkdtempSync(resolve(tmpdir(), 'drawi-smoke-'))
const file = resolve(dir, 'smoke.mjs')
writeFileSync(file, result.outputFiles[0].text)
await import(pathToFileURL(file).href)
