// Checks what `npm run package` put into the app before anyone installs it:
//   node scripts/check-package.mjs
// Only the built app may be inside (never the project folder's source, tests, logs or
// settings: a packaging rule in the wrong place once swept all of those in), and the parts
// Windows must load from a real folder have to be there. Run by `npm run package` and again
// by `npm run release`.
import { existsSync, readdirSync } from 'fs'
import { createRequire } from 'module'
import { join } from 'path'

const root = join(import.meta.dirname, '..')
const resources = join(root, 'release', 'win-unpacked', 'resources')
const asarFile = join(resources, 'app.asar')
if (!existsSync(asarFile)) throw new Error(`Missing ${asarFile}. Run npm run package first.`)

const asar = createRequire(import.meta.url)('@electron/asar')
const { header } = asar.getRawHeader(asarFile)
const problems = []

const ALLOWED = ['out', 'package.json', 'node_modules']
const extra = Object.keys(header.files).filter((name) => !ALLOWED.includes(name))
if (extra.length) problems.push(`the app contains project files that must not ship: ${extra.join(', ')}`)

const unpacked = join(resources, 'app.asar.unpacked', 'node_modules')
const runtime = join(unpacked, 'onnxruntime-node', 'bin', 'napi-v6')
const needed = [
  join(resources, 'models', 'gte-small', 'onnx', 'model_quantized.onnx'),
  join(resources, 'models', 'gte-small', 'tokenizer.json'),
  join(resources, 'models', 'gte-small', 'NOTICE.txt'),
  join(runtime, 'win32', 'x64', 'onnxruntime.dll'),
  join(runtime, 'win32', 'x64', 'onnxruntime_binding.node'),
  join(unpacked, 'sqlite-vec-windows-x64', 'vec0.dll')
]
for (const file of needed) if (!existsSync(file)) problems.push(`missing: ${file.slice(resources.length + 1)}`)

// Other systems' copies of the runtime (260 MB) and the graphics-card files stay out.
if (existsSync(runtime)) {
  const systems = readdirSync(runtime)
  if (systems.join() !== 'win32') problems.push(`the ONNX runtime for other systems is included: ${systems.join(', ')}`)
  const here = join(runtime, 'win32')
  const builds = existsSync(here) ? readdirSync(here) : []
  if (builds.join() !== 'x64') problems.push(`the ONNX runtime for other processors is included: ${builds.join(', ')}`)
  const files = existsSync(join(here, 'x64')) ? readdirSync(join(here, 'x64')) : []
  const unwanted = files.filter((f) => /^(DirectML|dxcompiler|dxil)\.dll$/i.test(f))
  if (unwanted.length) problems.push(`graphics-card files are included: ${unwanted.join(', ')}`)
}

if (problems.length) {
  console.error(`The packaged app is not right:\n- ${problems.join('\n- ')}`)
  process.exit(1)
}
console.log('The packaged app holds only the built app, the memory search model and its runtime.')
