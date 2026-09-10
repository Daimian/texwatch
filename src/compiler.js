import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { parseLog } from './log-parser.js'

export const COMPILE_ENV = {
  max_print_line: '10000',
  error_line: '254',
  half_error_line: '238',
}

const DRAFT_PRETEX = '\\PassOptionsToPackage{draft}{graphicx}'

export function buildLatexmkArgs({ config, kind, fmtName }) {
  const args = [
    '-f',
    '-pdf',
    '-interaction=nonstopmode',
    '-file-line-error',
    `-outdir=${config.outDir}`,
  ]

  if (kind === 'bib') {
    args.push('-bibtex', '-g')
  } else {
    args.push('-bibtex-cond')
    if (kind === 'preamble' || kind === 'full') args.push('-g')
  }

  if (config.draft) {
    // draft 与 fmt 是重叠的加速手段，同时用会让 latexmk 的调用方式变复杂，
    // 所以 draft 模式直接跳过 fmt（见计划开头「与 spec 的两处偏差」）
    args.push(`-usepretex=${DRAFT_PRETEX}`)
  } else if (fmtName) {
    // %S 必须用「反斜杠转义的引号」\"%S\"，而不是普通引号 "%S"：
    // latexmk 解析 -pdflatex= 模板时会像 shell 一样按引号分词、并把未转义的引号当分词符剥掉，
    // 所以普通 "%S" 传到 pdflatex 的 argv 里时引号已经被剥光，退化成跟不加引号完全一样的效果——
    // 而 pdflatex/TeX 在 "&fmt file" 这种调用形式下会把各 argv 重新按空格拼接再解析一遍，
    // 没有真正的引号字符存活下来，路径里的空格就会被从中拆开（Emergency stop，不产出 PDF）。
    // 只有 \"%S\" 里的反斜杠转义引号能让 latexmk 把它当「转义出的字面双引号字符」而不是分词符，
    // 从而让字面双引号字符真正出现在 pdflatex 收到的那个 argv 里，TeX 自己的解析器才能识别出
    // 这是一个带空格的完整文件名。已用含空格的临时目录 + 真实 fmt 实跑验证，见 task-6-report.md。
    args.push(`-pdflatex=pdflatex %O "&${fmtName}" \\"%S\\"`)
  }

  args.push(config.mainTex)
  return args
}

export const DEFAULT_TIMEOUT_MS = 120_000

export async function hasTexToolchain() {
  return new Promise((resolve) => {
    const p = spawn('latexmk', ['-v'], { stdio: 'ignore' })
    p.on('error', () => resolve(false))
    p.on('close', (code) => resolve(code === 0))
  })
}

function spawnCapture({ cmd, args, cwd, timeoutMs }) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd,
      env: { ...process.env, ...COMPILE_ENV },
    })

    let output = ''
    let timedOut = false
    child.stdout.on('data', (b) => { output += b })
    child.stderr.on('data', (b) => { output += b })

    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), 5000).unref()
    }, timeoutMs)

    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({ output: `${output}\n${err.message}`, code: -1, timedOut })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ output, code, timedOut })
    })
  })
}

/**
 * CompileResult = {
 *   ok,          // 这一轮有没有产出 PDF（不看退出码——非零退出码 + 可用 PDF 是 LaTeX 的常态，
 *                // 例如 authoryear 文档类配 elsarticle-num 样式时 natbib 报错但自恢复，
 *                // PDF 依然正确。若用 exitCode === 0 判定成功，这类论文会被永远判为失败。）
 *   pdfPath,     // 产出的 PDF 路径，没有则为 null
 *   durationMs,
 *   diagnostics, // parseLog 解析出的诊断列表，与 ok 无关——有 error 诊断不代表 ok 为 false
 *   rawLog,
 *   timedOut,
 *   exitCode,    // latexmk/pdflatex 的退出码，仅供参考展示，不参与 ok 的判定
 * }
 */
export async function runCompile({
  config,
  kind,
  fmtName = null,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  commandOverride = null,
}) {
  const started = Date.now()
  await fs.mkdir(config.outDir, { recursive: true })

  const { cmd, args } = commandOverride ?? {
    cmd: 'latexmk',
    args: buildLatexmkArgs({ config, kind, fmtName }),
  }

  const { output, code, timedOut } = await spawnCapture({
    cmd,
    args,
    cwd: config.root,
    timeoutMs,
  })

  // latexmk 的 stdout 不含完整信息，真正的日志在 outDir 里的 .log。
  // 日志文件可能含非 UTF-8 字节（M0 实测 main.log 有过），用 latin1 解码保证
  // 每个字节都能原样读出、不会因为解码失败而静默丢内容。
  const logPath = path.join(
    config.outDir,
    `${path.basename(config.mainTex, '.tex')}.log`
  )
  let rawLog = output
  try {
    rawLog = await fs.readFile(logPath, 'latin1')
  } catch {
    // 日志文件还没生成（比如 latexmk 根本没跑起来），退回用 stdout
  }

  const diagnostics = timedOut
    ? [{ severity: 'error', file: null, line: null, message: `编译超时（超过 ${timeoutMs / 1000} 秒）已被终止`, hint: '可以先跑 texwatch --clean 清掉可能损坏的中间文件', raw: '' }]
    : parseLog(rawLog, config.root)

  const pdfPath = path.join(
    config.outDir,
    `${path.basename(config.mainTex, '.tex')}.pdf`
  )
  let pdfExists = false
  try {
    pdfExists = (await fs.stat(pdfPath)).size > 0
  } catch {
    pdfExists = false
  }

  // ok 只看「有没有产出可用 PDF」，不看退出码：非零退出码 + 正确 PDF 是常态。
  const ok = !timedOut && pdfExists

  return {
    ok,
    pdfPath: pdfExists ? pdfPath : null,
    durationMs: Date.now() - started,
    diagnostics,
    rawLog,
    timedOut,
    exitCode: code,
  }
}
