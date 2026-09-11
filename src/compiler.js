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

function spawnCapture({ cmd, args, cwd, timeoutMs, config }) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd,
      env: {
        ...process.env,
        ...COMPILE_ENV,
        // fmt 文件被 dump 到 config.fmtDir，pdflatex 默认不会去那里找，
        // 需要显式加进 TEXFORMATS 搜索路径。末尾的冒号表示「然后再搜索默认路径」，
        // 不能省——省掉的话默认的 pdflatex.fmt 就找不到了，非 fmt 编译会全部失败。
        ...(config?.fmtDir ? { TEXFORMATS: `${config.fmtDir}:` } : {}),
      },
    })

    let output = ''
    let timedOut = false
    child.stdout.on('data', (b) => { output += b })
    child.stderr.on('data', (b) => { output += b })

    let killTimer = null
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      // 存下句柄，进程若在 SIGKILL 触发前已经退出（close/error 已 resolve），要能 clearTimeout，
      // 避免 5 秒后仍对着一个早已不存在的 pid 调 kill（虽然 Node 会静默返回 false、无实际危害，
      // 但存句柄成本为零，能让这条定时器的生命周期完整可控）。
      killTimer = setTimeout(() => child.kill('SIGKILL'), 5000)
      killTimer.unref()
    }, timeoutMs)

    child.on('error', (err) => {
      clearTimeout(timer)
      if (killTimer) clearTimeout(killTimer)
      resolve({ output: `${output}\n${err.message}`, code: -1, timedOut })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (killTimer) clearTimeout(killTimer)
      resolve({ output, code, timedOut })
    })
  })
}

async function statPdf(pdfPath) {
  try {
    const st = await fs.stat(pdfPath)
    return { exists: st.size > 0, mtimeMs: st.mtimeMs }
  } catch {
    return { exists: false, mtimeMs: null }
  }
}

/**
 * CompileResult = {
 *   ok,          // 这一轮有没有真的产出可用 PDF：
 *                //   !timedOut && pdfExists && (pdfChanged || exitCode === 0)
 *                // 不看退出码本身——非零退出码 + 可用 PDF 是 LaTeX 的常态，例如 authoryear
 *                // 文档类配 elsarticle-num 样式时 natbib 报错但自恢复，PDF 依然正确。若单用
 *                // exitCode === 0 判定成功，这类论文会被永远判为失败。
 *                // 但只看「PDF 存在」也不够：outDir 是增量编译复用的，本轮致命报错（比如
 *                // Emergency stop）时 latexmk 会原样留着上一轮的旧 PDF 不动，此时必须能
 *                // 分辨出「这是旧图」而不是本轮产物，否则用户会把旧图误当成改动已生效。
 *                // pdfChanged = 编译前 PDF 不存在，或编译前后 mtime 不同。
 *                // 光看 pdfChanged 也不够：latexmk 判定无需重编时会原样保留 PDF 不重写
 *                // （常见于没有 -g 强制全量的普通改动），此时 pdfChanged 为 false 但这是
 *                // 完全正常的成功，靠 exitCode === 0 兜住这种情况。
 *   pdfPath,     // outDir 里当前存在的 PDF 路径，没有则为 null（与 ok 无关——ok 为 false
 *                // 时如果 outDir 里还留着旧 PDF，这里仍会指向那个旧文件，由调用方结合 ok
 *                // 自行决定要不要展示/更新 lastGoodPdf）
 *   durationMs,
 *   diagnostics, // parseLog 解析出的诊断列表，与 ok 无关——有 error 诊断不代表 ok 为 false
 *   rawLog,
 *   timedOut,
 *   exitCode,    // latexmk/pdflatex 的退出码，仅在判定「PDF 未变但确实无需重编」时参与 ok，
 *                // 不代表「退出码非零就是失败」
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

  const pdfPath = path.join(
    config.outDir,
    `${path.basename(config.mainTex, '.tex')}.pdf`
  )
  const before = await statPdf(pdfPath)

  const { cmd, args } = commandOverride ?? {
    cmd: 'latexmk',
    args: buildLatexmkArgs({ config, kind, fmtName }),
  }

  const { output, code, timedOut } = await spawnCapture({
    cmd,
    args,
    cwd: config.root,
    timeoutMs,
    config,
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

  const after = await statPdf(pdfPath)
  const pdfChanged = !before.exists || after.mtimeMs !== before.mtimeMs

  // ok 既不看「退出码是否为 0」，也不能只看「PDF 是否存在」——必须能区分本轮真产出的 PDF
  // 和 outDir 里遗留的旧 PDF。pdfChanged 分辨新旧；无需重编（PDF 未变但 exitCode === 0）
  // 时靠 exitCode 兜底，因为那也是合法的成功。
  const ok = !timedOut && after.exists && (pdfChanged || code === 0)

  return {
    ok,
    pdfPath: after.exists ? pdfPath : null,
    durationMs: Date.now() - started,
    diagnostics,
    rawLog,
    timedOut,
    exitCode: code,
  }
}
