#!/usr/bin/env node
import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { parseArgv, formatDiagnostics } from '../src/cli-args.js'
import { resolveConfig } from '../src/config.js'
import { runCompile, hasTexToolchain } from '../src/compiler.js'
import { createWatcher } from '../src/watcher.js'
import { SingleSlotQueue } from '../src/queue.js'
import { createServer, publishPdf } from '../src/server.js'
import { ensureFormat } from '../src/format-cache.js'

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

  let current = config

  const srv = await createServer({ config: current, getConfig: () => current })

  const queue = new SingleSlotQueue(async (kind) => {
    const fmtName = await ensureFormat(current)
    const result = await runCompile({ config: current, kind, fmtName })
    return result
  })

  queue.on('state', ({ state, kind }) => {
    srv.setState({ state, kind })
    if (state === 'compiling') process.stdout.write(`\n编译中（${kind}）... `)
    if (state === 'queued') process.stdout.write('[有新改动，排队中] ')
  })

  queue.on('result', async ({ result }) => {
    if (result.ok && result.pdfPath) await publishPdf(current, result.pdfPath)
    srv.setState({
      state: result.ok ? 'ok' : 'error',
      durationMs: result.durationMs,
      diagnostics: result.diagnostics,
      pdfStale: !result.ok,
    })
    console.log(`${result.ok ? '成功' : '失败'}（${(result.durationMs / 1000).toFixed(1)}s）`)
    const shown = result.diagnostics.filter((d) => d.severity === 'error')
    const warnCount = result.diagnostics.length - shown.length
    if (shown.length) console.log(formatDiagnostics(shown))
    if (warnCount) console.log(`（另有 ${warnCount} 条警告）`)
  })

  queue.on('error', (err) => console.error('编译出错：', err.message))

  srv.onClientMessage(async (msg) => {
    if (msg.type !== 'setDraft') return
    if (Boolean(msg.value) === current.draft) return

    current = await resolveConfig({
      cwd: process.cwd(),
      cliArg: current.mainTexRelative,
      cliPort: current.port,
      cliDraft: Boolean(msg.value),
    })
    srv.setState({ draft: current.draft, pdfStale: true })
    queue.push('full')
  })

  const watcher = createWatcher({ config: current })
  watcher.on('change', (kind) => queue.push(kind))

  console.log(`正在监听 ${current.root}`)
  console.log(`主文件：${current.mainTexRelative}${current.draft ? '（draft 模式）' : ''}`)
  console.log(`预览地址：${srv.url}`)
  if (args.open) {
    spawn('open', [srv.url], { stdio: 'ignore', detached: true }).unref()
  }
  queue.push('full')

  process.on('SIGINT', async () => {
    await watcher.close()
    await srv.close()
    process.exit(0)
  })
}

main()
