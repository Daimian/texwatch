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

  // 回归：outDir 是增量编译复用的。本轮致命错误（Emergency stop）时 latexmk 会原样
  // 留着上一轮的旧 PDF 不动——若 ok 只看「PDF 是否存在」，这轮失败会被旧 PDF 掩盖成
  // 「成功」，用户看到的其实是改动前的旧图，会误以为改动生效了。这是本项目作为
  // watch 工具的核心场景（同一 outDir 反复编译），比初次编译失败严重得多。
  test('回归：outDir 有旧 PDF 时，致命错误不能被旧 PDF 掩盖成功', { skip: available ? false : '未检测到 TeX 环境' }, async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'texwatch-int-'))
    const texPath = path.join(dir, 'stale.tex')
    await fs.writeFile(texPath, MINIMAL)
    const config = {
      root: dir,
      mainTex: texPath,
      outDir: path.join(dir, '.texwatch/build'),
      draft: false,
    }

    const first = await runCompile({ config, kind: 'full', fmtName: null })
    assert.equal(first.ok, true, `第一轮应该成功，诊断：${JSON.stringify(first.diagnostics)}`)
    const staleStat = await fs.stat(first.pdfPath)

    // 源文件改成致命错误（缺宏包），但不清空 outDir——模拟 watch 场景下的增量编译
    await fs.writeFile(
      texPath,
      '\\documentclass{article}\n\\usepackage{thispackagedoesnotexist}\n\\begin{document}\nhello\n\\end{document}\n'
    )

    const second = await runCompile({ config, kind: 'full', fmtName: null })
    assert.equal(
      second.ok,
      false,
      `旧 PDF 不该被当成本轮成功产物，诊断：${JSON.stringify(second.diagnostics)}`
    )

    // 旧 PDF 文件本身确实还在（latexmk 的真实行为），但不能作为「本轮成功」的依据
    const afterStat = await fs.stat(first.pdfPath)
    assert.equal(afterStat.mtimeMs, staleStat.mtimeMs, '致命错误时旧 PDF 应保持原样未被重写（前提假设，用于确认这条测试确实在测「旧图掩盖」这个场景）')
  })

  // 回归：latexmk 判定「无需重编」时会原样保留 PDF、完全不重写它（常见于没有 -g
  // 强制全量的普通改动）。此时 pdfChanged 必然为 false，但这是完全正常的成功——
  // 必须靠 exitCode === 0 兜住，否则会把这种最常见的「未改动/已是最新」场景误判为
  // 失败。这条测试专门防止未来有人把判据简化成「只看 mtime 是否变化」。
  test('回归：连续编译同一未改动项目两次，两次都应该 ok 为 true（即使第二次无需重编）', { skip: available ? false : '未检测到 TeX 环境' }, async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'texwatch-int-'))
    const texPath = path.join(dir, 'stable.tex')
    await fs.writeFile(texPath, MINIMAL)
    const config = {
      root: dir,
      mainTex: texPath,
      outDir: path.join(dir, '.texwatch/build'),
      draft: false,
    }

    // kind: 'tex'（而非 'full'/'preamble'/'bib'）才不会强制 -g 全量重跑，
    // 才能真正触发 latexmk 自己的「无需重编」判定
    const first = await runCompile({ config, kind: 'tex', fmtName: null })
    assert.equal(first.ok, true, `第一轮应该成功，诊断：${JSON.stringify(first.diagnostics)}`)
    const firstStat = await fs.stat(first.pdfPath)

    const second = await runCompile({ config, kind: 'tex', fmtName: null })
    assert.equal(
      second.ok,
      true,
      `未改动项目重新编译也应该 ok 为 true，诊断：${JSON.stringify(second.diagnostics)}`
    )
    assert.equal(second.exitCode, 0, 'latexmk 判定无需重编时退出码应为 0')

    const secondStat = await fs.stat(second.pdfPath)
    assert.equal(secondStat.mtimeMs, firstStat.mtimeMs, 'latexmk 判定无需重编时不应重写 PDF（前提假设，用于确认这条测试确实在测 pdfChanged=false 的分支）')
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
