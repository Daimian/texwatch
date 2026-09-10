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
  try {
    await tick(300) // 等 chokidar ready

    await fs.writeFile(path.join(root, 'main.tex'), '\\documentclass{article}\n\\begin{document}\nchanged\n\\end{document}\n')
    await tick(400)

    assert.equal(seen.length, 1, `应该只触发一次，实际 ${JSON.stringify(seen)}`)
  } finally {
    // 断言失败会直接 throw，跳过后面的 w.close()；不兜底的话，watcher 持有
    // 的 chokidar/fsevents 原生句柄不会被释放，进程会挂起而不是报错退出。
    await w.close()
  }
})

test('防抖窗口内的多次保存合并成一次', async () => {
  const { root, config } = await setup()
  const seen = []
  const w = createWatcher({ config, debounceMs: 100 })
  w.on('change', (kind) => seen.push(kind))
  try {
    await tick(300)

    const f = path.join(root, 'main.tex')
    await fs.writeFile(f, 'a')
    await tick(20)
    await fs.writeFile(f, 'b')
    await tick(20)
    await fs.writeFile(f, 'c')
    await tick(400)

    assert.equal(seen.length, 1)
  } finally {
    await w.close()
  }
})

test('同一窗口内改 tex 和 bib，kind 合并成 bib', async () => {
  const { root, config } = await setup()
  const seen = []
  const w = createWatcher({ config, debounceMs: 100 })
  w.on('change', (kind) => seen.push(kind))
  try {
    await tick(300)

    await fs.writeFile(path.join(root, 'SI.tex'), 'x')
    await fs.writeFile(path.join(root, 'main.bib'), '@article{b,title={u}}\n')
    await tick(400)

    assert.equal(seen.length, 1)
    assert.equal(seen[0], 'bib', 'bib 权重高于 tex')
  } finally {
    await w.close()
  }
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
  try {
    await tick(300)

    await fs.writeFile(path.join(root, '.texwatch/build/main.pdf'), 'fake pdf')
    await tick(300)

    assert.equal(seen.length, 0, '编译产物绝不能触发新的编译，否则会死循环')
  } finally {
    await w.close()
  }
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

test('close() 之后不再发出 change，即使启动期补扫还在进行中', async () => {
  // 复审读代码发现的问题：旧的 close() 只做了 clearTimeout(timer) +
  // watcher.close()，完全没有理会「启动期补扫」（watcher.on('ready', ...)
  // 里那个一次性扫描）。如果 close() 恰好在补扫还没跑完时被调用，补扫结束
  // 后仍会调用 scheduleEmit，而 scheduleEmit 内部会重新设置一个新的
  // setTimeout——于是关闭之后仍可能对外发出一次 change。更麻烦的是，这个
  // close 之后残留的 setTimeout 会让事件循环排不空，`node --test` 得等
  // 事件循环排空才退出，测试进程会因此永久挂起而不是正常结束。
  //
  // 这条测试直接把这个窗口拉到最大：createWatcher() 一返回，不等 ready、
  // 不等任何 tick，立刻 close()——这时候补扫大概率还没开始，至少没跑完。
  const { config } = await setup()
  const seen = []
  const w = createWatcher({ config, debounceMs: 50 })
  w.on('change', (kind) => seen.push(kind))
  try {
    await w.close()
    await tick(1000)

    assert.equal(seen.length, 0, `close() 之后不应该再收到任何 change，实际 ${JSON.stringify(seen)}`)
  } finally {
    // close() 是幂等的（内部只是把 closed 置位、清 timer、调用一次
    // chokidar 的 close），这里再调一次纯粹是防御性收尾，跟其它测试的
    // try/finally 保持同一个模式。
    await w.close()
  }
})

// 下面两条测试覆盖跨路径重复 emit 的竞态：实时路径（chokidar 的
// add/change/unlink 事件）和启动期补扫（'ready' 之后的 scanForLateEdits）
// 是两条独立路径，都可能观察到同一次编辑。曾经以为"顶多在同一个 debounce
// 窗口内合并"，但补扫的延迟实测过从几 ms 到 370ms+ 都有、没有稳定上界，
// 只要补扫比实时路径的 debounce flush 晚到超过 debounceMs，两者就会各自
// 独立 emit 一次——同一次保存触发两次编译。
//
// 这个时序没法靠 tick() 掐时间可靠复现（补扫到底晚多久是不确定的），所以
// 用 createWatcher 上仅供测试使用的 testOnlyLateScanDelayMs /
// testOnlyLiveEventDelayMs 参数人为拖慢其中一条路径，确定性地构造出两种
// 先后顺序，分别验证跨路径去重在两个方向上都生效。

test('跨路径去重（实时先到、补扫后到）：同一次编辑只 emit 一次', async () => {
  const { root, config } = await setup()
  const seen = []
  // debounceMs 很小，testOnlyLateScanDelayMs 远大于它：让实时路径的
  // debounce 早早 flush 完，补扫晚很久才跑到，制造"补扫比实时路径的
  // debounce flush 晚到超过 debounceMs"这个此前会导致重复 emit 的时序。
  const w = createWatcher({ config, debounceMs: 50, testOnlyLateScanDelayMs: 500 })
  w.on('change', (kind) => seen.push(kind))
  try {
    await tick(100) // 让真实的 chokidar ready 先发生（补扫本身仍会因为注入的延迟晚 500ms 才跑）

    await fs.writeFile(path.join(root, 'main.tex'), '\\documentclass{article}\n\\begin{document}\nchanged\n\\end{document}\n')
    await tick(200) // 实时路径的 debounce（50ms）早就 flush 完了

    assert.equal(seen.length, 1, `实时路径 flush 后，补扫不应该再重复 emit，此时 seen=${JSON.stringify(seen)}`)

    await tick(500) // 等被人为拖慢的补扫也跑完

    assert.equal(seen.length, 1, `补扫迟到也不应该让同一次编辑触发第二次 emit，实际 seen=${JSON.stringify(seen)}`)
  } finally {
    await w.close()
  }
})

test('跨路径去重（补扫先到、实时后到）：同一次编辑只 emit 一次', async () => {
  const { root, config } = await setup()
  const seen = []
  // testOnlyLiveEventDelayMs 远大于 debounceMs：让补扫（不加延迟，'ready'
  // 一到就跑）先处理完并 flush，实时路径的处理被人为拖慢到远晚于那次
  // flush，制造相反方向的时序。
  const w = createWatcher({ config, debounceMs: 50, testOnlyLiveEventDelayMs: 500 })
  w.on('change', (kind) => seen.push(kind))
  try {
    // 关键：不等待，createWatcher() 一返回就立刻编辑——这时 chokidar 还没
    // ready，真实的 mtime 已经 >= startedAt，补扫会在 'ready' 后把它当成
    // 一次真实变更处理；实时事件即使原生层面确实派发了，处理也会被人为
    // 拖慢 500ms。
    await fs.writeFile(path.join(root, 'main.tex'), '\\documentclass{article}\n\\begin{document}\nchanged\n\\end{document}\n')
    await tick(300) // 补扫应该早就跑完、flush 过一次了

    assert.equal(seen.length, 1, `补扫 flush 后，被拖慢的实时事件不应该再重复 emit，此时 seen=${JSON.stringify(seen)}`)

    await tick(500) // 等被人为拖慢的实时事件处理完

    assert.equal(seen.length, 1, `实时事件迟到也不应该让同一次编辑触发第二次 emit，实际 seen=${JSON.stringify(seen)}`)
  } finally {
    await w.close()
  }
})
