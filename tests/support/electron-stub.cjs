// Stands in for Electron when tests run under plain Node: the app's data
// folder is a temp dir (set by scripts/test.mjs), and "encryption" is a
// pass-through, which is fine for test data.
const { mkdirSync, mkdtempSync } = require('fs')
const { tmpdir } = require('os')
const { join } = require('path')

const dataDir = process.env.VIBEAPP_TEST_DATA || mkdtempSync(join(tmpdir(), 'vibeapp-test-data-'))
mkdirSync(dataDir, { recursive: true })

module.exports = {
  app: {
    getPath: () => dataDir,
    getVersion: () => '0.0.0-test',
    isPackaged: false
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (text) => Buffer.from(text, 'utf-8'),
    decryptString: (buffer) => Buffer.from(buffer).toString('utf-8')
  }
}
