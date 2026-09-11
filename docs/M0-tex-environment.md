# M0 TeX 环境记录

## 发行版与版本

- 发行版：BasicTeX（`brew install --cask basictex`），Homebrew cask 版本 `2026.0301`
- TeX Live 版本：2026
- pdfTeX 版本：`3.141592653-2.6-1.40.29`（`pdflatex --version`）
- kpathsea 版本：`6.4.2`
- tlmgr revision：`79639 (2026-07-10 18:45:34 +0200)`
- 安装路径：`/usr/local/texlive/2026basic`
- **PATH 需包含** `/Library/TeX/texbin`（每个新 shell 需要 `export PATH="/Library/TeX/texbin:$PATH"`，否则找不到 `pdflatex`/`latexmk`/`bibtex`/`tlmgr`）

## 额外安装的包（Step 3，已由人类伙伴用 sudo 执行完成）

```
sudo tlmgr update --self
sudo tlmgr install latexmk algorithms algorithmicx mylatexformat
```

`tlmgr list --only-installed` 确认以下均已就位：`algorithmicx`（提供 `algpseudocode.sty`）、`algorithms`（提供 `algorithm.sty`）、`latexmk`、`latexmk.universal-darwin`、`mylatexformat`、`collection-basic`。

Step 4 全量编译过程中**没有再遇到任何 `File 'xxx.sty' not found` 的报错**，因此本任务未新增任何 `tlmgr install`。

## Step 4：首次全量编译 —— 过程记录

按 brief 给出的原始命令执行：

```bash
cd ~/workplace/Latex/paper
latexmk -pdf -interaction=nonstopmode -file-line-error main.tex
```

第一次运行只做了 1 次 `pdflatex` + 1 次 `bibtex` + 1 次 `pdflatex`（共 2 次 pdflatex），`latexmk` 就因为 `pdflatex` 返回非零退出码而中止，报 "Latexmk: Errors, so I did not complete making targets"，此时 `main.pdf` 只有 33 页且日志里有 114 处 `Citation ... undefined`。

排查后确认根因如下（记录在案供后续 M4 参考）：

1. **多轮收敛是预期行为**：`main.tex` 的参考文献在文档末尾，`\cite` 在正文早于 `\bibitem` 被处理，natbib 在拿到新的 `\bibcite` 之前会在每一轮里报告 "undefined"，这是 LaTeX+BibTeX 工作流的标准现象，需要 `pdflatex → bibtex → pdflatex → pdflatex` 至少 2 次 bibtex 后的 pdflatex 才能收敛，不是环境问题。
2. **真正导致 `pdflatex` 返回非零退出码的是一个论文源码本身的问题**：`main.tex` 用 `\documentclass[preprint,12pt,authoryear]{elsarticle}`（`authoryear` 选项），但 `\bibliographystyle{elsarticle-num}`（数字引用样式）与之不匹配，natbib 在 log 里报：
   ```
   ./main.aux:194: Package natbib Error: Bibliography not compatible with author-year citations.
   (natbib)                Press <return> to continue in numerical citation style.
   ```
   在 `-interaction=nonstopmode` 下 natbib 会自动切换为数字引用样式继续编译（这正是 `elsarticle-num.bst` 想要的效果），最终参考文献正确渲染为数字编号，但这个 `Package ... Error`（不是 Warning）会让 pdfTeX 把内部 `history` 状态推到 error 级别，导致进程退出码为 1 —— **即便 PDF 内容完全正确**。这是论文源文件里 `documentclass` 选项与 `bibliographystyle` 不一致导致的自愈式错误，Overleaf 用同一套 elsarticle.cls/natbib 逻辑编译理论上会产生同样的告警，只是 Overleaf 不以进程退出码判定成功与否，所以没有暴露出来。
   - **对 M4 的提示**：texwatch 判定"编译成功"不能只看 `latexmk`/`pdflatex` 的进程退出码，必须解析 log 里是否有真正阻断输出的 Fatal error，并检查目标 PDF 是否生成、页数/引用是否稳定收敛。
3. 由于上述非零退出码，`latexmk` 默认策略是停止而不是继续重试。用 `latexmk` 自己在错误信息里建议的 `-f`（force）参数可以让它跨过这个错误继续做剩余的收敛轮次。

修复后使用的命令（Step 4 最终采用）：

