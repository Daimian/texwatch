// bin/texwatch.js 是全项目改动最频繁的文件之一（watch 模式、起服务、接 fmt、
// draft 切换都会陆续往里加），但它自己不导出任何函数，无法单元测试。这里用
// node:child_process 起真实子进程跑它，覆盖 --help、未知参数、--once 的三种
// 结局（成功产出 PDF / 致命错误不产出 PDF / 找不到主文件），防止后续改写在
// 接线逻辑上裸奔回归。
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { hasTexToolchain } from '../src/compiler.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const BIN = path.join(__dirname, '..', 'bin', 'texwatch.js')

const MINIMAL = `\\documentclass{article}
\\begin{document}
texwatch cli smoke test
\\end{document}
`

const BROKEN = `\\documentclass{article}
\\usepackage{thispackagedoesnotexist}
\\begin{document}
hello world
\\end{document}
`

function runCli(args, { cwd } = {}) {
  return spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 60_000,
  })
}

test('--help：退出码 0，输出含用法说明', () => {
  const r = runCli(['--help'])
  assert.equal(r.status, 0)
  assert.match(r.stdout, /用法/)
  assert.match(r.stdout, /texwatch/)
})

test('未知参数：非零退出码，stderr 里有提示', () => {
  const r = runCli(['--nonsense'])
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /未知参数/)
})

describe('--once：需要真实 TeX 环境', async () => {
  const available = await hasTexToolchain()
  const skip = available ? false : '未检测到 TeX 环境'

  test('最小文档：退出码 0，输出含耗时与 PDF 路径', { skip }, async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'texwatch-smoke-'))
    await fs.writeFile(path.join(dir, 'tiny.tex'), MINIMAL)

    const r = runCli(['--once', 'tiny.tex'], { cwd: dir })

    assert.equal(r.status, 0, `stdout: ${r.stdout}\nstderr: ${r.stderr}`)
    assert.match(r.stdout, /\d+(\.\d+)?s/, '应该打印耗时')
    assert.match(r.stdout, /PDF/)
    assert.match(r.stdout, /tiny\.pdf/)
  })

  test('缺宏包致命错误：非零退出码，输出含错误诊断', { skip }, async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'texwatch-smoke-'))
    await fs.writeFile(path.join(dir, 'broken.tex'), BROKEN)

    const r = runCli(['--once', 'broken.tex'], { cwd: dir })

    assert.notEqual(r.status, 0, `stdout: ${r.stdout}\nstderr: ${r.stderr}`)
    assert.match(r.stdout, /错误/)
  })

  test('空目录（没有 .tex）：非零退出码，提示找不到主文件', { skip }, async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'texwatch-smoke-'))

    const r = runCli(['--once'], { cwd: dir })

    assert.notEqual(r.status, 0, `stdout: ${r.stdout}\nstderr: ${r.stderr}`)
    assert.match(r.stderr, /没有找到主文件/)
  })
})
