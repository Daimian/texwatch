# texwatch

English | [中文](README.zh.md)

A local LaTeX build-and-preview loop. Save a `.tex` file and texwatch recompiles it incrementally;
the preview in your browser refreshes and keeps its scroll position, and compile errors are
reported with the file and line they come from.

It is not an editor: keep writing in the editor you already use.

> The command-line messages and the preview page are currently in Chinese.

## Installation

Requires Node ≥ 20 and a TeX distribution. macOS only.

```bash
# 1. TeX
brew install --cask basictex
export PATH="/Library/TeX/texbin:$PATH"   # add this to ~/.zshrc
sudo tlmgr update --self
sudo tlmgr install latexmk algorithms algorithmicx mylatexformat

# 2. texwatch
git clone https://github.com/Daimian/texwatch.git && cd texwatch
npm install
npm link
```

The `tlmgr install` line lists the packages needed for a real paper texwatch was tested on
(elsarticle, natbib, several figures, 106 references): `latexmk` drives the build, `algorithms` /
`algorithmicx` were used by that paper, and `mylatexformat` enables preamble precompilation. When a
paper needs another package, texwatch tells you which one, both in the preview page and in the
terminal (parsed from pdflatex's `File 'xxx.sty' not found`).

## Usage

```bash
cd your-paper
texwatch main.tex
```

The preview page opens in your browser. Every save recompiles and refreshes it. When a build fails,
the preview keeps the last successful PDF instead of going blank.

```
texwatch [main.tex] [options]

  --port <n>   preview server port, default 3577; the next free port is used if it is taken
  --draft      draft mode: images are drawn as empty boxes, which builds much faster
  --no-open    do not open the browser
  --once       build once, print diagnostics and exit
  --clean      delete .texwatch/ and exit
  -h, --help   show help
```

Without a main file, texwatch looks in the current directory for a `.tex` file that contains both
`\documentclass` and `\begin{document}`. If there is exactly one, it is used; if there are several,
texwatch lists them and asks you to choose.

## Configuration

An optional `.texwatchrc.json` in the project root:

```json
{
  "main": "main.tex",
  "port": 3577,
  "draft": false,
  "watch": [".tex", ".bib", ".cls", ".bst", ".sty", ".png", ".jpg", ".jpeg", ".pdf", ".eps"],
  "ignore": [".texwatch", ".git", "node_modules"]
}
```

Every field is optional; the values above are the defaults.

- `watch` is a list of **file extensions**, not globs: a change to any file with one of these
  extensions triggers a rebuild.
- `ignore` is a list of **directory names**, not globs: directories with these names, at any depth,
  are not watched.

## How it is fast

1. **Precompiled preamble**: `mylatexformat` dumps the preamble into a `.fmt` file, so packages are
   not reloaded on every build. The format is rebuilt when the preamble changes; if dumping fails,
   texwatch silently falls back to a standard build.
2. **Draft switch**: images are drawn as empty boxes of the right size, so pagination stays
   essentially the same while large images are not decoded and embedded.
3. **BibTeX on demand**: BibTeX is forced only when a `.bib` file changes; otherwise latexmk decides.

### Measured performance

Time for a single "change one character and save" on a real paper (elsarticle, 8 PNG figures up to
1.6 MB, 106 references), measured through the full texwatch service (HTTP, WebSocket, watcher,
debounce):

| Scenario | Median time | Target |
|---|---|---|
| Baseline (no fmt, no draft) | **3.34 s** | missed (≤ 2 s) |
| With fmt (no draft) | **3.20 s** | missed (≤ 2 s) |
| Draft | **0.51 s** | met (≤ 1 s) |

On this paper the precompiled preamble saved only about **4%** (3.34 s → 3.20 s). A build here is
dominated by embedding images, not by loading packages, and the format file only speeds up the
latter. The first full builds confirm it: 10.05 s without draft, 1.48 s with draft.

So **draft mode is what brings the build time within budget**. The more and larger the images, the
more it helps. For papers with few images and many packages the format file may matter more, but
that has not been measured.

## Build artifacts

All intermediate files live in `.texwatch/` in the project (`build/`, `build-draft/`, `fmt/`,
`last-good.pdf`, `last-good-draft.pdf`). Add `.texwatch/` to your project's `.gitignore`.
`texwatch --clean` deletes it.

## Known limitations

- **Incremental builds without draft miss the 2 s target** (3.2–3.3 s measured, see above),
  especially for image-heavy papers. Draft mode stays under 1 s; for such papers, work in draft
  mode and turn it off for a final check of the layout.
- macOS only (it uses `open` to launch the browser and BasicTeX's standard `/Library/TeX/texbin`).
- No SyncTeX forward or inverse search.
- No collaborative editing or version history (use git).
- One project and one main file per instance. To preview another project, start another texwatch
  on a different `--port`.
- Error line numbers come from pdflatex's `-file-line-error` output. Most errors (undefined
  commands, missing files, syntax errors) point to the exact `main.tex:<line>`; a few, such as a
  runaway argument from an unclosed brace, are reported by TeX only at the end of the file. This is
  TeX's behaviour and cannot be fixed by texwatch. The preview still keeps the last good PDF.

## License

[MIT](LICENSE). The bundled [pdf.js](https://github.com/mozilla/pdf.js) in `client/vendor/pdfjs/`
is licensed under Apache-2.0.
