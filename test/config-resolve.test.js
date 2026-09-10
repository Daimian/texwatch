import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { resolveConfig } from '../src/config.js'

async function makeProject(files) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'texwatch-'))
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(dir, name)
    await fs.mkdir(path.dirname(full), { recursive: true })
    await fs.writeFile(full, content)
  }
  return dir
}

const MINIMAL = '\\documentclass{article}\n\\begin{document}\nhi\n\\end{document}\n'

test('单个 tex 时自动选中它', async () => {
  const dir = await makeProject({ 'paper.tex': MINIMAL })
  const cfg = await resolveConfig({ cwd: dir })
  assert.equal(cfg.mainTexRelative, 'paper.tex')
  assert.equal(cfg.preambleEndLine, 2)
  assert.equal(cfg.root, dir)
})

test('多个候选且未指定时抛错，错误里列出候选', async () => {
  const dir = await makeProject({ 'a.tex': MINIMAL, 'b.tex': MINIMAL })
  await assert.rejects(() => resolveConfig({ cwd: dir }), (err) => {
    assert.deepEqual(err.candidates.sort(), ['a.tex', 'b.tex'])
    return true
  })
})

test('rc 文件里的 main 生效', async () => {
  const dir = await makeProject({
    'a.tex': MINIMAL,
    'b.tex': MINIMAL,
    '.texwatchrc.json': JSON.stringify({ main: 'b.tex', port: 4000 }),
  })
  const cfg = await resolveConfig({ cwd: dir })
  assert.equal(cfg.mainTexRelative, 'b.tex')
  assert.equal(cfg.port, 4000)
})

test('CLI 参数覆盖 rc 文件', async () => {
  const dir = await makeProject({
    'a.tex': MINIMAL,
    'b.tex': MINIMAL,
    '.texwatchrc.json': JSON.stringify({ main: 'b.tex', port: 4000 }),
  })
  const cfg = await resolveConfig({ cwd: dir, cliArg: 'a.tex', cliPort: 5000 })
  assert.equal(cfg.mainTexRelative, 'a.tex')
  assert.equal(cfg.port, 5000)
})

test('默认值：端口 3577、非 draft、忽略 .texwatch', async () => {
  const dir = await makeProject({ 'paper.tex': MINIMAL })
  const cfg = await resolveConfig({ cwd: dir })
  assert.equal(cfg.port, 3577)
  assert.equal(cfg.draft, false)
  assert.ok(cfg.ignoreDirs.includes('.texwatch'))
  assert.ok(cfg.watchExtensions.includes('.tex'))
  assert.ok(cfg.watchExtensions.includes('.sty'))
  assert.equal(path.basename(cfg.outDir), 'build')
})

test('draft 模式换用独立的输出目录和 last-good 文件', async () => {
  const dir = await makeProject({ 'paper.tex': MINIMAL })
  const cfg = await resolveConfig({ cwd: dir, cliDraft: true })
  assert.equal(path.basename(cfg.outDir), 'build-draft')
  assert.equal(path.basename(cfg.lastGoodPdf), 'last-good-draft.pdf')
})

test('扫描时跳过 .texwatch 目录里的 tex', async () => {
  const dir = await makeProject({
    'paper.tex': MINIMAL,
    '.texwatch/build/junk.tex': MINIMAL,
  })
  const cfg = await resolveConfig({ cwd: dir })
  assert.equal(cfg.mainTexRelative, 'paper.tex')
})
