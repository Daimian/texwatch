#!/usr/bin/env node
import fs from 'node:fs/promises'
import path from 'node:path'
import { parseArgv, formatDiagnostics } from '../src/cli-args.js'
import { resolveConfig } from '../src/config.js'
import { runCompile, hasTexToolchain } from '../src/compiler.js'

const HELP = `texwatch —— 本地 LaTeX 编译预览

用法：texwatch [主文件.tex] [选项]

  --port <n>   预览服务端口，默认 3577，被占用则自动 +1
  --draft      draft 模式，图片只画空框，编译更快
  --no-open    不自动打开浏览器
  --once       只编译一次，打印诊断后退出
  --clean      清空 .texwatch/ 后退出
  -h, --help   显示本帮助
`

async function main() {
  let args
  try {
    args = parseArgv(process.argv.slice(2))
  } catch (err) {
    console.error(err.message)
    process.exit(2)
  }

  if (args.help) {
    console.log(HELP)
    return
  }

  if (args.clean) {
    const dir = path.join(process.cwd(), '.texwatch')
    await fs.rm(dir, { recursive: true, force: true })
    console.log(`已清空 ${dir}`)
    return
  }

  if (!(await hasTexToolchain())) {
    console.error(
      '找不到 latexmk。先装 TeX 环境：\n' +
        '  brew install --cask basictex\n' +
        '  export PATH="/Library/TeX/texbin:$PATH"\n' +
        '  sudo tlmgr update --self && sudo tlmgr install latexmk'
    )
    process.exit(1)
  }

  let config
  try {
    config = await resolveConfig({
      cwd: process.cwd(),
      cliArg: args.mainTex,
      cliPort: args.port,
      cliDraft: args.draft ? true : null,
    })
  } catch (err) {
    console.error(err.message)
    process.exit(1)
  }

  if (args.once) {
    process.stdout.write(`编译 ${config.mainTexRelative} ... `)
    const result = await runCompile({ config, kind: 'full' })
    console.log(`${result.ok ? '成功' : '失败'}（${(result.durationMs / 1000).toFixed(1)}s）`)
    console.log(formatDiagnostics(result.diagnostics))
    if (result.pdfPath) console.log(`PDF：${result.pdfPath}`)
    process.exit(result.ok ? 0 : 1)
  }

  console.error('watch 模式尚未实现，先用 --once')
  process.exit(1)
}

main()
