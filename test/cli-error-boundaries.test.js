// 复审修复轮：Critical 修复 1 的回归测试。
//
// bin/texwatch.js 里有两个 async handler 没有错误边界：
//   1. createResultHandler —— 挂在 queue.on('result', handler) 上，
//      src/queue.js 用同步 EventEmitter.emit 触发，不会等待/接住它返回的
//      promise。已实测复现：编译成功但 publishPdf 在源 PDF 消失后 reject
//      （另一个终端跑 texwatch --clean / latexmk -C 就会撞上），未捕获的
//      rejection 会把整个常驻进程杀掉。
//   2. srv.onClientMessage 里的 setDraft handler —— 挂在
//      src/server.js 的 `for (const h of clientHandlers) h(parsed)` 上，
//      同样是同步 for 循环即发即弃。已实测复现：主文件编辑到「暂时没有
//      \begin{document}」的中间状态时点一下预览页 draft 勾选框，
//      resolveConfig 抛出，进程直接崩溃退出。
//
// 第 1 点可以直接单元测试（createResultHandler 是导出的纯工厂函数）。
// 第 2 点的 setDraft handler 是内联在未导出的 main() 里的，只能像
// test/server-ws.test.js 对 wss 级 error 的复现那样起真实子进程隔离验证
// （否则一崩就把 npm test 自己带崩）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'
import { createResultHandler } from '../bin/texwatch.js'
import { hasTexToolchain } from '../src/compiler.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const BIN = path.join(__dirname, '..', 'bin', 'texwatch.js')

test('createResultHandler：publishPdf reject 时不抛出/不 reject，且不静默吞掉（有 console.error 报出来）', async () => {
  const fakeSrv = { setState: () => {} }
  const logs = []
  const originalError = console.error
  console.error = (...args) => logs.push(args.join(' '))

  try {
    const fakePublishPdf = async () => {
      throw new Error('ENOENT: 模拟源 PDF 已被删除')
    }
    const handler = createResultHandler({ srv: fakeSrv, publishPdf: fakePublishPdf, onLog: () => {} })

    // 模拟 src/queue.js `this.emit('result', ...)` 的即发即弃调用方式：
    // handler 本身是 async 函数，这里直接 await 它返回的 promise 来断言
    // 「它自己不会 reject」——如果 handler 没有 try/catch，这一行会抛出，
    // 测试会失败；但更重要的是在真实运行环境里，queue.js 根本不会 await
    // 这个返回值，所以关键断言是「promise 不 reject」。
    await assert.doesNotReject(() =>
      handler({
        result: {
          ok: true,
          pdfPath: '/fake/does-not-exist.pdf',
          jobConfig: { lastGoodPdf: '/fake/last-good.pdf' },
          durationMs: 100,
          diagnostics: [],
        },
      })
    )

    assert.ok(
      logs.some((l) => l.includes('模拟源 PDF 已被删除')),
      '出错必须用 console.error 报出来，不能静默吞掉'
    )
  } finally {
    console.error = originalError
  }
})

test('createResultHandler：publishPdf 正常时行为不变（setState 与 onLog 照常调用）', async () => {
  const states = []
  const fakeSrv = { setState: (s) => states.push(s) }
  const published = []
  const fakePublishPdf = async (config, pdfPath) => {
    published.push({ config, pdfPath })
  }
  let logged = null
  const handler = createResultHandler({
    srv: fakeSrv,
    publishPdf: fakePublishPdf,
    onLog: (r) => (logged = r),
  })

  await handler({
    result: {
      ok: true,
      pdfPath: '/fake/main.pdf',
      jobConfig: { lastGoodPdf: '/fake/last-good.pdf' },
      durationMs: 250,
      diagnostics: [],
    },
  })

  assert.equal(published.length, 1)
  assert.equal(published[0].pdfPath, '/fake/main.pdf')
  assert.equal(states[0].state, 'ok')
  assert.equal(states[0].durationMs, 250)
  assert.equal(logged.durationMs, 250)
})

const MINIMAL = `\\documentclass{article}
\\begin{document}
hi
\\end{document}
`
// main.tex 编辑到一半、暂时没有 \begin{document} 的中间状态——这正是
// Critical 修复 1 实测复现用的触发条件。
const MID_EDIT = `\\documentclass{article}
hi, no begin document yet
\\end{document}
`

async function waitForLine(readable, pattern, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let buf = ''
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`等待 ${pattern} 超时，已收到输出：\n${buf}`))
    }, timeoutMs)
    function onData(d) {
      buf += d.toString()
      const m = buf.match(pattern)
      if (m) {
        cleanup()
        resolve(m)
      }
    }
    function cleanup() {
      clearTimeout(timer)
      readable.off('data', onData)
    }
    readable.on('data', onData)
  })
}

const toolchainAvailable = await hasTexToolchain()

test(
  'setDraft handler：主文件缺 \\begin{document} 的中间状态下切 draft，进程不崩溃、报错被打印',
  { skip: toolchainAvailable ? false : '未检测到 TeX 环境' },
  async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'texwatch-errbound-'))
    await fs.writeFile(path.join(dir, 'main.tex'), MINIMAL)

    const child = spawn(process.execPath, [BIN, '--no-open'], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    let stdout = ''
    child.stderr.on('data', (d) => (stderr += d.toString()))
    child.stdout.on('data', (d) => (stdout += d.toString()))

    try {
      const m = await waitForLine(child.stdout, /预览地址：(http:\/\/127\.0\.0\.1:\d+)/)
      const url = m[1]

      // 等第一次全量编译跑完，避免和下面的编辑撞在一起造成不确定的诊断输出
      // （不影响本测试要验证的东西，只是让时序更干净）。
      await waitForLine(child.stdout, /成功|失败/)

      // 把主文件改到「暂时没有 \begin{document}」的中间编辑状态。
      await fs.writeFile(path.join(dir, 'main.tex'), MID_EDIT)
      // 给 watcher 的防抖 + 一次编译一点时间，不强依赖具体输出，只是让文件系统
      // 事件先落地；就算这次编译还没跑完，下面直接发 setDraft 一样能触发
      // resolveConfig 重新读盘、重新解析主文件、抛出同样的错误。
      await new Promise((r) => setTimeout(r, 1200))

      const ws = new WebSocket(`${url.replace('http', 'ws')}/ws`)
      await new Promise((resolve, reject) => {
        ws.once('open', resolve)
        ws.once('error', reject)
      })
      ws.send(JSON.stringify({ type: 'setDraft', value: true }))
      ws.close()

      // 给进程一点时间处理这条消息——没打补丁的实现会在这里因为
      // unhandledRejection 直接崩溃退出整个进程。
      await new Promise((r) => setTimeout(r, 1000))

      assert.equal(
        child.exitCode,
        null,
        `texwatch 进程不应该崩溃退出（exitCode=${child.exitCode}）\nstdout:\n${stdout}\nstderr:\n${stderr}`
      )

      // 服务应该还活着，能正常响应后续请求。
      const res = await fetch(`${url}/`)
      assert.equal(res.status, 200, '崩溃修复后，setDraft 出错不应该影响服务继续响应请求')

      // 出错必须被打印出来，不能静默吞掉。
      assert.match(stderr, /找不到 \\begin\{document\}|切换 draft 模式失败/)
    } finally {
      child.kill('SIGKILL')
    }
  }
)
