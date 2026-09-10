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
      case '--port': out.port = Number(argv[++i]); break
      default:
        if (a.startsWith('-')) throw new Error(`未知参数：${a}`)
        out.mainTex = a
    }
  }
  return out
}

export function formatDiagnostics(diags) {
  if (diags.length === 0) return '没有错误和警告'

  return diags
    .map((d) => {
      const tag = d.severity === 'error' ? '错误' : '警告'
      const loc = d.file ? `${d.file}${d.line ? `:${d.line}` : ''}` : ''
      const head = loc ? `[${tag}] ${loc}  ${d.message}` : `[${tag}] ${d.message}`
      return d.hint ? `${head}\n       → ${d.hint}` : head
    })
    .join('\n')
}
