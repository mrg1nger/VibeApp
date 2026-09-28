import { resolve } from 'path'
import { existsSync, mkdirSync, copyFileSync } from 'fs'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

function copyMemoryServerPlugin() {
  return {
    name: 'copy-memory-server',
    closeBundle() {
      const destDir = resolve('out/main/memory')
      if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true })
      copyFileSync(
        resolve('src/main/memory/memoryServer.mjs'),
        resolve(destDir, 'memoryServer.mjs')
      )
    }
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin(), copyMemoryServerPlugin()],
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
