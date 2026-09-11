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

// 复审修复轮：Important 修复 2。rc.ignore 是整体替换（`rc.ignore ??
// DEFAULTS.ignoreDirs`），用户按 README 写 `"ignore": ["out"]` 之前会把
// `.texwatch` 从 ignoreDirs 里整体挤掉——而 src/watcher.js 的 classify 把
// 「.texwatch 下的文件恒不触发编译」当成绝不失效的第二道防线，这道防线
// 完全建立在 .texwatch 出现在 ignoreDirs 里这个前提上。前提一旦失效：
// .texwatch/build/main.pdf 这类编译产物会被 classify 判成 'asset'（.pdf
// 在默认 watchExtensions 里），每次编译写出 PDF 就再触发一次编译——无限
// 循环、CPU 跑满。已实测复现过（见任务报告）。
test('自定义 ignore（不含 .texwatch）时，.texwatch 仍无条件被忽略', async () => {
  const dir = await makeProject({
    'paper.tex': MINIMAL,
    '.texwatchrc.json': JSON.stringify({ ignore: ['out'] }),
  })
  const cfg = await resolveConfig({ cwd: dir })

  assert.ok(cfg.ignoreDirs.includes('.texwatch'), 'ignoreDirs 必须无条件包含 .texwatch')
  assert.ok(cfg.ignoreDirs.includes('out'), '用户自定义的 ignore 项也要保留')
})

test('自定义 ignore 场景下，.texwatch 下的编译产物不会被 classify 判成需要触发编译的 asset', async () => {
  const dir = await makeProject({
    'paper.tex': MINIMAL,
    '.texwatchrc.json': JSON.stringify({ ignore: ['out'] }),
  })
  const cfg = await resolveConfig({ cwd: dir })
  const { classify } = await import('../src/watcher.js')

  assert.equal(
    classify(path.join(dir, '.texwatch/build/paper.pdf'), { config: cfg }),
    null,
    '.texwatch/build/ 下的编译产物必须被忽略，否则会形成无限编译循环'
  )
  assert.equal(
    classify(path.join(dir, '.texwatch/last-good.pdf'), { config: cfg }),
    null,
    '.texwatch/last-good.pdf 必须被忽略'
  )
})
