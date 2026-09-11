// 回归测试：编译进行中收到 setDraft 的竞态（Task 17 修复轮 1）。
//
// bin/texwatch.js 的 watch 分支里，`current`（当前生效的 ProjectConfig）
// 是可变的：浏览器切换 draft 会原地把它换成另一份 config（不同的
// outDir / lastGoodPdf）。修复前，一次编译任务的 ensureFormat / runCompile /
// publishPdf 各自在不同时刻分别读一次 `current`，如果编译进行中收到
// setDraft，就会出现「用配置 A 编译，结果却发布到配置 B 的路径」的竞态——
// 复审用真实进程复现过：本该发布到 last-good.pdf 的完整非 draft 结果被
// 写进了 last-good-draft.pdf，原来的正确内容被覆盖、永久丢失。
//
// 这里不起真实 latexmk/真实计时来复现这个时序（本项目没有其它测试这样做，
// 且真实编译耗时几秒、时序也不受我们控制，没法确定性复现"编译进行中"这个
// 窗口）。改用完全可控的假 ensureFormat / runCompile / publishPdf——
// runCompile 返回一个我们手动 resolve 的 deferred promise，在"编译尚未
// 完成"的窗口里手动切换 getCurrent() 的返回值并 push 第二个任务（模拟
// setDraft handler 的真实写法：先换 current，再 queue.push），断言第一个
// 任务全程（ensureFormat 收到的 config、runCompile 收到的 config、
// publishPdf 发布的目标）都还是它开始执行那一刻的快照，不受期间的切换影响；
// 随后第二个（被合并进 pending 的）任务才应该用切换后的新配置。
//
// 用真实的 SingleSlotQueue（未改动，见 src/queue.js）而不是自己模拟合并
// 逻辑，是为了让这个测试真正覆盖 createCompileRunner/createResultHandler
// 和 SingleSlotQueue 之间的真实交互，而不是一个脱离真实调度时序的假设。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SingleSlotQueue } from '../src/queue.js'
import { createCompileRunner, createResultHandler } from '../bin/texwatch.js'

// 只用微任务推进（不引入任何真实计时器/sleep）：反复 await 一个已解决的
// promise，直到条件满足或者达到迭代上限。Promise 的 resolve 回调、
// EventEmitter.emit 里同步调用的监听器、async 函数体里没有遇到真实计时器
// 的那部分代码，全部只经过微任务队列，不经过宏任务/定时器阶段，所以这个
// 推进方式足以让整条 "deferred.resolve() -> runner 继续 -> emit('result')
// -> resultHandler 同步前缀 -> 假 publishPdf 记录调用" 的链路走完，且是
// 完全确定性的——不依赖真实时间流逝，不会因为系统繁忙而偶发失败。
async function flushUntil(cond, { maxTicks = 1000 } = {}) {
  for (let i = 0; i < maxTicks; i++) {
    if (cond()) return true
    await Promise.resolve()
  }
  throw new Error(`flushUntil：${maxTicks} 个微任务节拍内条件仍未满足`)
}

function fakeConfig(label) {
  return {
    label, // 仅测试用，用来在断言里认出是哪份 config
    draft: label === 'draft',
    outDir: `/fake/${label}/build`,
    lastGoodPdf: `/fake/${label}/last-good.pdf`,
  }
}

function makeHarness() {
  const ensureFormatCalls = []
  const compileCalls = [] // { config, kind, fmtName, resolve }
  const published = [] // { config, pdfPath }
  const srvStates = []

  async function fakeEnsureFormat(config) {
    ensureFormatCalls.push(config)
    // fmtName 本身也带上 config 的标签，方便断言 runCompile 收到的
    // fmtName 和它收到的 config 是不是同一次 ensureFormat 算出来的——
    // 如果两次读到了不同的 config，这里就会对不上。
    return `fmt-for-${config.label}`
  }

  function fakeRunCompile({ config, kind, fmtName }) {
    return new Promise((resolve) => {
      compileCalls.push({ config, kind, fmtName, resolve })
    })
  }

  async function fakePublishPdf(config, pdfPath) {
    published.push({ config, pdfPath })
  }

  const fakeSrv = {
    setState: (partial) => srvStates.push(partial),
  }

  return { ensureFormatCalls, compileCalls, published, srvStates, fakeEnsureFormat, fakeRunCompile, fakePublishPdf, fakeSrv }
}

