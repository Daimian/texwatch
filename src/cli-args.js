export function parseArgv(argv) {
  const out = {
    mainTex: null, port: null, draft: false,
    once: false, clean: false, open: true, help: false,
  }

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    switch (a) {
      case '--draft': out.draft = true; break
      case '--once': out.once = true; break
      case '--clean': out.clean = true; break
      case '--no-open': out.open = false; break
      case '-h':
      case '--help': out.help = true; break
      case '--port': {
        const val = argv[++i]
        // 必须存在、是正整数、且不能以 '-' 开头（否则会把下一个开关，比如
        // --draft，当成端口值吞掉，导致该开关静默失效）。
        if (val === undefined || val.startsWith('-') || !/^[1-9]\d*$/.test(val)) {
          throw new Error(
            `--port 需要一个正整数，收到的是${val === undefined ? '（缺失）' : ` ${JSON.stringify(val)}`}`
          )
        }
        out.port = Number(val)
        break
      }
      default:
        if (a.startsWith('-')) throw new Error(`未知参数：${a}`)
        if (out.mainTex !== null) {
          throw new Error(`只能指定一个主文件，收到多个位置参数：${out.mainTex} 和 ${a}`)
        }
        out.mainTex = a
    }
  }
  return out
}

const HINT_ARROW_PREFIX = '       → '
const HINT_CONT_PREFIX = ' '.repeat(HINT_ARROW_PREFIX.length)

export function formatDiagnostics(diags) {
  if (diags.length === 0) return '没有错误和警告'

  return diags
    .map((d) => {
      const tag = d.severity === 'error' ? '错误' : '警告'
      const loc = d.file ? `${d.file}${d.line ? `:${d.line}` : ''}` : ''
      const head = loc ? `[${tag}] ${loc}  ${d.message}` : `[${tag}] ${d.message}`
      if (!d.hint) return head
      // 多行 hint（比如缺包时的 tlmgr 安装建议）每一行都要保持与第一行对齐的
      // 缩进，否则续行会顶格输出、跟下一条诊断混在一起。
      const hintLines = d.hint
        .split('\n')
        .map((line, idx) => `${idx === 0 ? HINT_ARROW_PREFIX : HINT_CONT_PREFIX}${line}`)
        .join('\n')
      return `${head}\n${hintLines}`
    })
    .join('\n')
}
