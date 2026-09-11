import http from 'node:http'
import net from 'node:net'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'

const here = path.dirname(fileURLToPath(import.meta.url))
const CLIENT_DIR = path.join(here, '..', 'client')

let pdfVersionCounter = 0

// 在 macOS 上，不带 host 参数的 listen() 会绑定 IPv6-only 的 `::`，与显式绑定
// `127.0.0.1`（IPv4）的 listener 互不冲突——两者是不同的地址族，谁也不会让谁
// EADDRINUSE。我们最终要监听的是 127.0.0.1，但为了正确探测「端口是否已被别的
// 进程占用」（不管对方绑的是哪个地址族），这里两个地址族都要探测一遍：只要
// 有一个绑不上，就认为端口不可用。
function tryListen(port, host) {
  return new Promise((resolve) => {
    const s = net.createServer()
    s.once('error', () => resolve(false))
    s.once('listening', () => s.close(() => resolve(true)))
    if (host) s.listen(port, host)
    else s.listen(port)
  })
}

export async function findFreePort(startPort, maxTries = 50) {
  for (let p = startPort; p < startPort + maxTries; p++) {
    const freeOnDefaultHost = await tryListen(p)
    const freeOnLoopback = freeOnDefaultHost && (await tryListen(p, '127.0.0.1'))
    if (freeOnLoopback) return p
  }
  throw new Error(`从 ${startPort} 开始连续 ${maxTries} 个端口都被占用`)
}

export async function publishPdf(config, pdfPath) {
  await fs.copyFile(pdfPath, config.lastGoodPdf)
  return ++pdfVersionCounter
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json',
  '.bcmap': 'application/octet-stream',
  '.pfb': 'application/octet-stream',
  '.ttf': 'font/ttf',
}

async function serveFile(res, filePath) {
  try {
    const body = await fs.readFile(filePath)
    res.writeHead(200, {
      'content-type': MIME[path.extname(filePath)] ?? 'application/octet-stream',
    })
    res.end(body)
  } catch {
    res.writeHead(404).end('not found')
  }
}

export async function createServer({ config }) {
  const port = await findFreePort(config.port || 3577)

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`)

    if (url.pathname === '/') return serveFile(res, path.join(CLIENT_DIR, 'index.html'))
    if (url.pathname === '/app.js') return serveFile(res, path.join(CLIENT_DIR, 'app.js'))
    if (url.pathname === '/scroll-anchor.js') {
      return serveFile(res, path.join(CLIENT_DIR, 'scroll-anchor.js'))
    }
    if (url.pathname === '/version-tracker.js') {
      return serveFile(res, path.join(CLIENT_DIR, 'version-tracker.js'))
    }

    if (url.pathname.startsWith('/vendor/')) {
      const rel = url.pathname.slice('/vendor/'.length)
      const vendorDir = path.join(CLIENT_DIR, 'vendor')
      const target = path.join(vendorDir, rel)
      // 防止路径穿越：用 path.relative 判断拼出的路径是否仍落在 client/vendor/ 目录下。
      // （单纯 target.startsWith(vendorDir) 不够——同级目录 "vendor-evil" 也会通过
      //  字符串前缀比较，必须按路径语义比较，见任务报告。）
      const relToVendor = path.relative(vendorDir, target)
      if (relToVendor.startsWith('..') || path.isAbsolute(relToVendor)) {
        return res.writeHead(403).end('forbidden')
      }
      return serveFile(res, target)
    }

    if (url.pathname === '/pdf') {
      try {
        const body = await fs.readFile(config.lastGoodPdf)
        res.writeHead(200, {
          'content-type': 'application/pdf',
          etag: `"v${pdfVersionCounter}"`,
          'cache-control': 'no-cache',
        })
        return res.end(body)
      } catch {
        return res.writeHead(404).end('还没有成功编译出的 PDF')
      }
    }

    res.writeHead(404).end('not found')
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })

  // maxPayload 防御超大帧：客户端只会发很小的控制消息（如 setDraft），
  // 没有理由允许超大帧占用内存/带宽。
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 1_000_000 })

  let state = {
    state: 'idle',
    kind: null,
    durationMs: null,
    diagnostics: [],
    pdfVersion: pdfVersionCounter,
    pdfStale: false,
    draft: config.draft,
  }

  const clientHandlers = []

  function broadcast(message) {
    const payload = JSON.stringify(message)
    for (const client of wss.clients) {
      if (client.readyState === 1) client.send(payload)
    }
  }

  function setState(partial) {
    state = { ...state, ...partial, pdfVersion: pdfVersionCounter }
    broadcast(state)
  }

  // wss（WebSocketServer 实例）本身也会转发底层 http.Server 的 'error' 事件
  // （见 ws 内部 addListeners(server, { error: wss.emit.bind(wss,'error') })），
  // 这是和「单个连接的 error」完全独立的另一条路径：EventEmitter 对无人监听的
  // 'error' 事件会直接 throw，不管是哪个 EventEmitter 实例。已实测验证：
  // 手动 server.emit('error', ...) 会在没有这个监听器时把整个进程带崩。
  wss.on('error', (err) => {
    console.error('[server] wss 级错误：', err)
  })

  wss.on('connection', (ws) => {
    // 每个连接自己的 socket/协议错误（畸形帧、超过 maxPayload 等）也会走
    // EventEmitter 的 'error' 事件；同样是「无人监听就 throw、带崩整个进程」，
    // 且这条路径和上面 wss 级的 'error' 是两个不同的 EventEmitter 实例，必须
    // 分别处理。已实测验证：不加这个监听器，客户端发一个超过 maxPayload 的
    // 帧就会让整个 texwatch 进程崩溃退出。这里只需要防止崩溃——连接本身会被
    // ws 库自动关闭，不需要额外处理。
    ws.on('error', (err) => {
      console.error('[server] WebSocket 连接错误：', err.message)
    })
    // 新客户端立刻拿到完整状态，刷新页面才不会白屏
    ws.send(JSON.stringify({ ...state, pdfVersion: pdfVersionCounter }))
    ws.on('message', (data) => {
      let parsed
      try {
        parsed = JSON.parse(data.toString())
      } catch {
        return // 非法 JSON（含空消息）直接忽略，不能让服务挂掉
      }
      // 只把「看起来像消息」的对象转发给回调，防止 `5`、`"foo"`、`null`
      // 这类合法 JSON 但非预期形状的输入传播到业务逻辑里。
      if (typeof parsed !== 'object' || parsed === null) return
      for (const h of clientHandlers) h(parsed)
    })
  })

  return {
    port,
    url: `http://127.0.0.1:${port}`,
    httpServer: server,
    broadcast,
    setState,
    getState: () => state,
    onClientMessage: (cb) => clientHandlers.push(cb),
    close: async () => {
      for (const c of wss.clients) c.terminate()
      await new Promise((r) => wss.close(r))
      await new Promise((r) => server.close(r))
    },
  }
}
