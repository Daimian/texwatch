import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { WebSocket } from 'ws'
import { createServer } from '../src/server.js'

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
