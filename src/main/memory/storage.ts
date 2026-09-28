import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import type { MemoryFact } from '@shared/types'

interface MemoryFile {
  facts: MemoryFact[]
}

function readMemoryFile(path: string): MemoryFile {
  if (!existsSync(path)) return { facts: [] }
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as MemoryFile
  } catch {
    return { facts: [] }
  }
}

function writeMemoryFile(path: string, data: MemoryFile): void {
  const dir = dirname(path)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(path, JSON.stringify(data, null, 2), 'utf-8')
}

export function addFact(path: string, text: string, source: MemoryFact['source']): MemoryFact {
  const data = readMemoryFile(path)
  const fact: MemoryFact = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    text,
    createdAt: new Date().toISOString(),
    source
  }
  data.facts.push(fact)
  writeMemoryFile(path, data)
  return fact
}

export function listFacts(path: string): MemoryFact[] {
  return readMemoryFile(path).facts
}

export function deleteFact(path: string, id: string): boolean {
  const data = readMemoryFile(path)
  const before = data.facts.length
  data.facts = data.facts.filter((f) => f.id !== id)
  if (data.facts.length === before) return false
  writeMemoryFile(path, data)
  return true
}

export function updateFact(path: string, id: string, text: string): boolean {
  const data = readMemoryFile(path)
  const fact = data.facts.find((f) => f.id === id)
  if (!fact) return false
  fact.text = text
  writeMemoryFile(path, data)
  return true
}
