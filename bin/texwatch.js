#!/usr/bin/env node
import fs from 'node:fs/promises'
import { realpathSync } from 'node:fs'
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

// --- 错误边界说明（复审修复轮：Critical 修复 1）---
// 这个 handler 是通过 `queue.on('result', handler)` 挂上去的：src/queue.js
// 里 `this.emit('result', { kind, result })` 是同步 emit（EventEmitter 的
// emit 从不等待监听器返回的 promise，本任务也不允许改 queue.js 的接口）。
// handler 本身是 async 函数，返回的 promise 没有任何人接、也没有人 .catch。
// 一旦它在第一个 await 之后才 reject——比如下面的 publishPdf 在源 PDF 被
// 另一个终端的 `texwatch --clean` 或 `latexmk -C` 删掉之后 reject（
// test/server-http.test.js 里「publishPdf: 源文件不存在时 reject」已经
// 证明这条路径真的会 reject）——这就是一个没人处理的 unhandledRejection，
// Node 的默认行为是直接杀掉整个进程。对一个承诺「你只管写、我一直看着」的
// 常驻工具，静默退出是最坏的失效形态。
//
// 这里整体包一层 try/catch：出错就用 console.error 报出来（不静默吞掉），
// 然后让进程继续跑、等下一次文件变化再触发编译——风格照 src/queue.js 里
// 「无监听器时 console.error 兜底」的先例。
export function createResultHandler({ srv, publishPdf, onLog }) {
  return async ({ result }) => {
    try {
      if (result.ok && result.pdfPath) await publishPdf(result.jobConfig, result.pdfPath)
      srv.setState({
        state: result.ok ? 'ok' : 'error',
        durationMs: result.durationMs,
        diagnostics: result.diagnostics,
        pdfStale: !result.ok,
      })
      onLog?.(result)
    } catch (err) {
      console.error('[texwatch] 处理编译结果失败（PDF 可能已被外部删除）：', err.message)
    }
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
  // 兜底防线（复审修复轮：Critical 修复 1）——加在 main() 内部而不是模块
  // 顶层，是因为 test/cli-draft-race.test.js 只是把这个文件当模块 import
  // 取 createCompileRunner/createResultHandler，并不会跑 main()；放在
  // main() 里能保证只有真实 CLI 运行（isDirectRun）时才会注册这个全局
  // 监听器，不会污染测试进程的事件监听、也不会掩盖测试里期望暴露的异常。
  //
  // 上面两处 try/catch 已经堵住了当前已知的两条会崩进程的路径，这道兜底是
  // 防御未来新增的异步路径（新的 srv.onClientMessage 分支、新的 queue 事件
  // 监听器等）重蹈覆辙——即使漏加了 try/catch，也不会让整个常驻 watch 进程
  // 静默退出，而是打印出来、继续跑。同样不静默吞掉：console.error 报出来。
  process.on('unhandledRejection', (err) => {
    console.error('[texwatch] 未捕获的异步错误（进程不会退出，但请检查上面的报错）：', err)
  })

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

  // --- 错误边界说明（复审修复轮：Critical 修复 1）---
  // resolveConfig 用抛异常表达失败（比如主文件编辑到一半、暂时没有
  // \begin{document}）。这个 handler 是从 src/server.js 里
  // `for (const h of clientHandlers) h(parsed)` 即发即弃地调用的——那是个
  // 同步 for 循环，同样不会、也没法等待 async handler 返回的 promise。
  // 已实测复现：编辑主文件到「\begin{document} 暂时不在」的中间状态时，
  // 点一下预览页的 draft 勾选框，await resolveConfig(...) 抛出，整个
  // texwatch 进程直接崩溃退出，watch 会话没了。
  // 包一层 try/catch：报错但不崩，且不改 `current`（try 块里 `current =`
  // 这一行没跑到，`current` 自然保持切换前的值，不会产生半途而废的状态）。
  srv.onClientMessage(async (msg) => {
    if (msg.type !== 'setDraft') return
    if (Boolean(msg.value) === current.draft) return

    try {
      current = await resolveConfig({
        cwd: process.cwd(),
        cliArg: current.mainTexRelative,
        cliPort: current.port,
        cliDraft: Boolean(msg.value),
      })
      srv.setState({ draft: current.draft, pdfStale: true })
      queue.push('full')
    } catch (err) {
      console.error('[texwatch] 切换 draft 模式失败（主文件可能正在编辑中）：', err.message)
    }
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
// 两侧都取 realpath 再比较：Node 加载模块时会解析符号链接（import.meta.url
// 得到真实路径），而 path.resolve 不会（argv[1] 保持调用时的链接路径）。
// npm link / npm i -g 正是用符号链接暴露命令的，只比较两者会让 main() 永不
// 执行，表现为「敲 texwatch 什么都不发生、静默退出 0」。
function realpathOrSelf(p) {
  try {
    return realpathSync(path.resolve(p))
  } catch {
    return path.resolve(p)
  }
}
const isDirectRun =
  process.argv[1] &&
  realpathOrSelf(fileURLToPath(import.meta.url)) === realpathOrSelf(process.argv[1])
if (isDirectRun) {
  main()
}