```bash
latexmk -C main.tex   # 清空所有中间产物，从干净状态开始
rm -f main.bbl main.blg main.fdb_latexmk main.fls main.log main.aux main.out main.spl main.synctex.gz
latexmk -f -pdf -interaction=nonstopmode -file-line-error main.tex
```

这次从全新状态跑，`latexmk` 自动做了 4 次 `pdflatex` + 3 次 `bibtex`（第 3 轮起页数与文件字节数已经稳定在 34 页 / 4299710 字节，第 4 轮只是确认收敛），最终日志中 `Citation`/`undefined` 出现次数均为 0，`main.pdf` 成功生成。

## 全量编译耗时（基准数据，供 M4 计算加速比）

在**干净状态**（删除全部 `.aux/.bbl/.blg/.fdb_latexmk/.fls/.log/.out/.spl/main.pdf`）下，用 `/usr/bin/time -p` 实测：

```bash
latexmk -f -pdf -interaction=nonstopmode -file-line-error main.tex
```

```
real 13.67
user 13.33
sys 0.28
```

Bash `SECONDS` 计时器交叉验证：`START 2026-09-10 10:31:41` → `END 2026-09-10 10:31:55`，约 13–14 秒。

**全量编译基准：约 13.7 秒（real time），4 次 pdflatex + 3 次 bibtex 收敛。**

## Step 5：页数与参考文献验证

### 页数

用两种独立方法交叉验证：

```bash
$ pdfinfo main.pdf | grep Pages
Pages:           34
```

（`pdfinfo` 来自 Homebrew 的 poppler，不是 BasicTeX 自带；`mdls -name kMDItemNumberOfPages main.pdf` 返回 `(null)`，Spotlight 未对该文件建立索引，此方法在本机不可靠，故未采用。）

`latexmk` 自身在收敛后最后一轮的输出也报告一致的页数：`Output written on main.pdf (34 pages, 4299710 bytes).`

**本地页数：34 页。**

**与 Overleaf 对比（补充确认）：** Overleaf 上编译 `main.tex` 的页数为「34 页左右」（人类伙伴口述提供，为约数，非 `pdfinfo` 级别的精确读数）。因 Overleaf 数字本身是约数，验收判据定为：本地页数落在 33–35 页区间内即视为与 Overleaf 一致，超出该区间才需要追查差异原因。本地实测的 34 页落在该区间内。

**对比结论：本地 34 页 与 Overleaf 约 34 页一致，验收通过。**

### 参考文献渲染验证

方法：`pdftotext`（Homebrew poppler 自带，非 BasicTeX 自带）把 PDF 转文本后检查：

```bash
$ pdftotext main.pdf - | grep -c "\[?\]"
0
```

全文档零处 `[?]`（BibTeX/natbib 未解析引用时的典型占位符）。

抽查渲染出的参考文献列表（第一条）：

```
References
[1] J.-W. Yeh, S.-K. Chen, S.-J. Lin, J.-Y. Gan, T.-S. Chin, T.-T. Shun,
C.-H. Tsau, S.-Y. Chang, Nanostructured High-Entropy Alloys with
Multiple Principal Elements: Novel Alloy Design Concepts and Outcomes, Advanced Engineering Materials 6 (5) (2004) 299–303.
```

以及正文摘要、作者机构等文本均正常渲染，无乱码或缺失。

交叉验证：最终收敛后的 `main.log`（用 `latin-1` 编码读取，因为文件中含非 UTF-8 字节，直接 `grep` 在默认 locale 下会静默失败——这是本任务中踩到的一个工具坑，记录以免下次重复踩）中 `Citation`/`undefined` 关键字出现次数均为 0；`main.blg`（BibTeX 日志）显示 `You've used 106 entries`，仅 4 条无害的 `empty pages`/`empty booktitle` 字段告警，无 error。

**参考文献渲染正常：是。bibtex 链路验证通过。**

## M4 加速实测（Task 17，2026-09-11）

**测量方法**：直接调用 texwatch 库函数（`resolveConfig` / `runCompile` / `ensureFormat`），绕过 HTTP/WS/watcher/debounce 层，只测「编译」本身耗时，避免这些层引入的测量噪声。脚本对每种配置切换正文中同一处安全锚点（`which rises in a stepwise` ↔ `which Rises in a stepwise`，纯大小写切换，不影响引用/页数/图表）模拟「改一个字保存」，每次翻转都相对磁盘上的当前内容判断，保证跨进程调用也一定是真实内容变化（不会出现「写了但内容没变、latexmk 判定无需重编」的假阳性）。

