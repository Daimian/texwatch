import http from 'node:http'
import net from 'node:net'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

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

  return {
    port,
    url: `http://127.0.0.1:${port}`,
    httpServer: server,
    close: () => new Promise((r) => server.close(r)),
  }
}
