// A minimal MCP server over stdio for tests: one tool that returns the value
// of the TEST_CODE_WORD environment variable (so tests can check that keys
// reach the server).
let buffer = ''
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let at
  while ((at = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, at)
    buffer = buffer.slice(at + 1)
    if (!line.trim()) continue
    const message = JSON.parse(line)
    const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\n')
    if (message.method === 'initialize') {
      reply({
        protocolVersion: message.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'echo', version: '1' }
      })
    } else if (message.method === 'tools/list') {
      reply({
        tools: [
          { name: 'reveal_code', description: 'Returns the secret code word.', inputSchema: { type: 'object', properties: {} } }
        ]
      })
    } else if (message.method === 'tools/call') {
      reply({ content: [{ type: 'text', text: 'CODE=' + (process.env.TEST_CODE_WORD || 'MISSING') }] })
    } else if (message.id !== undefined) {
      reply({})
    }
  }
})
