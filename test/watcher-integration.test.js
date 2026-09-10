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
  // 把 .pdf/.log/.aux 显式加进 watchExtensions：如果不这样做，光靠
  // watchExtensions 不包含 .pdf 就能挡住产物，这条测试就测不出目录级的
  // ignored 防线本身是否真的生效——必须让扩展名过滤失效，才能验证到它。
  config.watchExtensions = [...config.watchExtensions, '.pdf', '.log', '.aux']
  const seen = []
  const w = createWatcher({ config, debounceMs: 50 })
  w.on('change', (kind) => seen.push(kind))
  await tick(300)

  await fs.writeFile(path.join(root, '.texwatch/build/main.pdf'), 'fake pdf')
  await tick(300)

  assert.equal(seen.length, 0, '编译产物绝不能触发新的编译，否则会死循环')
  await w.close()
})

test('启动期编辑窗口：createWatcher 后立刻编辑不能被吞（大项目场景）', async () => {
  // 复现的是一个真实竞态：mtime 基线扫描（或 chokidar 自身的初始扫描）是
  // 异步的，项目文件越多，扫描耗时越长，"监听已经能感知这个文件" 和
  // "我们已经确认过它没有被漏掉" 之间就有一个越来越宽的窗口。如果一次真实
  // 保存恰好落在这个窗口里，错误的实现会把它误判成启动前的幽灵事件而悄悄
  // 丢弃——用户保存了文件，但什么都没发生。这是本工具最坏的失效形态，所以
  // 这条测试不等 chokidar ready、createWatcher() 一返回就立刻编辑，且用
  // 一个体量足够大的项目把这个窗口拉长到测试能稳定复现的程度。
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'texwatch-w-big-'))
  await fs.writeFile(path.join(root, 'main.tex'), '\\documentclass{article}\n\\begin{document}\nx\n\\end{document}\n')
  await fs.mkdir(path.join(root, '.texwatch/build'), { recursive: true })
  for (let i = 0; i < 300; i++) {
    await fs.writeFile(path.join(root, `asset${i}.png`), `fake-image-content-${i}`)
  }
  const config = {
    root,
    mainTex: path.join(root, 'main.tex'),
    preambleEndLine: 2,
    watchExtensions: ['.tex', '.bib', '.png'],
    ignoreDirs: ['.texwatch', '.git'],
  }

  const seen = []
  const w = createWatcher({ config, debounceMs: 50 })
  w.on('change', (kind) => seen.push(kind))

  try {
    // 关键：不 tick 等待，createWatcher() 返回后立刻编辑，模拟用户在
    // texwatch 刚启动、首次全量编译还没跑完时顺手改了主文件。
    await fs.writeFile(path.join(root, 'main.tex'), '\\documentclass{article}\n\\begin{document}\nchanged\n\\end{document}\n')
    await tick(800)

    assert.ok(seen.length >= 1, `启动期的真实编辑必须被感知到，绝不能被当成幽灵事件丢弃，实际 seen=${JSON.stringify(seen)}`)
  } finally {
    // 300 个文件的 watcher 持有真实的 fsevents 原生句柄：断言一旦失败就
    // 直接 throw，如果不用 try/finally 兜底关闭，进程会因为这个残留的
    // 原生句柄一直不退出——之前用旧实现故意让这条测试失败时就踩到过。
    await w.close()
  }
})
