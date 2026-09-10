import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createWatcher } from '../src/watcher.js'

const tick = (ms) => new Promise((r) => setTimeout(r, ms))

async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'texwatch-w-'))
  await fs.writeFile(path.join(root, 'main.tex'), '\\documentclass{article}\n\\begin{document}\nx\n\\end{document}\n')
  await fs.writeFile(path.join(root, 'main.bib'), '@article{a,title={t}}\n')
  await fs.mkdir(path.join(root, '.texwatch/build'), { recursive: true })
  const config = {
    root,
    mainTex: path.join(root, 'main.tex'),
    preambleEndLine: 2,
    watchExtensions: ['.tex', '.bib', '.png'],
    ignoreDirs: ['.texwatch', '.git'],
  }
  return { root, config }
}

test('改 .tex 触发一次 change', async () => {
  const { root, config } = await setup()
  const seen = []
  const w = createWatcher({ config, debounceMs: 50 })
  w.on('change', (kind) => seen.push(kind))
  await tick(300) // 等 chokidar ready

  await fs.writeFile(path.join(root, 'main.tex'), '\\documentclass{article}\n\\begin{document}\nchanged\n\\end{document}\n')
  await tick(400)

  assert.equal(seen.length, 1, `应该只触发一次，实际 ${JSON.stringify(seen)}`)
  await w.close()
})

test('防抖窗口内的多次保存合并成一次', async () => {
  const { root, config } = await setup()
  const seen = []
  const w = createWatcher({ config, debounceMs: 100 })
  w.on('change', (kind) => seen.push(kind))
  await tick(300)

  const f = path.join(root, 'main.tex')
  await fs.writeFile(f, 'a')
  await tick(20)
  await fs.writeFile(f, 'b')
  await tick(20)
  await fs.writeFile(f, 'c')
  await tick(400)

  assert.equal(seen.length, 1)
  await w.close()
})

test('同一窗口内改 tex 和 bib，kind 合并成 bib', async () => {
  const { root, config } = await setup()
  const seen = []
  const w = createWatcher({ config, debounceMs: 100 })
  w.on('change', (kind) => seen.push(kind))
  await tick(300)

  await fs.writeFile(path.join(root, 'SI.tex'), 'x')
  await fs.writeFile(path.join(root, 'main.bib'), '@article{b,title={u}}\n')
  await tick(400)

  assert.equal(seen.length, 1)
  assert.equal(seen[0], 'bib', 'bib 权重高于 tex')
  await w.close()
})

test('.texwatch 里的产物不触发 change', async () => {
  const { root, config } = await setup()
  const seen = []
  const w = createWatcher({ config, debounceMs: 50 })
  w.on('change', (kind) => seen.push(kind))
  await tick(300)

  await fs.writeFile(path.join(root, '.texwatch/build/main.pdf'), 'fake pdf')
  await tick(300)

  assert.equal(seen.length, 0, '编译产物绝不能触发新的编译，否则会死循环')
  await w.close()
})
