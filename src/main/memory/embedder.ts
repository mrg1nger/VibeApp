import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { Tokenizer } from '@huggingface/tokenizers'

// Turns a text into a vector that stands for what it means, so "how do I put it
// online" lands next to a fact about deploying. A small language model (gte-small,
// 34 MB, fetched by scripts/fetch-model.mjs) does it on this computer through the
// ONNX runtime: nothing is sent anywhere. No Electron imports, so the tests use it as is.

/** Saved with every vector. Another model or revision gets another name, and every vector is made again. */
export const EMBEDDING_MODEL = 'gte-small-q8@5927d17'

export interface Embedder {
  /** Names what makes the vectors (EMBEDDING_MODEL for the real one). */
  model: string
  /** The text's vector, of length 1. */
  embed(text: string): Promise<Float32Array>
}

/** The model reads this many word pieces at most (about 2,000 letters); the rest of a long text is left out. */
const MAX_TOKENS = 512
const MAX_CHARS = 6000

export async function loadEmbedder(folder: string): Promise<Embedder> {
  const modelFile = join(folder, 'onnx', 'model_quantized.onnx')
  if (!existsSync(modelFile)) throw new Error(`the search model is not in ${folder}`)
  const json = (name: string): object => JSON.parse(readFileSync(join(folder, name), 'utf8')) as object
  const tokenizer = new Tokenizer(json('tokenizer.json'), json('tokenizer_config.json'))
  // Loaded here and not at the top of the file: on a computer the runtime can't run on,
  // only search by meaning is lost.
  const loaded = await import('onnxruntime-node')
  const ort = ((loaded as { default?: unknown }).default ?? loaded) as typeof import('onnxruntime-node')
  // Two threads: making vectors in the background must not slow the rest of the computer.
  const session = await ort.InferenceSession.create(readFileSync(modelFile), { intraOpNumThreads: 2, interOpNumThreads: 1 })
  const int64 = (values: number[]): InstanceType<typeof ort.Tensor> =>
    new ort.Tensor('int64', BigInt64Array.from(values.map(BigInt)), [1, values.length])

  async function one(text: string): Promise<Float32Array> {
    let ids = tokenizer.encode(text.slice(0, MAX_CHARS)).ids
    // Too long: keep the start, and the closing mark the model expects.
    if (ids.length > MAX_TOKENS) ids = [...ids.slice(0, MAX_TOKENS - 1), ids[ids.length - 1]]
    const feeds: Record<string, InstanceType<typeof ort.Tensor>> = { input_ids: int64(ids), attention_mask: int64(ids.map(() => 1)) }
    if (session.inputNames.includes('token_type_ids')) feeds.token_type_ids = int64(ids.map(() => 0))
    const out = (await session.run(feeds))[session.outputNames[0]]
    const [, tokens, width] = out.dims
    const data = out.data as Float32Array
    // The text's vector is the average of its word pieces' vectors, scaled to length 1.
    const v = new Float32Array(width)
    for (let t = 0; t < tokens; t++) for (let i = 0; i < width; i++) v[i] += data[t * width + i] / tokens
    let length = 0
    for (const x of v) length += x * x
    length = Math.sqrt(length) || 1
    return v.map((x) => x / length)
  }

  // One text at a time, in the order asked.
  let last: Promise<unknown> = Promise.resolve()
  return {
    model: EMBEDDING_MODEL,
    embed(text) {
      const next = last.then(() => one(text))
      last = next.catch(() => undefined)
      return next
    }
  }
}
