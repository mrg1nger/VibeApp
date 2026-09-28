import { existsSync, writeFileSync } from 'fs'
import { join } from 'path'
import { simpleGit } from 'simple-git'

const DEFAULT_GITIGNORE = `node_modules
dist
out
build
.env
.env.*
*.log
`

export async function ensureRepo(projectPath: string): Promise<void> {
  const gitDir = join(projectPath, '.git')
  if (existsSync(gitDir)) return

  const git = simpleGit(projectPath)
  await git.init()

  const gitignorePath = join(projectPath, '.gitignore')
  if (!existsSync(gitignorePath)) {
    writeFileSync(gitignorePath, DEFAULT_GITIGNORE, 'utf-8')
  }

  await git.add('.gitignore')
  const status = await git.status()
  if (status.staged.length > 0) {
    await git.commit('Initial checkpoint')
  }
}
