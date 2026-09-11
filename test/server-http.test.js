import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { createServer, findFreePort, publishPdf } from '../src/server.js'

async function makeConfig() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'texwatch-s-'))
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

test('findFreePort: 端口被占用时自动 +1', async () => {
  const blocker = net.createServer()
  await new Promise((r) => blocker.listen(0, r))
  try {
    const taken = blocker.address().port

    const got = await findFreePort(taken)
    assert.notEqual(got, taken)
    assert.ok(got > taken)
  } finally {
    await new Promise((r) => blocker.close(r))
  }
})

test('publishPdf: 拷贝到 last-good 并让版本号递增', async () => {
  const config = await makeConfig()
  const src = path.join(config.outDir, 'main.pdf')
  await fs.writeFile(src, '%PDF-1.5 first')

  const v1 = await publishPdf(config, src)
  assert.equal(await fs.readFile(config.lastGoodPdf, 'utf8'), '%PDF-1.5 first')

  await fs.writeFile(src, '%PDF-1.5 second')
  const v2 = await publishPdf(config, src)
  assert.ok(v2 > v1, '版本号必须递增')
  assert.equal(await fs.readFile(config.lastGoodPdf, 'utf8'), '%PDF-1.5 second')
})

test('GET / 返回 HTML 预览页', async () => {
  const config = await makeConfig()
  const srv = await createServer({ config })
  try {
    const res = await fetch(`${srv.url}/`)
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-type'), /text\/html/)
    assert.match(await res.text(), /<canvas|<div/)
  } finally {
    await srv.close()
  }
})

test('GET /pdf 在还没有 last-good 时返回 404', async () => {
  const config = await makeConfig()
  const srv = await createServer({ config })
  try {
    const res = await fetch(`${srv.url}/pdf`)
    assert.equal(res.status, 404)
  } finally {
    await srv.close()
  }
})

test('GET /pdf 返回 PDF 且带 ETag', async () => {
  const config = await makeConfig()
  const src = path.join(config.outDir, 'main.pdf')
  const body = '%PDF-1.5 body'
  await fs.writeFile(src, body)
  await publishPdf(config, src)

  const srv = await createServer({ config })
  try {
    const res = await fetch(`${srv.url}/pdf`)
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('content-type'), 'application/pdf')
    assert.ok(res.headers.get('etag'), '必须带 ETag')
    assert.equal(await res.text(), body, '响应体必须就是已发布的 PDF 内容')
  } finally {
    await srv.close()
  }
})

test('publishPdf: 源文件不存在时 reject', async () => {
  const config = await makeConfig()
  const missing = path.join(config.outDir, 'does-not-exist.pdf')

  await assert.rejects(() => publishPdf(config, missing))
})

test('未知路径返回 404', async () => {
  const config = await makeConfig()
  const srv = await createServer({ config })
  try {
    const res = await fetch(`${srv.url}/nope`)
    assert.equal(res.status, 404)
  } finally {
    await srv.close()
  }
})
