import path from 'node:path'

// -file-line-error 的错误行形态： ./main.tex:123: 消息
const FILE_LINE_ERROR = /^(\S+?):(\d+):\s*(.*)$/
// 没有文件信息的裸错误行
const BARE_ERROR = /^!\s*(.*)$/
const MISSING_FILE = /File\s+[`'"]([^'"`]+)['"`]\s+not found/
const GRAPHIC_EXTS = new Set(['.png', '.jpg', '.jpeg', '.pdf', '.eps', '.ps'])
// LaTeX/宏包/文档类警告： LaTeX Warning: ... / Package foo Warning: ... / Class foo Warning: ...
const WARNING = /^(?:(LaTeX|Package\s+\S+|Class\s+\S+)\s+Warning:\s*)(.*)$/
const ON_INPUT_LINE = /on input line (\d+)/
// Overfull/Underfull box 行。真实 pdflatex 日志里有两种落款：
//   "... detected at line 3"（单行盒子，无 "s"、无范围）
//   "... in paragraph at lines 10--12"（跨行时才是 "lines X--Y"）
// 括号内是宽度信息，如 "249.00076pt too wide"。
const OVERFULL = /^(Overfull|Underfull)\s+\\[hv]box\s*\((.*?)\)(?:.*?\bat lines?\s+(\d+)(?:--(\d+))?)?/

function toRelative(file, root) {
  if (!file) return null
  const cleaned = file.replace(/^\.\//, '')
  if (path.isAbsolute(cleaned)) {
    const rel = path.relative(root, cleaned)
    return rel.startsWith('..') ? cleaned : rel
  }
  return cleaned
}

function hintFor(message) {
  const m = message.match(MISSING_FILE)
  if (!m) return null
  const missing = m[1]
  const ext = path.extname(missing).toLowerCase()

  if (GRAPHIC_EXTS.has(ext)) {
    return `找不到图片 ${missing}：确认文件存在且路径相对主文件正确`
  }
  if (ext === '.sty' || ext === '.cls' || ext === '') {
    const base = path.basename(missing, ext)
    return `sudo tlmgr install ${base}\n（若提示找不到该包，用 tlmgr search --global --file "/${base}${ext || '.sty'}" 查真实包名）`
  }
  return `找不到文件 ${missing}`
}

function warningHint(message) {
  if (/Citation .* undefined/.test(message)) {
    return '引用没解析出来：改动 .bib 或新增引用后需要跑一轮 bibtex（保存 .bib 文件会自动触发）'
  }
  if (/Reference .* undefined/.test(message)) {
    return '交叉引用没解析出来：通常再编译一轮就会补上'
  }
  if (/There were undefined (references|citations)/.test(message)) {
    return '还有未解析的引用，需要再编译一轮'
  }
  return null
}

export function parseLog(rawLog, root) {
  const diagnostics = []
  const lines = rawLog.split('\n')

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    const fle = line.match(FILE_LINE_ERROR)
    if (fle && !line.startsWith('!')) {
      // 形如 ./main.tex:3: Undefined control sequence.
      const message = fle[3].trim()
      if (message) {
        diagnostics.push({
          severity: 'error',
          file: toRelative(fle[1], root),
          line: Number(fle[2]),
          message,
          hint: hintFor(message),
          raw: lines.slice(i, i + 3).join('\n'),
        })
        continue
      }
    }

    const bare = line.match(BARE_ERROR)
    if (bare && bare[1].trim()) {
      const message = bare[1].trim()
      diagnostics.push({
        severity: 'error',
        file: null,
        line: null,
        message,
        hint: hintFor(message),
        raw: lines.slice(i, i + 3).join('\n'),
      })
    }

    const warn = line.match(WARNING)
    if (warn) {
      const message = `${warn[1]}: ${warn[2].trim()}`
      const lm = line.match(ON_INPUT_LINE)
      diagnostics.push({
        severity: 'warning',
        file: null,
        line: lm ? Number(lm[1]) : null,
        message,
        hint: warningHint(message),
        raw: lines.slice(i, i + 2).join('\n'),
      })
      continue
    }

    const over = line.match(OVERFULL)
    if (over) {
      diagnostics.push({
        severity: 'warning',
        file: null,
        line: over[3] ? Number(over[3]) : null,
        message: `${over[1]} box (${over[2]})`,
        hint: null,
        raw: line,
      })
    }
  }

  const order = { error: 0, warning: 1 }
  return dedupe(diagnostics).sort((a, b) => order[a.severity] - order[b.severity])
}

function dedupe(diags) {
  const seen = new Set()
  return diags.filter((d) => {
    const key = `${d.severity}|${d.file}|${d.line}|${d.message}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
