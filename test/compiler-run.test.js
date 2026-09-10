import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { runCompile, hasTexToolchain } from '../src/compiler.js'

const MINIMAL = `\\documentclass{article}
\\begin{document}
texwatch integration test
\\end{document}
`

describe('集成：真实调用 latexmk', async () => {
  const available = await hasTexToolchain()

  test('最小文档能编出 PDF', { skip: available ? false : '未检测到 TeX 环境' }, async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'texwatch-int-'))
    await fs.writeFile(path.join(dir, 'tiny.tex'), MINIMAL)
    const config = {
      root: dir,
      mainTex: path.join(dir, 'tiny.tex'),
      outDir: path.join(dir, '.texwatch/build'),
      draft: false,
    }

    const result = await runCompile({ config, kind: 'full', fmtName: null })

    assert.equal(result.ok, true, `编译应该成功，诊断：${JSON.stringify(result.diagnostics)}`)
    assert.ok(result.pdfPath, '应该返回 PDF 路径')
    const stat = await fs.stat(result.pdfPath)
    assert.ok(stat.size > 0, 'PDF 不应为空')
    assert.ok(result.durationMs > 0)
  })

  // 裁定：`\nosuchcommand` 只是未定义控制序列，在 -interaction=nonstopmode -f 下
  // pdflatex 会报错但仍产出 PDF（已实跑验证），所以它不是「编译失败」的例子。
  // 真正致命、不产出 PDF 的是缺宏包触发的 Emergency stop。
  test('致命错误（缺宏包）：ok 为 false 且带上诊断，不产出 PDF', { skip: available ? false : '未检测到 TeX 环境' }, async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'texwatch-int-'))
    await fs.writeFile(
      path.join(dir, 'broken.tex'),
      '\\documentclass{article}\n\\usepackage{thispackagedoesnotexist}\n\\begin{document}\nhello world\n\\end{document}\n'
    )
    const config = {
      root: dir,
      mainTex: path.join(dir, 'broken.tex'),
      outDir: path.join(dir, '.texwatch/build'),
      draft: false,
    }

    const result = await runCompile({ config, kind: 'full', fmtName: null })

    assert.equal(result.ok, false)
    assert.ok(result.diagnostics.some((d) => d.severity === 'error'))
    assert.equal(result.pdfPath, null, '缺宏包导致 Emergency stop，不应有 PDF')
  })

  // M0 教训的缩影：目标论文里 authoryear/elsarticle-num 不匹配触发 natbib 报错，
  // 但 natbib 会自恢复，PDF 完全正确。非零退出码 + 可用 PDF 是常态而非异常，
  // 「有错也要把 PDF 给用户看」是本项目的核心行为，用 \nosuchcommand 复现同类场景。
  test('非致命错误：有 error 诊断但仍产出 PDF，ok 为 true', { skip: available ? false : '未检测到 TeX 环境' }, async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'texwatch-int-'))
    await fs.writeFile(
      path.join(dir, 'nonfatal.tex'),
      '\\documentclass{article}\n\\begin{document}\nhello \\nosuchcommand world\n\\end{document}\n'
    )
    const config = {
      root: dir,
      mainTex: path.join(dir, 'nonfatal.tex'),
      outDir: path.join(dir, '.texwatch/build'),
      draft: false,
    }

    const result = await runCompile({ config, kind: 'full', fmtName: null })

    assert.equal(result.ok, true, `应该仍视为成功，诊断：${JSON.stringify(result.diagnostics)}`)
    assert.ok(result.diagnostics.some((d) => d.severity === 'error'), '应该能看到未定义控制序列这条 error')
    assert.ok(result.pdfPath, '应该有 PDF 路径')
    const stat = await fs.stat(result.pdfPath)
    assert.ok(stat.size > 0, 'PDF 不应为空')
  })
})

test('超时会被强杀并标记 timedOut', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'texwatch-int-'))
  const config = {
    root: dir,
    mainTex: path.join(dir, 'tiny.tex'),
    outDir: path.join(dir, '.texwatch/build'),
    draft: false,
  }
  // 用一个必定超时的极短 timeout 打到 sleep 上，验证超时路径本身
  const result = await runCompile({
    config,
    kind: 'full',
    fmtName: null,
    timeoutMs: 50,
    commandOverride: { cmd: 'sleep', args: ['5'] },
  })
  assert.equal(result.timedOut, true)
  assert.equal(result.ok, false)
})
