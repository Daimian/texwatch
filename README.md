# texwatch

本地 LaTeX 编译预览流水线。保存 `.tex` 即增量编译，浏览器预览自动刷新并保持滚动位置，报错解析成人话。

不是编辑器 —— 你继续用自己顺手的编辑器写 `.tex`。

## 安装

需要 Node >= 20 和一套 TeX 环境。仅支持 macOS。

```bash
# 1. TeX 环境
brew install --cask basictex
export PATH="/Library/TeX/texbin:$PATH"   # 建议写进 ~/.zshrc
sudo tlmgr update --self
sudo tlmgr install latexmk algorithms algorithmicx mylatexformat

# 2. texwatch
git clone <this repo> && cd texwatch
npm install
npm link
```

`tlmgr install` 那行装的是本项目在一篇真实论文（elsarticle 模板、natbib、多张图、106 条参考
文献）上实测需要的包。其中 `latexmk` 是编译驱动，`algorithms`/`algorithmicx` 是这篇论文用到的
宏包，`mylatexformat` 用来支持 preamble 预编译。遇到别的论文缺别的宏包时，texwatch 会在预览页
和终端里直接告诉你该装什么（解析自 pdflatex 的 `File 'xxx.sty' not found` 报错）。

## 用法

```bash
cd 你的论文目录
texwatch main.tex
```

浏览器会自动打开预览页。之后每次保存 `.tex` 都会自动重新编译并刷新，编译出错时预览区保留
上一次成功的 PDF，不会变白/消失。

```
texwatch [主文件.tex] [选项]

  --port <n>   预览服务端口，默认 3577，被占用则自动 +1
  --draft      draft 模式，图片只画空框，编译更快
  --no-open    不自动打开浏览器
  --once       只编译一次，打印诊断后退出
  --clean      清空 .texwatch/ 后退出
  -h, --help   显示帮助
```

不指定主文件时，texwatch 会扫描当前目录下同时含 `\documentclass` 和
`\begin{document}` 的 `.tex`。只有一个就直接用；有多个会列出候选让你指定，需要显式传参。

## 配置

可选的 `.texwatchrc.json`（放在项目根目录）：

```json
{
  "main": "main.tex",
  "port": 3577,
  "draft": false,
  "watch": [".tex", ".bib", ".cls", ".bst", ".sty", ".png", ".jpg", ".jpeg", ".pdf", ".eps"],
  "ignore": [".texwatch", ".git", "node_modules"]
}
```

各字段都可省略，省略的用上面这份默认值。注意：

- `watch` 是**扩展名数组**，不是 glob —— 列出的扩展名的文件改动都会触发重编译。
- `ignore` 是**要跳过的目录名数组**，同样不是 glob —— 匹配这些名字的目录（不论在哪一层）整体不监听。

（这是与最初设计文档的一处已知偏差：`chokidar` v4 起移除了 glob 支持，所以改成了更简单的
扩展名 / 目录名数组，功能上覆盖了绝大多数论文项目的需求。）

## 它是怎么变快的

1. **预编译 preamble** —— 用 `mylatexformat` 把 preamble dump 成 `.fmt`，
   省掉每次重新加载宏包的开销。preamble 变了会自动重新 dump；
   dump 失败会静默降级成标准编译，不会挡住你。
2. **draft 开关** —— 图片只画空框（尺寸保留，所以分页基本不变），
   跳过大图的解码与嵌入。
3. **bibtex 按需跑** —— 只在 `.bib` 改动时强制跑，平时交给 latexmk 判断是否需要。

### 实测性能，如实说明

在一篇真实论文（elsarticle 模板、8 张 PNG 图，最大 1.6MB、106 条参考文献）上，用真实
`texwatch` 服务（含 HTTP/WS/watcher/debounce 全链路）测的单次"改一个字保存"耗时：

| 场景 | 中位数耗时 | 是否达标（验收线） |
|---|---|---|
| 基准（无 fmt、无 draft） | **3.34s** | 未达标（≤2s） |
| 有 fmt（无 draft） | **3.20s** | 未达标（≤2s） |
| draft | **0.51s** | 达标（≤1s） |

**诚实的结论**：fmt 预编译在这篇论文上只省了约 **4%**（3.34s → 3.20s），远达不到"预编译通常
砍掉 30-50%"这类未经验证的说法。原因是这篇论文单轮编译的耗时主要由**图片嵌入**主导，而不是
**宏包加载/解析**——fmt 只优化后者。用两次首轮全量收敛的耗时做交叉印证：非 draft 首轮收敛
10.05s，draft 首轮收敛仅 1.48s，差距的主要来源正是 draft 模式下 `graphicx` 跳过了大图解码。

也就是说，**draft 才是真正把耗时压到预算内的杠杆**，不是 fmt。图片越多越大的论文，draft 的
收益越明显；图片少、宏包多的论文，fmt 可能反而更有用——但没有在这类论文上实测过，不做未验证
的断言。

非 draft 场景下的增量编译（3.2–3.3s）**没有达到** ≤2s 的验收目标，见「已知限制」。

## 产物

所有中间文件都在项目下的 `.texwatch/`（`build/`、`build-draft/`、`fmt/`、`last-good.pdf`、
`last-good-draft.pdf`），已经写进 `.gitignore`，不需要你再手动加。
`texwatch --clean` 可以清空它，重新从干净状态开始编译。

## 已知限制

- **非 draft 场景下的增量编译没有达到 ≤2s 的验收目标**（实测 3.2–3.3s，见上「实测性能」），
  图片多的论文尤其明显。draft 模式能稳定压到 1s 以内，图多的论文建议默认开 draft，定稿前再
  关掉 draft 出一版正式预览确认排版。
- 仅支持 macOS（依赖 `open` 命令打开浏览器、`/Library/TeX/texbin` 这一 BasicTeX 的标准路径）。
- 不做 SyncTeX 正向/反向定位（点 PDF 跳编辑器行、点编辑器行跳 PDF 位置）。
- 不做协作编辑、版本管理（用 git）。
- 一次只监听一个项目/主文件，不支持同时起多个 texwatch 实例监听同一端口，也不支持在一个
  实例里切换主文件（换项目请另起一个 `texwatch`，用 `--port` 区分）。
- 编译失败的诊断行号依赖 pdflatex 的 `-file-line-error` 输出：绝大多数错误（未定义命令、
  缺文件、语法错误）都能给出准确的 `main.tex:<行号>`；极少数"一路吞到文件末尾才报错"的错误
  形态（比如没闭合的花括号导致 runaway argument）pdflatex 自身就不会给出行号，这是 TeX 的
  固有行为，不是 texwatch 能修复的。这类情况下 `/pdf` 仍会正确保留上一次成功编译的内容。
