import { readFileSync } from 'fs'
import { resolve } from 'path'
import { buildSync } from 'esbuild'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

// The memory server runs as a separate process, loaded by path from inside
// app.asar. ES-module package resolution from inside the archive breaks when
// the install path contains a space (e.g. "C:\Program Files"), so bundle its
// dependencies into one CJS file that needs no package lookups at runtime.
function bundleMemoryServerPlugin() {
  return {
    name: 'bundle-memory-server',
    closeBundle() {
      // Remote access: the browser's stand-in for the preload (window.vibe over a WebSocket),
      // the helper added to relayed preview pages, and VibeApp's MCP server for Claude Code.
      buildSync({
        entryPoints: [resolve('src/remote-bridge/bridge.ts')],
        outfile: resolve('out/main/remote/bridge.js'),
        bundle: true,
        platform: 'browser',
        format: 'iife',
        target: 'es2020',
        alias: { '@shared': resolve('shared') },
        logLevel: 'warning'
      })
      buildSync({
        entryPoints: [resolve('src/remote-bridge/preview-helper.js')],
        outfile: resolve('out/main/remote/preview-helper.js'),
        bundle: false,
        logLevel: 'warning'
      })
      buildSync({
        entryPoints: [resolve('src/main/remote/vibeappMcp.mjs')],
        outfile: resolve('out/main/remote/vibeapp-mcp.cjs'),
        bundle: true,
        platform: 'node',
        format: 'cjs',
        logLevel: 'warning'
      })
      // Cline's safety hook: Cline runs it with its own Node for every tool call.
      buildSync({
        entryPoints: [resolve('src/main/cline/hookMain.ts')],
        outfile: resolve('out/main/cline/clineHook.cjs'),
        bundle: true,
        platform: 'node',
        format: 'cjs',
        target: 'node18',
        alias: { '@shared': resolve('shared') },
        logLevel: 'warning'
      })
      buildSync({
        entryPoints: [resolve('src/main/memory/memoryServer.mjs')],
        outfile: resolve('out/main/memory/memoryServer.cjs'),
        bundle: true,
        platform: 'node',
        format: 'cjs',
        // The memory store uses shared types and Node's built-in SQLite.
        alias: { '@shared': resolve('shared') },
        logLevel: 'warning'
      })
    }
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin(), bundleMemoryServerPlugin()],
    resolve: {
      alias: {
        '@shared': resolve('shared')
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve('shared')
      }
    }
  },
  renderer: {
    define: {
      __APP_VERSION__: JSON.stringify(JSON.parse(readFileSync(resolve('package.json'), 'utf8')).version)
    },
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@shared': resolve('shared')
      }
    },
    plugins: [react()]
  }
})