**起始状态一致性保证**：

1. 完全清空 `.texwatch/`（`rm -rf`），从无任何缓存/中间产物开始。
2. 对非 draft outDir（`.texwatch/build`）先跑一次 `runCompile({kind:'full'})`（`-bibtex-cond -g`），latexmk 内部自动完成多轮 pdflatex/bibtex 收敛（本次实测收敛耗时 10.05s，用 `pdfinfo`/日志核实 34 页、0 处 `Citation...undefined`——与 M0 全量基准同一数量级，属于同一类"冷启动全量"操作，只是命令行参数与 M0 手动跑的 `latexmk -f -pdf ...` 略有不同）。
3. **基准**与**有 fmt** 两组复用同一个已收敛的 `build/` outDir（只是是否传 `fmtName` 不同），因为这是它们之间唯一该变化的变量；**基准**测量前额外确认 `.texwatch/fmt` 不存在。
4. **draft**（fmt 在 draft 模式下不生效，见下方修正说明）用独立的 `.texwatch/build-draft` outDir，同样先跑一次未计时的 `kind:'full'` 收敛（收敛耗时仅 1.48s——draft 跳过图片解码是主要原因，见下文分析），核实同样是 34 页、0 处未解析引用。
5. 每种配置内部的 3 次测量连续进行（模拟用户连续多次保存），每次都是相对当前磁盘内容的真实翻转，不复用同一份.aux——引用/参考文献信息在三次测量之间没有变化，只有正文一个字符变化，属于真正的"增量编译"场景。

**三种配置各 3 次原始耗时（秒）与中位数**：

| 配置 | run 1 | run 2 | run 3 | 中位数 |
|---|---|---|---|---|
| 基准（无 fmt、无 draft） | 3.35 | 3.34 | 3.34 | **3.34s** |
| 有 fmt（无 draft） | 3.20 | 3.20 | 3.20 | **3.20s** |
| draft（fmt 在 draft 模式下不生效） | 0.52 | 0.51 | 0.51 | **0.51s** |

**标签修正（复审发现，2026-09-11 修复轮 1）**：这一行最初标成"有 fmt + draft"是误导性的——根本不存在"draft + fmt 同时生效"这种状态。`buildLatexmkArgs` 里是 `if (config.draft) {...} else if (fmtName) {...}`，draft 分支一旦为真就无条件忽略 `fmtName`；`ensureFormat` 对 draft config 也直接短路返回 `null`（见 `src/format-cache.js`）。这是设计使然：draft 与 fmt 是两种重叠的加速手段（都是为了让单轮编译更快），没有必要叠加，所以实现上让 draft 优先、直接跳过 fmt。复审用真实实现验证过，强行给 draft config 传非 null 的 `fmtName` vs 传 `null`，耗时 512ms vs 508ms，在测量噪声范围内完全一致，进一步印证 `fmtName` 对 draft 分支确实没有任何效果。**这一行实测的实际上是"draft 单独生效"的耗时，数字本身不受影响，只是原标签描述的状态不存在。**

**验收标准核对**：

- 非 draft 增量 ≤ 2 秒：**未达标**。基准 3.34s、有 fmt 3.20s，均超出预算约 1.2–1.3 秒（超出 60%–67%）。
- draft 增量 ≤ 1 秒：**达标**。0.51s，有充分余量。

**与 M0 冷启动全量基准（13.7s）的关系**：两者衡量的不是同一件事，不能直接相除算倍数。M0 的 13.7s 是从完全干净状态、4 轮 pdflatex + 3 轮 bibtex 收敛出的**冷启动全量编译**；本次三组数字都是**在已收敛状态下只改一个字符**的**单轮增量编译**（`kind:'tex'`，`-bibtex-cond`、不带 `-g`，latexmk 判定只需跑一轮 pdflatex）。增量场景耗时远低于冷启动，这个差距主要来自 latexmk 自身的增量依赖判定（跳过不必要的多轮 bibtex/pdflatex 收敛），而不是 fmt 带来的效果——这正是上一轮报告"4 倍加速"把冷启动全量和增量搞混所产生的误判来源，本次予以更正。

