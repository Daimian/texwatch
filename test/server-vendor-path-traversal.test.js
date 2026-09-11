// 复审修复轮：给 src/server.js:84-90 的 /vendor/ 路径穿越防护补自动化回归。
//
// 这段 path.relative 检查是全项目唯一的安全边界（grep `vendor` 在 test/ 下
// 此前没有任何结果），只靠过一次性人工验证托底——这恰是未来重构最容易静默
// 改坏的那类代码：换一种字符串拼接方式、或者把 path.relative 换成
// startsWith 判断，都可能在完全不触发其它测试的情况下重新打开这个洞。
//
// 不能用 fetch：fetch/undici 在发出请求前会按 WHATWG URL 规范把字面 `../`
// 在客户端就自己规范化掉（`new URL('/vendor/../../etc/passwd', base).pathname`
// 直接变成 `/etc/passwd`），根本不会把 `../` 原样发到服务端，测不出服务端
// 自己的防护有没有生效。这里改用裸 TCP socket 直接拼字节发 HTTP 请求行，
// 精确控制线上到底发了什么——等价于 `curl --path-as-is`。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createServer } from '../src/server.js'

async function makeConfig() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'texwatch-trav-'))
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

// 手写最小 HTTP/1.1 请求行，绕开任何客户端库的路径规范化。
// 响应体没设 Content-Length 时，Node 的 http 模块默认用 chunked 传输编码
// （`<hex长度>\r\n<数据>\r\n` 反复，以 `0\r\n\r\n` 收尾）——这里手写最小解码，
// 只处理 serveFile/403/404 这几个响应路径会产生的简单单帧/多帧场景，不
// 追求通用 HTTP 客户端的完整性。
function dechunk(raw) {
  let out = ''
  let rest = raw
  while (rest.length) {
    const lineEnd = rest.indexOf('\r\n')
    if (lineEnd === -1) break
    const sizeHex = rest.slice(0, lineEnd).trim()
    const size = parseInt(sizeHex, 16)
    if (!Number.isFinite(size) || size === 0) break
    out += rest.slice(lineEnd + 2, lineEnd + 2 + size)
    rest = rest.slice(lineEnd + 2 + size + 2) // 跳过数据后的 \r\n
  }
  return out
}

function rawGet(port, rawPath) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(`GET ${rawPath} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`)
    })
    let data = Buffer.alloc(0)
    socket.on('data', (d) => {
      data = Buffer.concat([data, d])
    })
    socket.on('end', () => {
      const str = data.toString('latin1')
      const idx = str.indexOf('\r\n\r\n')
      const head = idx >= 0 ? str.slice(0, idx) : str
      const rawBody = idx >= 0 ? str.slice(idx + 4) : ''
      const isChunked = /transfer-encoding:\s*chunked/i.test(head)
      const body = isChunked ? dechunk(rawBody) : rawBody
      const statusLine = head.split('\r\n')[0]
      const status = Number(statusLine.split(' ')[1])
      resolve({ status, body })
    })
    socket.on('error', reject)
    const timer = setTimeout(() => reject(new Error(`rawGet(${rawPath}) 超时`)), 5000)
    socket.on('close', () => clearTimeout(timer))
  })
}

// 已知安全响应体的白名单：只要响应体是这两者之一，就不可能带出真实文件内容
// （serveFile 成功时永远直接 res.end(body) 原始文件内容，不会是这两个固定
// 字符串）。
const SAFE_BODIES = new Set(['not found', 'forbidden'])

const VECTORS = [
  ['字面 ../ 逐级向上', '/vendor/../../../../../../../../etc/passwd'],
  ['URL 编码 ..%2f', '/vendor/..%2f..%2f..%2f..%2f..%2f..%2fetc/passwd'],
  ['双重编码 %252e%252e%252f', '/vendor/%252e%252e%252f%252e%252e%252f%252e%252e%252fetc%252fpasswd'],
  ['绝对路径注入 /vendor//etc/passwd', '/vendor//etc/passwd'],
  ['....// 变体', '/vendor/....//....//....//....//....//....//etc/passwd'],
]

for (const [label, rawPath] of VECTORS) {
  test(`/vendor/ 路径穿越防护：${label}`, async () => {
    const config = await makeConfig()
    const srv = await createServer({ config })
    try {
      const { status, body } = await rawGet(srv.port, rawPath)
      assert.ok(
        status === 403 || status === 404,
        `期望 403 或 404，实际 ${status}（body: ${JSON.stringify(body)}）`
      )
      assert.ok(
        SAFE_BODIES.has(body.trim()),
        `响应体必须是已知的安全占位文本之一，不能带出 client/vendor/ 之外的任何文件内容；实际收到 ${JSON.stringify(body)}`
      )
    } finally {
      await srv.close()
    }
  })
}

test('/vendor/ 正常访问仍然可用（防护没有误伤合法请求）', async () => {
  const config = await makeConfig()
  const srv = await createServer({ config })
  try {
    const { status, body } = await rawGet(srv.port, '/vendor/does-not-exist-but-inside.txt')
    // 这个文件在 vendor 目录内部本来就不存在，应该走「文件不存在」的 404，
    // 而不是「路径穿越」的 403——用来确认防护没有把合法的、落在 vendor
    // 目录内部的路径也一起挡掉。
    assert.equal(status, 404)
    assert.equal(body.trim(), 'not found')
  } finally {
    await srv.close()
  }
})
