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
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@shared': resolve('shared')
      }
    },
    plugins: [react()]
  }
})