**fmt 收益有限，是本次实测的重要发现**：fmt 只让耗时从 3.34s 降到 3.20s，约 4%，观察不到"数倍加速"。对比之下，draft 让耗时从 3.34s 降到 0.51s，约 6.5 倍。用 `converge-nondraft`/`converge-draft` 两次首轮收敛耗时做交叉印证：非 draft 首轮收敛 10.05s，draft 首轮收敛仅 1.48s——差距的主要来源应是 draft 模式下 `\PassOptionsToPackage{draft}{graphicx}` 跳过了正文里多张 PNG 图片（`Figure1.png` 等，单张几百 KB 到 1.6MB）的解码与嵌入，而 fmt 预编译节省的只是 preamble 阶段的宏包加载/解析时间。对这篇论文而言，**宏包加载显然不是每轮编译耗时的主要构成部分，图片处理才是**，所以 fmt 这个杠杆在本项目上收益有限，是一个诚实、有价值的结论，而不是实现有问题。

**draft 端到端验证**（通过真实 `texwatch main.tex` 服务 + WebSocket `setDraft` 消息，而非直接调库）：

```
首轮编译完成 state=ok draft=false durationMs=3225
draft=false 时 /pdf 大小: 4299723 bytes
（发送 {type:'setDraft', value:true}）
收到 pdfStale 状态，draft=true
draft 编译完成 state=ok draft=true durationMs=548
draft=true 时 /pdf 大小: 406515 bytes
体积比（draft/非draft）：0.0945
```

draft 模式下 PDF 体积降到非 draft 的 9.45%（约 10.6 倍缩小），与"图片画空框"的预期一致，端到端切换（浏览器勾选 → WebSocket 消息 → `resolveConfig` 重建 config → `queue.push('full')` 重编译 → `/pdf` 跟随 `getConfig().lastGoodPdf` 切换）验证通过。

## 已知的非阻塞性问题记录

- `main.tex` 的 `\documentclass[...,authoryear]{elsarticle}` 与 `\bibliographystyle{elsarticle-num}` 不一致，导致每次编译 `pdflatex` 都会在 log 里报一条 `Package natbib Error: Bibliography not compatible with author-year citations`，并使进程退出码非零，即使编译内容完全正确。这是论文源文件本身的问题（推测是原作者在 Overleaf 上切换引用样式时遗留），不是本机环境问题，不建议在 M0 阶段修改论文仓库（论文仓库按要求保持在 `6da8f7f` 不动）。**texwatch 后续里程碑（尤其是 M4 判定"编译是否成功"的逻辑）必须知悉此问题**：不能仅凭 `latexmk`/`pdflatex` 的进程退出码判断成败。
- `main.log` 含非 UTF-8 字节（推测来自作者姓名或参考文献里的重音字符），用系统默认 locale 跑 `grep` 会在无任何报错提示的情况下返回空结果，容易造成误判"没有匹配"。用 `LC_ALL=C` 或 Python 以 `latin-1` 打开可靠读取。
- 直接按 brief 给的原始 `latexmk -pdf -interaction=nonstopmode -file-line-error main.tex` 命令跑，**不会**一次性收敛（会在第 2 轮因上条问题提前退出，页数停在 33 页且引用未解析完）。需要加 `-f` 参数才能让 `latexmk` 跨过 natbib 的非零退出码继续做完剩余轮次。这是本任务在 Step 4 执行过程中发现并解决的问题，未在 brief 原始命令里体现，特此记录。

## 环境记录小结

- 发行版：BasicTeX（`brew install --cask basictex`），版本 `2026.0301`（TeX Live 2026, pdfTeX `3.141592653-2.6-1.40.29`）
- PATH 需包含 `/Library/TeX/texbin`
- 额外安装的包（Step 3 已完成）：`latexmk` `algorithms` `algorithmicx` `mylatexformat`；Step 4 未触发任何新增安装
- `main.tex` 全量编译（干净状态，`latexmk -f -pdf -interaction=nonstopmode -file-line-error main.tex`）耗时：**约 13.7 秒**（real time）
- 页数：本地 **34** 页 / Overleaf 约 **34** 页（人类伙伴口述约数）—— 判据 33–35 页区间内视为一致 —— **对比结论：一致，验收通过**
- 参考文献渲染正常：是（`pdftotext` 检查零 `[?]`，`main.blg` 显示 106 条条目全部正常处理，最终 log 中 0 处 `Citation ... undefined`）
