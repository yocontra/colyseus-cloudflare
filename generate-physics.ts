/** Reproduce the pinned engine's generated Ammo assets. Run: npm run generate:physics */
import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'

// PlayCanvas v2.23.3, pinned to its exact upstream commit.
const engine =
  'https://raw.githubusercontent.com/playcanvas/engine/b7655d8fccc1284678af8f098b26b0725e20dd3a/examples/assets/wasm/ammo'
async function download(path: string, sha256: string) {
  const response = await fetch(`${engine}/${path}`)
  if (!response.ok) {
    throw new Error(`Physics source download failed: ${path}`)
  }
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (createHash('sha256').update(bytes).digest('hex') !== sha256) {
    throw new Error(`Physics source integrity check failed: ${path}`)
  }
  return bytes
}
const [factoryBytes, wasm] = await Promise.all([
  download(
    'ammo.wasm.js',
    '8481c5250507d3f2c0cecff7cc55a34727f52f96590a2304556a43ca4cf4e0b3',
  ),
  download(
    'ammo.wasm.wasm',
    'de36b300b25d244a79ae56ef0e7fee5efe2a3281f346a134945eef0b2fbaa5d8',
  ),
])
const upstream = new TextDecoder().decode(factoryBytes)
const nodeEnvironment =
  'fa="object"==typeof process&&"object"==typeof process.versions&&"string"==typeof process.versions.node'
const trampoline = 'new WebAssembly.Module(new Uint8Array(c))'
const footer = "if (typeof exports === 'object' && typeof module === 'object')"
if (
  !(
    upstream.includes(nodeEnvironment) &&
    upstream.includes(trampoline) &&
    upstream.includes(footer)
  )
) {
  throw new Error('Pinned generated Ammo layout changed')
}
const factory = upstream
  .slice(0, upstream.indexOf(footer))
  .replace(nodeEnvironment, 'fa=!1')
  .replace(
    trampoline,
    'b.callbackModule||new WebAssembly.Module(new Uint8Array(c))',
  )
await writeFile(
  new URL('./src/vendor/ammo-factory.ts', import.meta.url),
  `// @ts-nocheck
// Generated from PlayCanvas engine v2.23.3; altered source. See README.md and AMMO-LICENSE.txt.
// Changes: web environment, ESM export, optional precompiled callback trampoline.
${factory}\nexport default Ammo\n`,
)
await writeFile(new URL('./src/vendor/ammo.wasm.wasm', import.meta.url), wasm)
// Emscripten addFunction trampoline: import e.f(i32,f32)->void and export it as f.
// Each JS callback gets its own Instance; table slots remain managed by Ammo.addFunction/removeFunction.
await writeFile(
  new URL('./src/vendor/physics-callback.wasm', import.meta.url),
  new Uint8Array([
    0, 97, 115, 109, 1, 0, 0, 0, 1, 6, 1, 96, 2, 127, 125, 0, 2, 7, 1, 1, 101,
    1, 102, 0, 0, 7, 5, 1, 1, 102, 0, 0,
  ]),
)
