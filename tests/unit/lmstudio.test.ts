import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { chatModelsFrom, forgetLmStudioStatus, lmStudioBase, lmStudioReady, lmStudioStatus, pickModel, runLmStudio } from '../../src/main/cli/lmStudio'
import { helpersAllowed, onLmStudio, runHelperJob } from '../../src/main/helpers/helperJob'
import { updateSettings } from '../../src/main/settings/store'
import { memoryDb } from '../../src/main/memory/paths'
import { usageSummary } from '../../src/main/memory/store'
import { buildReport } from '../../src/main/usage/report'

// A stand-in for LM Studio's local server: the two model lists and chat completions.
type Reply = (body: Record<string, unknown>) => { status?: number; json: unknown }
let reply: Reply = () => ({ json: { choices: [{ message: { content: 'READY' } }] } })
const received: Record<string, unknown>[] = []
let v0Works = true

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  let raw = ''
  req.on('data', (d) => (raw += d))
  req.on('end', () => {
    const send = (status: number, json: unknown): void => {
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(json))
    }
    if (req.url === '/api/v0/models') {
      if (!v0Works) return send(404, { error: 'Unexpected endpoint' })
      return send(200, {
        data: [
          { id: 'text-embedding-nomic', type: 'embeddings', state: 'not-loaded' },
          { id: 'zeta-7b', type: 'llm', state: 'not-loaded', max_context_length: 32768 },
          { id: 'qwen-test', type: 'llm', state: 'loaded', loaded_context_length: 32000 }
        ]
      })
    }
    if (req.url === '/v1/models') return send(200, { data: [{ id: 'text-embedding-nomic' }, { id: 'plain-model' }] })
    if (req.url === '/v1/chat/completions') {
      const body = JSON.parse(raw) as Record<string, unknown>
      received.push(body)
      const r = reply(body)
      return send(r.status ?? 200, r.json)
    }
    send(404, { error: 'Unexpected endpoint' })
  })
})
let url = ''
before(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
after(() => server.close())

const use = (patch: Parameters<typeof updateSettings>[0] = {}): void => {
  // Cline off so a failed job can't wander onto it; tests that fall back check the error instead.
  updateSettings({ lmStudioHelpers: true, lmStudioUrl: url, lmStudioModel: null, clineHelpers: false, ...patch })
  forgetLmStudioStatus()
  received.length = 0
}

test('the server address is tidied (a pasted /v1, no scheme, a trailing slash)', () => {
  assert.equal(lmStudioBase('http://localhost:1234/v1'), 'http://localhost:1234')
  assert.equal(lmStudioBase('localhost:1234/'), 'http://localhost:1234')
  assert.equal(lmStudioBase('http://192.168.1.5:1234/api/v0'), 'http://192.168.1.5:1234')
  assert.equal(lmStudioBase(''), 'http://localhost:1234')
  assert.equal(lmStudioBase(null), 'http://localhost:1234')
})

test('the model list leaves out embedding models and puts the loaded one first', () => {
  const models = chatModelsFrom(
    [
      { id: 'b-model', type: 'llm', state: 'not-loaded' },
      { id: 'embed', type: 'embeddings', state: 'loaded' },
      { id: 'a-model', type: 'vlm', state: 'loaded', loaded_context_length: 8000 }
    ],
    undefined
  )
  assert.deepEqual(models.map((m) => m.id), ['a-model', 'b-model'])
  assert.equal(models[0].contextLength, 8000)
  // Only the OpenAI-style list: guess embeddings from the name.
  assert.deepEqual(chatModelsFrom(undefined, [{ id: 'nomic-embed-text' }, { id: 'llama' }]).map((m) => m.id), ['llama'])
  assert.equal(pickModel(models, null), 'a-model', 'the loaded one')
  assert.equal(pickModel(models, 'b-model'), 'b-model', 'the chosen one')
  assert.equal(pickModel([{ id: 'x', loaded: false }], null), 'x', 'the first, which LM Studio loads on demand')
  assert.equal(pickModel([], null), undefined)
})

test('status reads the running server, falling back to the OpenAI-style list', async () => {
  const status = await lmStudioStatus(url)
  assert.equal(status.running, true)
  assert.deepEqual(status.models.map((m) => m.id), ['qwen-test', 'zeta-7b'])
  v0Works = false
  try {
    assert.deepEqual((await lmStudioStatus(url)).models.map((m) => m.id), ['plain-model'])
  } finally {
    v0Works = true
  }
  const down = await lmStudioStatus('http://127.0.0.1:1')
  assert.equal(down.running, false)
  assert.match(down.error ?? '', /isn't answering at http:\/\/127\.0\.0\.1:1/)
})

test('LM Studio is ready only when turned on and the server answers', async () => {
  use({ lmStudioHelpers: false })
  assert.equal(await lmStudioReady(), false, 'off in Settings')
  use({ lmStudioUrl: 'http://127.0.0.1:1' })
  assert.equal(await lmStudioReady(), false, 'nothing at the address')
  use()
  assert.equal(await lmStudioReady(), true)
  assert.equal(await helpersAllowed(), true, 'background jobs can run with Claude out')
})

test('a background job runs on LM Studio: schema enforced, thinking off, usage logged as LM Studio', async () => {
  use()
  reply = () => ({
    json: {
      model: 'qwen-test',
      choices: [{ message: { content: '{"add":[{"text":"The game runs with npm run dev.","category":"setup"}]}' } }],
      usage: { prompt_tokens: 120, completion_tokens: 30 }
    }
  })
  const pid = `lmstudio-${Date.now()}`
  const since = new Date(Date.now() - 1000).toISOString()
  const schema = {
    type: 'object',
    properties: { add: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' }, category: { type: 'string' } }, required: ['text', 'category'] } } },
    required: ['add']
  }
  const answer = await runHelperJob({ kind: 'scribe', projectId: pid, prompt: 'USER: The game runs with npm run dev.', schema })
  assert.equal(answer.by, 'lmstudio')
  assert.equal((answer.structured as { add: { text: string }[] }).add[0].text, 'The game runs with npm run dev.')
  const sent = received[0]
  assert.equal(sent.model, 'qwen-test', 'the loaded model')
  assert.equal(sent.reasoning_effort, 'none', 'thinking off')
  assert.deepEqual((sent.response_format as { json_schema: { schema: unknown } }).json_schema.schema, schema)
  const logged = usageSummary(memoryDb(), since, pid)
  assert.deepEqual(logged.map((r) => [r.kind, r.fresh, r.output]), [['scribe (lmstudio)', 120, 30]])
})

test('the tidy-up lets the model think, and a chosen model is used', async () => {
  use({ lmStudioModel: 'zeta-7b' })
  reply = () => ({ json: { choices: [{ message: { content: 'All tidy.' } }] } })
  const answer = await runHelperJob({ kind: 'tidy', prompt: 'Tidy these facts.', thinking: true })
  assert.equal(answer.text, 'All tidy.')
  assert.equal(received[0].model, 'zeta-7b')
  assert.equal('reasoning_effort' in received[0], false)
})

test('a server that doesn\'t know reasoning_effort gets the request again without it', async () => {
  use()
  reply = (body) =>
    'reasoning_effort' in body
      ? { status: 400, json: { error: { message: "Unrecognized key 'reasoning_effort'" } } }
      : { json: { choices: [{ message: { content: 'READY' } }] } }
  const result = await runLmStudio({ system: 's', prompt: 'p' })
  assert.equal(result.text, 'READY')
  assert.equal(received.length, 2)
})

test('failures say why (refused, ran out of room, wrong format)', async () => {
  use()
  reply = () => ({ status: 400, json: { error: 'Model unloaded.' } })
  await assert.rejects(runLmStudio({ system: 's', prompt: 'p' }), /LM Studio refused the job: Model unloaded/)
  reply = () => ({ json: { choices: [{ message: { content: '' }, finish_reason: 'length' }] } })
  await assert.rejects(runLmStudio({ system: 's', prompt: 'p' }), /ran out of room/)
  // An answer that doesn't fit the format is a failure (so runHelperJob moves on to Cline or Haiku).
  reply = () => ({ json: { choices: [{ message: { content: '{"wrong":true}' } }] } })
  await assert.rejects(
    onLmStudio({ kind: 'summary', prompt: 'p', schema: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] } }),
    /didn't follow the format \(answer\.summary is missing\)/
  )
})

test('the usage report has an LM Studio section', () => {
  const report = buildReport({
    days: 7,
    usage: [{ projectId: '', kind: 'scribe', agent: 'lmstudio', model: null, runs: 12, fresh: 9000, cached: 0, output: 1500 }],
    requests: [],
    projectNames: new Map()
  } as unknown as Parameters<typeof buildReport>[0])
  assert.match(report, /## LM Studio, by kind of work \(12 runs on this computer, free/)
  assert.match(report, /- scribe: 12 runs \(11k tokens\)/)
})
