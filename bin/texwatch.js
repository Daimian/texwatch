#!/usr/bin/env node
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { parseArgv, formatDiagnostics } from '../src/cli-args.js'
import { resolveConfig } from '../src/config.js'
import { runCompile, hasTexToolchain } from '../src/compiler.js'
import { createWatcher } from '../src/watcher.js'
import { SingleSlotQueue } from '../src/queue.js'
import { createServer, publishPdf } from '../src/server.js'
import { ensureFormat } from '../src/format-cache.js'

// --- 竞态说明（Task 17 修复轮 1） ---
// watch 模式下 `current`（当前生效的 ProjectConfig）是可变的：浏览器切换
// draft 会原地把它换成另一份 config（不同的 outDir / lastGoodPdf）。如果
// 一次编译任务的 ensureFormat / runCompile / publishPdf 各自在不同时刻分别
// 读一次 `current`，编译进行中收到 setDraft 就会出现「用配置 A 编译、结果
// 却发布到配置 B 的路径」的竞态——本该写进 last-good.pdf 的结果被错误地
// 写进了 last-good-draft.pdf（或反过来），且旧内容永久丢失。
//
// 修法：把这次任务要用的 config 在任务开始执行的那一刻同步读一次、存成
// 局部变量 `jobConfig`，这次任务后续的每一步（ensureFormat、runCompile、
// 发布 PDF）全程只认这一份快照，不再反复读可变的 `current`。
//
// createCompileRunner 里 `const jobConfig = getCurrent()` 这行必须在函数体
// 的第一个 await 之前——SingleSlotQueue#run 调用 `runner(kind)` 本身是同步
// 触发到第一个 await 为止（JS 的 async function 语义），所以这一行读到的
// 保证是「这次任务开始执行那一刻」的 current，不会被期间发生的 setDraft
// 污染。之后 ensureFormat/runCompile 用的都是这同一个 jobConfig，互不干扰。
//
// 快照随 result 一起带出去（`{...result, jobConfig}`），是因为
// SingleSlotQueue 的 'result' 事件本身只带 {kind, result}（见 src/queue.js，
// 本任务不允许改它的接口），要让下游发布逻辑用回同一份快照，只能把它塞进
// runner 的返回值里，而不能指望 'result' 事件触发时再反查 current——那正是
// 原来的 bug 所在（publishPdf(current, ...) 在编译"完成之后"才读 current，
// 这时 current 可能早被 setDraft 换掉了）。
//
// 拆成 createCompileRunner / createResultHandler 两个可注入依赖的工厂函数
// （而不是直接内联在 main() 里），是为了能在 test/cli-draft-race.test.js
// 里用可控的假 ensureFormat/runCompile/publishPdf 确定性复现这个竞态——
// 不需要真实 TeX 工具链，也不需要真实计时/sleep，把 ensureFormat/
// runCompile 的返回值做成可以手动 resolve 的 deferred promise，在「编译
// 尚未完成」的窗口里手动切换 getCurrent() 的返回值并 push 第二个任务，断言
// 第一个任务的发布目标没有被第二次切换污染。
export function createCompileRunner({ getCurrent, ensureFormat, runCompile }) {
  return async function runJob(kind) {
    const jobConfig = getCurrent()
    const fmtName = await ensureFormat(jobConfig)
    const result = await runCompile({ config: jobConfig, kind, fmtName })
    return { ...result, jobConfig }
  }
}

export function createResultHandler({ srv, publishPdf, onLog }) {
  return async ({ result }) => {
    if (result.ok && result.pdfPath) await publishPdf(result.jobConfig, result.pdfPath)
    srv.setState({
      state: result.ok ? 'ok' : 'error',
      durationMs: result.durationMs,
      diagnostics: result.diagnostics,
      pdfStale: !result.ok,
    })
    onLog?.(result)
  }
}

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

  const queue = new SingleSlotQueue(
    createCompileRunner({ getCurrent: () => current, ensureFormat, runCompile })
  )

  queue.on('state', ({ state, kind }) => {
    srv.setState({ state, kind })
    if (state === 'compiling') process.stdout.write(`\n编译中（${kind}）... `)
    if (state === 'queued') process.stdout.write('[有新改动，排队中] ')
  })

  queue.on(
    'result',
    createResultHandler({
      srv,
      publishPdf,
      onLog: (result) => {
        console.log(`${result.ok ? '成功' : '失败'}（${(result.durationMs / 1000).toFixed(1)}s）`)
        const shown = result.diagnostics.filter((d) => d.severity === 'error')
        const warnCount = result.diagnostics.length - shown.length
        if (shown.length) console.log(formatDiagnostics(shown))
        if (warnCount) console.log(`（另有 ${warnCount} 条警告）`)
      },
    })
  )

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

// 只有「直接被当作脚本执行」（`node bin/texwatch.js ...`、或经 package.json
// 的 bin 字段/shebang 调用）才跑 main()；被 test/cli-draft-race.test.js
// 当模块 import 取 createCompileRunner/createResultHandler 时不能顺带把
// main() 也跑起来（会拿测试进程的 cwd/argv 去解析真实项目、起真实服务）。
const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
if (isDirectRun) {
  main()
}
