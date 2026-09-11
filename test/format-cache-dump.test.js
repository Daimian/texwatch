import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ensureFormat, formatName } from '../src/format-cache.js'
import { hasTexToolchain } from '../src/compiler.js'

// formatName('main.tex') 恒产出 texwatch-main-<8位hash>（Task 15 已定型的碰撞消除设计），
// 而不是 brief 里手写伪代码假设的裸 'texwatch-main'。这里用真实实现算出期望值，
// 而不是硬编码字面量，避免测试跟协议脱节。
const EXPECTED_NAME = formatName('main.tex')

const DOC = `\\documentclass{article}
\\usepackage{amsmath}
\\begin{document}
hi
\\end{document}
`

async function makeConfig({ draft = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'texwatch-fmt-'))
  await fs.writeFile(path.join(root, 'main.tex'), DOC)
  return {
    root,
    mainTex: path.join(root, 'main.tex'),
    mainTexRelative: 'main.tex',
    fmtDir: path.join(root, '.texwatch/fmt'),
    draft,
  }
}

test('draft 模式直接返回 null，不做任何 dump', async () => {
  const config = await makeConfig({ draft: true })
  assert.equal(await ensureFormat(config), null)
  await assert.rejects(() => fs.stat(config.fmtDir), '不该创建 fmt 目录')
})

test('主文件不存在时返回 null 而不是抛错', async () => {
  const config = await makeConfig()
  await fs.rm(config.mainTex)
  assert.equal(await ensureFormat(config), null)
})

describe('需要 TeX 环境', async () => {
  const available = await hasTexToolchain()
  const skip = available ? false : '未检测到 TeX 环境'

  test('首次调用会 dump 出 .fmt 并返回 format 名', { skip }, async () => {
    const config = await makeConfig()
    const name = await ensureFormat(config)
    assert.equal(name, EXPECTED_NAME)
    const stat = await fs.stat(path.join(config.fmtDir, `${name}.fmt`))
    assert.ok(stat.size > 0)
  })

  test('preamble 没变时不重新 dump（.fmt 的 mtime 不变）', { skip }, async () => {
    const config = await makeConfig()
    await ensureFormat(config)
    const fmtFile = path.join(config.fmtDir, `${EXPECTED_NAME}.fmt`)
    const before = (await fs.stat(fmtFile)).mtimeMs

    await new Promise((r) => setTimeout(r, 1100))
    await ensureFormat(config)
    const after = (await fs.stat(fmtFile)).mtimeMs

    assert.equal(before, after, 'preamble 没变就不该重新 dump')
  })

  test('preamble 变了会重新 dump', { skip }, async () => {
    const config = await makeConfig()
    await ensureFormat(config)
    const fmtFile = path.join(config.fmtDir, `${EXPECTED_NAME}.fmt`)
    const before = (await fs.stat(fmtFile)).mtimeMs

    await new Promise((r) => setTimeout(r, 1100))
    await fs.writeFile(config.mainTex, DOC.replace('amsmath', 'amssymb'))
    await ensureFormat(config)
    const after = (await fs.stat(fmtFile)).mtimeMs

    assert.ok(after > before, 'preamble 变了就该重新 dump')
  })

  test('preamble 里有无法 dump 的内容时静默降级为 null', { skip }, async () => {
    const config = await makeConfig()
    await fs.writeFile(
      config.mainTex,
      '\\documentclass{article}\n\\usepackage{绝对不存在的宏包名}\n\\begin{document}\nx\n\\end{document}\n'
    )
    assert.equal(await ensureFormat(config), null, 'dump 失败必须降级，不能抛错')
  })
})
