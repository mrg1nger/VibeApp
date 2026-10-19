import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'path'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import {
  addTodo,
  clearDoneTodos,
  deleteTodo,
  eraseProjectFromMemory,
  getNotes,
  listTodos,
  openMemory,
  reorderTodos,
  setNotes,
  todosSignature,
  updateTodo
} from '../../src/main/memory/store'

const db = openMemory(join(mkdtempSync(join(tmpdir(), 'vibeapp-unit-')), 'memory.db'))

test('to-dos keep their order, and the same open item is not added twice', () => {
  const p = 'todo-order'
  addTodo(db, p, 'Add a shop screen', 'user')
  addTodo(db, p, 'Fix   the\njump sound', 'user')
  const urgent = addTodo(db, p, 'Back up the save files', 'user', { top: true })
  assert.deepEqual(
    listTodos(db, p).map((t) => t.text),
    ['Back up the save files', 'Add a shop screen', 'Fix the jump sound'],
    'top goes first; text is one tidy line'
  )
  const again = addTodo(db, p, 'add a shop screen', 'claude')
  assert.equal(again.duplicate, true)
  assert.equal(listTodos(db, p).length, 3)
  assert.throws(() => addTodo(db, p, '   ', 'user'))
  assert.equal(urgent.todo.source, 'user')
  assert.equal(addTodo(db, p, 'Add sound settings', 'codex').todo.source, 'codex')
})

test('ticking off moves an item to the done list; un-ticking puts it back at the end', () => {
  const p = 'todo-done'
  const a = addTodo(db, p, 'First', 'user').todo
  addTodo(db, p, 'Second', 'user')
  const done = updateTodo(db, p, a.id, { done: true })
  assert.equal(done?.done, true)
  assert.ok(done?.doneAt)
  assert.deepEqual(listTodos(db, p).map((t) => `${t.text}${t.done ? ' ✓' : ''}`), ['Second', 'First ✓'])
  updateTodo(db, p, a.id, { done: false })
  assert.deepEqual(listTodos(db, p).map((t) => t.text), ['Second', 'First'])
  assert.equal(updateTodo(db, 'another-project', a.id, { done: true }), null, "can't change another project's items")
  updateTodo(db, p, a.id, { done: true })
  assert.equal(clearDoneTodos(db, p), 1)
  assert.deepEqual(listTodos(db, p).map((t) => t.text), ['Second'])
})

test('reordering and deleting', () => {
  const p = 'todo-reorder'
  const ids = ['one', 'two', 'three'].map((t) => addTodo(db, p, t, 'user').todo.id)
  reorderTodos(db, p, [ids[2], ids[0]])
  assert.deepEqual(listTodos(db, p).map((t) => t.text), ['three', 'one', 'two'], 'unlisted items keep their place after')
  assert.equal(deleteTodo(db, p, ids[1]), true)
  assert.equal(deleteTodo(db, p, ids[1]), false)
  updateTodo(db, p, ids[2], { text: '  the third  ' })
  assert.equal(listTodos(db, p)[0].text, 'the third')
})

test('notes are saved per project, and the change signal notices to-do changes', () => {
  assert.deepEqual(getNotes(db, 'notes-a'), { text: '', updatedAt: null })
  setNotes(db, 'notes-a', '# Server\nhttp://localhost:3000')
  setNotes(db, 'notes-b', 'other')
  assert.equal(getNotes(db, 'notes-a').text, '# Server\nhttp://localhost:3000')
  const before = todosSignature(db).get('sig')
  addTodo(db, 'sig', 'Something', 'codex')
  assert.notEqual(todosSignature(db).get('sig'), before)
})

test('erasing a project removes its to-dos and notes', () => {
  addTodo(db, 'erase-me', 'Gone soon', 'user')
  setNotes(db, 'erase-me', 'also gone')
  eraseProjectFromMemory(db, 'erase-me')
  assert.equal(listTodos(db, 'erase-me').length, 0)
  assert.equal(getNotes(db, 'erase-me').text, '')
})