test('编译进行中收到 setDraft：在途编译的产物发布到它自己那份配置的路径，不是切换后的新路径', async () => {
  const configNonDraft = fakeConfig('nondraft')
  const configDraft = fakeConfig('draft')

  let current = configNonDraft
  const getCurrent = () => current

  const { compileCalls, published, srvStates, fakeEnsureFormat, fakeRunCompile, fakePublishPdf, fakeSrv } = makeHarness()

  const runner = createCompileRunner({ getCurrent, ensureFormat: fakeEnsureFormat, runCompile: fakeRunCompile })
  const queue = new SingleSlotQueue(runner)
  queue.on('error', (err) => { throw err })
  queue.on('result', createResultHandler({ srv: fakeSrv, publishPdf: fakePublishPdf, onLog: () => {} }))

  // 起始编译：此时 current 还是非 draft 的配置。
  queue.push('full')
  await flushUntil(() => compileCalls.length === 1)
  assert.equal(compileCalls[0].config, configNonDraft, 'runCompile 一开始应该拿到非 draft 的配置')
  assert.equal(compileCalls[0].fmtName, 'fmt-for-nondraft', 'fmtName 应该来自同一份配置算出来的 ensureFormat 结果')

  // --- 编译"进行中"：这时模拟浏览器发来 setDraft，处理器的真实写法是
  // 先换 current、再 queue.push（见 bin/texwatch.js 的 onClientMessage）。
  current = configDraft
  queue.push('full') // 队列忙，这次 push 只会合并进 pending，不会立刻执行

  // 此时第一个任务仍未完成（deferred 没 resolve），只有 1 次 runCompile 调用。
  assert.equal(compileCalls.length, 1, 'setDraft 期间不应该打断/重新触发正在进行的第一次编译')

  // 让第一个任务"编译完成"：产出一份非 draft 的完整 PDF。
  compileCalls[0].resolve({
    ok: true,
    pdfPath: '/fake/nondraft/build/main.pdf',
    durationMs: 3200,
    diagnostics: [],
  })

  // 断言：第一次编译的结果必须发布到它自己（非 draft）的路径，
  // 不能因为 current 已经变成 draft 配置就把它发到 draft 的 lastGoodPdf。
  await flushUntil(() => published.length === 1)
  assert.equal(published[0].config, configNonDraft, '第一次编译的产物必须发布到非 draft 的配置（自己的快照），不是切换后的 current')
  assert.equal(published[0].config.lastGoodPdf, '/fake/nondraft/last-good.pdf')
  assert.equal(published[0].pdfPath, '/fake/nondraft/build/main.pdf')

  // 顺带确认：setState 广播的也是这次任务自己的结果（ok/durationMs），
  // 不受同一时刻 current 已经翻转影响。
  const firstResultState = srvStates.find((s) => 'durationMs' in s)
  assert.equal(firstResultState.state, 'ok')
  assert.equal(firstResultState.durationMs, 3200)

  // --- 第一次编译完成后，被合并进 pending 的第二个任务（源自 setDraft
  // 触发的 queue.push）应该自动开始执行，这时它读到的 current 已经是
  // draft 配置——这是"切换生效"应有的正常行为，和上面的竞态修复不矛盾：
  // 只是每次任务各自的快照要固定在"它开始执行那一刻"。
  await flushUntil(() => compileCalls.length === 2)
  assert.equal(compileCalls[1].config, configDraft, '合并进 pending 的第二次编译应该用切换后的 draft 配置')
  assert.equal(compileCalls[1].fmtName, 'fmt-for-draft')

  compileCalls[1].resolve({
    ok: true,
    pdfPath: '/fake/draft/build/main.pdf',
    durationMs: 500,
    diagnostics: [],
  })

  await flushUntil(() => published.length === 2)
  assert.equal(published[1].config, configDraft, '第二次编译的产物必须发布到 draft 配置自己的路径')
  assert.equal(published[1].config.lastGoodPdf, '/fake/draft/last-good.pdf')
})

test('没有发生 setDraft 时（current 全程不变）：正常发布到同一份配置', async () => {
  const config = fakeConfig('nondraft')
  const getCurrent = () => config

  const { compileCalls, published, fakeEnsureFormat, fakeRunCompile, fakePublishPdf, fakeSrv } = makeHarness()

  const runner = createCompileRunner({ getCurrent, ensureFormat: fakeEnsureFormat, runCompile: fakeRunCompile })
  const queue = new SingleSlotQueue(runner)
  queue.on('error', (err) => { throw err })
  queue.on('result', createResultHandler({ srv: fakeSrv, publishPdf: fakePublishPdf, onLog: () => {} }))

  queue.push('tex')
  await flushUntil(() => compileCalls.length === 1)
  compileCalls[0].resolve({ ok: true, pdfPath: '/fake/nondraft/build/main.pdf', durationMs: 100, diagnostics: [] })

  await flushUntil(() => published.length === 1)
  assert.equal(published[0].config, config)
})
