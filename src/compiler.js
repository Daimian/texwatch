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
    args.push(`-pdflatex=pdflatex %O "&${fmtName}" %S`)
  }

  args.push(config.mainTex)
  return args
}
