# TODO

updated: 2026-09-15

## 下一步（按优先级）

### 1. `Glob` / `Grep` / `apply_patch`（“缓做”那一档，与 OS 无关）

三个都不依赖命令执行，所以能力要求归 `none`，**Win7 上也能用**。
实现前先想清楚两件事：

- `Glob` 用 `minimatch`（纯 JS、体积小）。**不要**引 `fast-glob`：依赖链长，且会拖慢启动。
- `Grep` **不要**引 ripgrep 二进制：每个平台一个 exe，包体积涨几 MB，Win7 上还有杀软误报风险。
  教学场景目录小，纯 JS 遍历够用。遍历大目录时不要用同步 API，
  Win7 机械盘 + 杀软实时扫描会把主进程卡住，界面直接白。

### 2. 命令类工具的真机验证

见 `docs/多系统-测试清单.md` 第六节新增的 6 项（中文编码 / 非 0 退出码 / 超时 / 后台任务 / 残留进程）。
开发机是 Linux，`powershellPath()` 返回 null，**PowerShell 那条真实执行路径一行都没跑过**。
首次上 Windows 时重点看：`node -v` 能不能返回、`echo 你好` 会不会乱码、超时是不是真的杀掉了子进程。

### 3. ~~`global.css` 拆分~~（已完成 2026-09-15）

已拆成 `styles/` 下的十份，入口 `index.css`，最长 599 行。清单与顺序约束见 `claude.md`
的「样式」一节。拆完用逐选择器的声明序列做过等价比对（295 个规则键全一致），
自检三档的 `domNodes` 与拆分前一样。

剩下的事：`dormant.css`（原 global.css 里「暂时不渲染的界面」那一段）成分是混的 ——
编辑器 / 标签栏 / 状态栏的类其实在用（`.editor-host` 还会被 editor.css 再改一次），
日志 / 输出 / 体检那几组才是真的没上。重新审一遍，把还在用的挪到对应文件，
剩下的才配叫 dormant。

### 4. 窄屏布局回归

自检里所有几何断言都是在「窗口 1440x900」下成立的。CI runner 屏幕只有 1024x768，
系统会把窗口夹窄到 1024，对话面板跟着变窄 —— 2026-09-15 就因为断言「三个入口必须在同一行」
而误报（`.quick-starts` 本来就写着 `flex-wrap: wrap`）。

已把那条断言改成「允许换行，但第一行至少两张、行内从左往右」。
但**其他几何断言仍然隐含「窗口足够宽」这个前提**，比如 `editorDockHasWidth`（>120px）、
`bothFullHeight`。学生机常见分辨率是 1366x768，比 runner 宽，暂时安全。

要做的事：给自检加一个可控的窗口宽度（如 `--window-size=WxH`），把关键几何断言在
「窄屏」下再跑一遍。现在是靠 runner 的屏幕尺寸“顺便”测到的，不稳定也不自觉。

---

## 已知坑（改之前务必看一眼）

- **不要先 `child.kill()` 再 `taskkill`**。先杀 powershell 就找不到它的子进程了，`/T` 遍历不到，
  反而留下一堆占着端口与 CPU 的孤儿进程。正确顺序写在 `tools/exec.ts` 的注释里。
- **命令输出的编码**：中文 Windows 默认输出代码页是 936（GBK）。
  脚本前必须 `[Console]::OutputEncoding = UTF8`，收字节必须用 `StringDecoder`——
  一个汉字 3 字节，会被切在两个 chunk 之间，`chunk.toString()` 会各自解出半个字符。
- **传脚本用 `-EncodedCommand`，不用 `-Command`**。Node 的引号转义是 C 运行时那套，
  PowerShell 是另一套，引号 / `$` / 反引号混在一起时两边对不上，会出现「在终端能跑、在这里跑不了」。
- **`config.ts` 的 `normalize()` 是白名单式的**。新增顶层 section 不加进去，
  每次加载会被静默吞掉（设置里改完、重启就没了，而且不报错）。这是最容易漏的一处。
- **`setConfig(patch)` 顶层是浅合并**。传 `{ capability: { mode: 'full' } }` 会把整个 `capability` 替掉。
- **分割条不能占布局宽度**。两侧宽度加起来已经是 100%，分割条再要 9px 会被挤到容器最右边缘（实测错位 454px）。
  解法是 `width:9px + margin:0 -4.5px`；而且 DOM 顺序必须是「编辑器 → 分割条 → 对话」，
  位置由顺序决定，光靠 CSS 救不回来。
- **文件树与侧栏要分两段滚**。`overflow-y:auto` 放在整个侧栏上，会出现「文件多了把侧栏整个推长，
  而文件树自己那一段反而没滚动条」。
- **AI 改了文件、学生手里有未保存改动时绝不覆盖**。只警告，由学生决定——
  把磁盘内容盖上去等于把学生刚写的代码删了。
- **工具写入要标记来源**（`markToolWrite`），否则编辑器分不清「AI 改的」与「别人改的」，只能一律弹提示。
- **文件监视不引 chokidar**。它在 Win7 上会退回轮询模式，50ms 一轮 stat 整棵树，
  机械盘上直接 100% 占用。用原生 `fs.watch`（Windows 上底层是 `ReadDirectoryChangesW`）。
- **样式文件的层叠顺序是契约**，写在 `styles/index.css`。`responsive.css` 必须最后
  （窄屏要覆盖各组件写死的宽度），`editor.css` 必须在所有拆分文件之后
  （`.editor-host` / `.crumb-model` 在前面有基础定义）。`base.css` 最前。
  调顺序不会报错，只会静默地让覆盖失效 —— 而且只在窄屏 / 空态这种边角下看得出来。

---

## 已验证 / 未验证

已验证（2026-09-15，Linux + xvfb）：

- ✅ `npm run typecheck` / `npm run build`（含 `check:node16` + `check:watch`）/ `npm run smoke`
- ✅ 自检跑了三档：默认 / `--capability-profile=win7` / `--capability-profile=win10`，
  能力集与预期一致（本机无 PowerShell，三档都是 6 个，命令类 4 个报「本机不支持」）
- ✅ 新增两条自检断言：不再有「尚未实现」的工具；命令类工具必须跟着探测结果走
- ✅ 样式拆分（global.css 2128 行 → styles/ 十份，最长 599 行）：
  逐选择器的声明序列等价比对 295/295 一致；三档自检 `domNodes` 与拆分前同为 228

已验证（2026-09-15，Windows Server 2022，CI 的注解）：

- ✅ **Win10 上 10 个工具全都生效**：`detected={commandExec:true,backgroundJobs:true}`，
  `effective(10)=readFile,writeFile,editFile,multiEdit,listDir,undoSnapshot,runCommand,jobRun,jobPoll,jobKill`，
  `filtered=` 空。门控「设置 ∩ 探测」在真实 Windows 上算得对。

未验证：

- ⬜ **PowerShell 真实执行路径**——上面「10 个工具生效」只证明工具进了工具表，不等于 `runCommand` 真能跑起来。
  `exec.ts` 那套 `-EncodedCommand` / 编码 / 杀进程树一次都没在 Windows 上执行过，见上面第 2 条。
- ⬜ 杀软（360 等）拦截子进程——校园机器上的典型表现是「偶发失败」，只能真机验
