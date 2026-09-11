import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { WebSocket } from 'ws'
import { createServer } from '../src/server.js'

const SERVER_JS_PATH = fileURLToPath(new URL('../src/server.js', import.meta.url))

async function makeConfig() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'texwatch-ws-'))
  await fs.mkdir(path.join(root, '.texwatch/build'), { recursive: true })
  return {
    root,
    mainTex: path.join(root, 'main.tex'),
    mainTexRelative: 'main.tex',
    outDir: path.join(root, '.texwatch/build'),
    lastGoodPdf: path.join(root, '.texwatch/last-good.pdf'),
    port: 0,
    draft: false,
  }
}

// 连接建立后立刻（同步）挂上 message 监听并把收到的消息缓冲进队列，而不是等
// `open` resolve 之后才挂监听器。原因：服务端在收到连接后会同步 send() 初始
// 状态，在本机回环网络下，客户端可能在同一次底层读取里把「握手响应」和「第一帧
// 消息」一起处理完——open 和 message 会在同一个 tick 内相继触发。若在
// `await ws.once('open', ...)` resolve 之后（下一个 microtask）才去挂
// message 监听器，第一条消息就已经被 EventEmitter 丢弃（发出时无人监听），
// 后续 await 永远等不到消息而挂起。用队列缓冲彻底消除这个时序竞争。
function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${url.replace('http', 'ws')}/ws`)
    const queue = []
    const waiters = []
    ws.on('message', (d) => {
      const msg = JSON.parse(d.toString())
      if (waiters.length) waiters.shift()(msg)
      else queue.push(msg)
    })
    ws.once('error', reject)
    ws.once('open', () => resolve(ws))
    ws._nextMessage = () =>
      new Promise((res) => {
        if (queue.length) res(queue.shift())
        else waiters.push(res)
      })
  })
}

const nextMessage = (ws) => ws._nextMessage()

test('客户端一连上就收到完整的当前状态', async () => {
  const config = await makeConfig()
  const srv = await createServer({ config })
  try {
    srv.setState({ state: 'ok', durationMs: 1234, diagnostics: [] })

    const ws = await connect(srv.url)
    try {
      const msg = await nextMessage(ws)

      assert.equal(msg.state, 'ok')
      assert.equal(msg.durationMs, 1234)
      assert.equal(msg.draft, false)
      assert.equal(typeof msg.pdfVersion, 'number')
      assert.equal(typeof msg.pdfStale, 'boolean')
    } finally {
      ws.close()
    }
  } finally {
    await srv.close()
  }
})

test('setState 后所有客户端都收到更新', async () => {
  const config = await makeConfig()
  const srv = await createServer({ config })
  try {
    const a = await connect(srv.url)
    const b = await connect(srv.url)
    try {
      await nextMessage(a)
      await nextMessage(b)

      const pa = nextMessage(a)
      const pb = nextMessage(b)
      srv.setState({ state: 'compiling', kind: 'tex' })

      assert.equal((await pa).state, 'compiling')
      assert.equal((await pb).state, 'compiling')
    } finally {
      a.close()
      b.close()
    }
  } finally {
    await srv.close()
  }
})

test('setState 是增量合并，不会抹掉没传的字段', async () => {
  const config = await makeConfig()
  const srv = await createServer({ config })
  try {
    srv.setState({ state: 'ok', durationMs: 999 })

    const ws = await connect(srv.url)
    try {
      await nextMessage(ws)

      const p = nextMessage(ws)
      srv.setState({ state: 'compiling' })
      const msg = await p

      assert.equal(msg.state, 'compiling')
      assert.equal(msg.durationMs, 999, 'durationMs 不该被抹掉')
    } finally {
      ws.close()
    }
  } finally {
    await srv.close()
  }
})

test('客户端发来的 setDraft 会触发回调', async () => {
  const config = await makeConfig()
  const srv = await createServer({ config })
  try {
    const received = []
    srv.onClientMessage((m) => received.push(m))

    const ws = await connect(srv.url)
    try {
      await nextMessage(ws)
      ws.send(JSON.stringify({ type: 'setDraft', value: true }))
      await new Promise((r) => setTimeout(r, 100))

      assert.deepEqual(received, [{ type: 'setDraft', value: true }])
    } finally {
      ws.close()
    }
  } finally {
    await srv.close()
  }
})

// 复审发现的 Critical：wss.on('connection') 里只挂了 message 监听器，没挂
// error 监听器。EventEmitter 对无人监听的 'error' 事件会直接 throw，超过
// maxPayload（或任何协议错误帧）都会把整个 texwatch 进程带崩，而不只是
// 断开那一个连接。这个回归必须用独立子进程复现——真的发一个超大帧会让
// 没打补丁的实现直接崩溃退出整个进程，不能在当前测试进程里直接发，否则会
// 把 npm test 自己带崩。
async function startServerSubprocess(config) {
  const scriptPath = path.join(
    os.tmpdir(),
    `texwatch-crash-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`
  )
  // 故意不加任何全局 uncaughtException 兜底，模拟 bin/texwatch.js 现状——
  // 这样才能真实复现「没有 per-connection/wss 级 error 监听器就会整进程崩溃」。
  const script = [
    `import { createServer } from ${JSON.stringify(SERVER_JS_PATH)}`,
    `const config = ${JSON.stringify(config)}`,
    'const srv = await createServer({ config })',
    "process.stdout.write('SERVER_UP ' + srv.url + '\\n')",
    '',
  ].join('\n')
  await fs.writeFile(scriptPath, script)

  const child = spawn(process.execPath, [scriptPath], { stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', (d) => (stderr += d.toString()))

  const url = await new Promise((resolve, reject) => {
    let stdout = ''
    let timer
    function cleanup() {
      clearTimeout(timer)
      child.stdout.off('data', onData)
      child.off('exit', onExit)
    }
    function onData(d) {
      stdout += d.toString()
      const m = stdout.match(/SERVER_UP (\S+)/)
      if (m) {
        cleanup()
        resolve(m[1])
      }
    }
    function onExit(code) {
      cleanup()
      reject(new Error(`子进程在启动阶段就退出了，code=${code}\nstderr: ${stderr}`))
    }
    child.stdout.on('data', onData)
    child.once('exit', onExit)
    timer = setTimeout(() => {
      cleanup()
      reject(new Error('等待子进程启动超时'))
    }, 10_000)
  })

  return { child, url, scriptPath, getStderr: () => stderr }
}

test('超过 maxPayload 的帧不会让服务端进程崩溃（per-connection + wss 级 error 监听）', async () => {
  const config = await makeConfig()
  const { child, url, scriptPath, getStderr } = await startServerSubprocess(config)
  try {
    const ws = new WebSocket(`${url.replace('http', 'ws')}/ws`)
    await new Promise((resolve, reject) => {
      ws.once('open', resolve)
      ws.once('error', reject)
    })
    ws.on('error', () => {}) // 客户端这边因协议错误被关闭是预期行为，不用关心

    // src/server.js 里 maxPayload 是 1_000_000，发一个明显超过它的帧
    const big = 'x'.repeat(2 * 1024 * 1024)
    ws.send(big)

    // 给子进程一点时间处理这帧——没打补丁的实现会在这里因为
    // "Unhandled 'error' event" 崩溃退出整个进程
    await new Promise((r) => setTimeout(r, 800))

    assert.equal(
      child.exitCode,
      null,
      `服务端子进程不应该崩溃退出（exitCode=${child.exitCode}）\nstderr:\n${getStderr()}`
    )

    const res = await fetch(`${url}/`)
    assert.equal(res.status, 200, '发完超大帧之后，服务应该还活着，能正常响应后续请求')
  } finally {
    child.kill('SIGKILL')
    await fs.rm(scriptPath, { force: true })
  }
})

test('客户端发来的非法 JSON 不会让服务崩溃', async () => {
  const config = await makeConfig()
  const srv = await createServer({ config })
  try {
    const ws = await connect(srv.url)
    try {
      await nextMessage(ws)

      ws.send('这不是 JSON')
      await new Promise((r) => setTimeout(r, 100))

      const res = await fetch(`${srv.url}/`)
      assert.equal(res.status, 200, '服务应该还活着')
    } finally {
      ws.close()
    }
  } finally {
    await srv.close()
  }
})
