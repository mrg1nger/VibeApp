// Fetches the small language model the memory search runs on this computer
// (gte-small, 34 MB) into resources/models/. It is too big for the repository,
// so it is downloaded once, from a fixed revision, and checked against known
// checksums: the files can never silently become something else.
//
//   node scripts/fetch-model.mjs              fails if the model can't be fetched (packaging)
//   node scripts/fetch-model.mjs --optional   only warns (npm install: the app falls back to keyword search)

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const optional = process.argv.includes('--optional')

// Xenova/gte-small: the ONNX conversion of thenlper/gte-small. The original's model card gives
// its licence as MIT; the conversion's page names the original and states no licence of its own.
const REPO = 'Xenova/gte-small'
const REVISION = '5927d1727bb12db490052a1b33265ad78058de08'
const FOLDER = join(root, 'resources', 'models', 'gte-small')
const FILES = [
  { path: 'onnx/model_quantized.onnx', bytes: 34014426, sha256: '18dec105109b6004369799ca4761fb8fb413c64172c02147bcfac186b5c5f6cb' },
  { path: 'tokenizer.json', bytes: 711661, sha256: 'da0e79933b9ed51798a3ae27893d3c5fa4a201126cef75586296df9b4d2c62a0' },
  { path: 'tokenizer_config.json', bytes: 557, sha256: '73687f47b47aedc8bfa8712f7e6616450058f1f1bb3d5e5861f8a92964d6467a' }
]

/** Goes into the installer next to the model: where it came from and under what licence. */
const NOTICE = `gte-small (General Text Embeddings, small)

The files in this folder are the 8-bit ONNX conversion published at
https://huggingface.co/${REPO} (revision ${REVISION})
of the model https://huggingface.co/thenlper/gte-small, trained by Alibaba DAMO Academy.
The original's model card gives its licence as MIT (https://opensource.org/license/mit).
VibeApp runs the model on this computer to search memory by meaning. Nothing is sent anywhere.
`

const sha256 = (data) => createHash('sha256').update(data).digest('hex')

async function fetchFile(file) {
  const target = join(FOLDER, file.path)
  if (existsSync(target) && sha256(readFileSync(target)) === file.sha256) return false
  const url = `https://huggingface.co/${REPO}/resolve/${REVISION}/${file.path}`
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${url} answered ${response.status}`)
  const data = Buffer.from(await response.arrayBuffer())
  if (data.length !== file.bytes || sha256(data) !== file.sha256) {
    throw new Error(`${file.path} is not the expected file (${data.length} bytes, sha256 ${sha256(data)})`)
  }
  mkdirSync(dirname(target), { recursive: true })
  // Written under another name first, so a download cut short never leaves a broken model behind.
  const partial = `${target}.partial`
  writeFileSync(partial, data)
  rmSync(target, { force: true })
  renameSync(partial, target)
  return true
}

try {
  let fetched = 0
  for (const file of FILES) if (await fetchFile(file)) fetched++
  writeFileSync(join(FOLDER, 'NOTICE.txt'), NOTICE)
  if (fetched) console.log(`Fetched the memory search model (${fetched} file${fetched === 1 ? '' : 's'}) into resources/models/gte-small.`)
} catch (err) {
  const message = `The memory search model could not be fetched: ${err.message}`
  if (!optional) {
    console.error(message)
    process.exit(1)
  }
  console.warn(`${message}\nThe app will search memory by keyword until "node scripts/fetch-model.mjs" succeeds.`)
}
