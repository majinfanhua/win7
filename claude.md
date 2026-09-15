# HangKe 开发记录索引

给后来者（包括下次的 AI）快速接手用。**先读这里，再按需展开 ./claude/ 下的细分文件。**

## 这是什么项目

带 AI 助手的桌面代码编辑器，Electron 22 + React 18 + Monaco，**目标运行环境是 Windows 7 SP1 及以上**。
AI 不只是聊天：它能读写工作区里的文件，在 Win10/11 上还能跑命令（Win7 上不能，见下）。

## 三条不能忘的硬约束

1. **Win7 是硬目标**：Chromium 锁 108、Node 锁 16。`npm run check:node16` 会扫源码里用到的 Node API 是否都支持。
2. **不能上 Electron 23+**：那版起 Chromium 110，Win7 跑不起来。
   **打包只走 GitHub Actions**（本地 `npm run dist:win` 会被 `scripts/guard-ci.mjs` 拦住）——
   交叉打包的产物与 CI 不一致，测了没意义。本地只做三件静态检查。
3. **单文件不超 800 行**。当前最长的是 `store/tree-slice.ts`（407 行），已在红线内。
   `useAppStore.ts` 曾是 1100 行，已拆成三个 slice（session / tree / editor）——
   **别再合回去**：改文件树的移动逻辑不该碰到会话逻辑，这是拆它的全部理由。
   依赖方向是单向的 `editor → tree → session`，反向调用会让循环 import 爆炸。
   已经拆过、同样**别再合回去**的：
   - `store/explorer-helpers.ts`：文件树/排序/标签恢复的纯函数
   - `store/dialogs.ts`：`askUnsaved`（tree 与 editor 都要用，避免互相 import）
   - `dev-stub-fs.ts`：浏览器预览的内存文件系统
   - `components/file-tree/`：文件树的行为（`useFileTreeController`）与外壳分开
   - `main/shell.ts`：解释器定位与临时脚本（capabilities 与 exec 共用）
   - `main/tools/search-tools.ts`：Glob / Grep
   - `main/runtimes.ts`：python / node 等运行时探测
   注意 `parentOf` 已经从 useAppStore 删掉、统一用 `explorer-helpers` 的
   `parentDirOf`（import 时 as 重命名成 parentOf）—— 曾经两份实现并存过。
   样式已按界面区块拆成 `styles/` 下的十二份，最长的是 `sidebar.css`（620 行）——
   **层叠顺序写在 `styles/index.css`，动样式前先看那份注释。**

4. **Electron 里 `window.prompt` 不可用**（调用即抛错、不弹框）。
   任何「让用户输入一个名字」的地方都必须走应用内弹层：
   `components/InputDialog.tsx`（原语）→ `components/NewEntryDialog.tsx`（新建文件/文件夹）。
   `alert` / `confirm` 是好的，只有 `prompt` 被移除。**这是「新建文件点了没反应」的根因。**

5. **主进程的「单向推送」必须在渲染层有消费者**。踩过两次，都是同一类错误：
   - `evtLog`（日志）：主进程 `pushLog` 一路写进 `store.logs`，但渲染层从来
     没订阅 `onLog`，也没渲染过它 —— 于是 `handleFileChanged` 在
     「AI 改了文件但编辑器里有未保存改动」时唯一的动作（pushLog 一条 warn）
     学生**看不到**，界面上什么都不会发生。
   - 菜单动作：`doctor` / `about` 早就发了，`onMenu` 不处理 = 点了没反应。
   **新增任何 `evt*` 通道或 `sendMenu` 动作时，顺手确认对面有人接**，
   否则它就是一个静默失效的功能，而且不会报错。

## 常用命令

```bash
npm run typecheck    # 主进程 + 渲染层两份 tsconfig
npm run build        # 会先跑 check:node16 与 check:watch
npm run smoke        # 启动窗口自检（Linux 无 DISPLAY 时自动套 xvfb）
npm run check:watch  # 纯 Node 校验文件监视时序

# 自检支持追加参数，用来复现 CI 的那几次不同配置
npm run smoke -- --capability-profile=win7
```

## CI 失败时怎么定位

**拿不到 job 日志。** `actions/jobs/<id>/logs` 接口需要仓库 admin 权限，无 token 时返回 403。
但下面两样是公开可读的（不用 token，直接 curl 即可）：

```bash
# 各步骤的结论与耗时 —— 耗时很能说明问题
curl -s https://api.github.com/repos/majinfanhua/win7/actions/jobs/<job_id>
# 失败注解（::error / ::warning 都会出现在这里）
curl -s https://api.github.com/repos/majinfanhua/win7/check-runs/<job_id>/annotations
```

所以构建链特意做了两件事，**改动 CI 时请保持**：

1. **护栏拆成独立步骤**（Node 16 检查 / 文件监视检查 / electron-vite 构建），不串在
   `npm run build` 里。合成一步就只知道「构建失败」，分不清是哪个护栏。
2. **失败输出用 `::error title=...::` 注解发出去**。日志要权限，注解不要。

判断小技巧：看步骤耗时。比如「构建」只跑了 6 秒就挂，而 `check:node16` 只要约 0.5 秒、
`check:watch` 固定耗时约 5.3 秒 —— 6 秒正好说明挂在 `check:watch` 的断言上。

## 架构速览

| 层 | 位置 | 说明 |
|---|---|---|
| 主进程 | src/main/ | 窗口、IPC、文件监视、工具执行、快照、解释器/运行时探测 |
| 预加载 | src/preload/index.ts | 唯一的渲染层 API 出口（无 nodeIntegration） |
| 渲染层 | src/renderer/src/ | React 界面 |
| 共享契约 | src/shared/ | 主/渲染两侧共用的类型与 IPC 通道常量 |

界面两栏：左侧栏（项目/会话/文件树）+ 内容区（编辑器在左、对话在右，中间可拖拽）。

### AI 工具能力（改动最频繁的一块）

```
config.capability（人愿意放开到哪）
   ∩  capabilities.ts 的探测（这台机器实际能做到哪）
   − disabled（逐项关掉）
   =  发给模型的工具表（tools/meta.ts 的 TOOL_SCHEMAS 过滤后）
```

结果是：**Win7 与 Win10/11 现在都是 12 个工具**（文件 8 + 命令 4）。
同一份包、同一套代码，差的是探测结果。

⚠️ 这里改过一次判断：以前 Win7 分支**直接写死** `commandExec = false`，
理由是「只有 cmd.exe，PowerShell 要装 WMF」—— 那个理由站不住，
cmd.exe 在所有 Windows 上都有，python/node 装好会写进 PATH。
代价是 Win7 白白少掉 4 个工具。现在统一「探测到 cmd 就启用」。

| 文件 | 干什么 |
|---|---|
| `tools/meta.ts` | 工具清单 / 中文名 / 能力要求 / 模型可见的 schema |
| `tools/limits.ts` | 数值上限（超时、输出）。schema 与实作共用，别分两处写 |
| `tools/file-tools.ts` | 跨系统那 6 个文件工具的实作 |
| `tools/exec.ts` | 命令执行底层：PowerShell / 编码 / 超时 / 杀进程树 |
| `tools/command-tools.ts` | 命令类 4 个工具的实作与结果文案 |
| `tools/jobs.ts` | 后台任务注册表（jobRun / jobPoll / jobKill 的落点） |
| `tools/index.ts` | 调度：过滤工具表 + 执行 + 把失败变成可读错误 |
| `tools/snapshot.ts` | 写盘前存原文，供「撤销」 |

新增一个工具要同步改五处（主进程实作 / `IMPLEMENTED_TOOLS` / `TOOL_SCHEMAS` / 实作表 / 自检），
漏一处就静默失败。

### 其他本轮新增的模块

| 文件 | 干什么 |
|---|---|
| `main/shell.ts` | 解释器定位（cmd/powershell）、临时 .cmd 脚本、启动清扫 |
| `main/tools/search-tools.ts` | Glob / Grep 的实现（自写 glob 匹配，不引库）|
| `main/runtimes.ts` | 探测 python / node / git 等，结果进 system prompt |
| `renderer/src/image-input.ts` | 图片压缩（canvas → JPEG，长边 1568）|
| `renderer/src/snippets.ts` | `!` / `css` / `js` 等触发词片段，与 file-templates 共用数据 |
| `renderer/src/components/PreviewPane.tsx` | 内嵌 HTML 预览（iframe + 已有静态服务）|
| `renderer/src/components/LogDrawer.tsx` | 底部日志抽屉 |

**搜索工具的两条约束**（改之前先看 `search-tools.ts` 的头注释）：
不引 `fast-glob` / `minimatch`（依赖链长、启动开销），
不引 ripgrep（每平台一个 exe，Win7 杀软误报率高）。
自己实现的 `compileGlob` 支持 `*` `?` `**` `[abc]`，
**不支持 `{a,b}` 时明确报错而不是静默当字面量**。

**预览面板的布局契约**（最容易踩的坑）：`.stage` 里编辑器是 `--split`、
对话是 `(1 - --split)`，两者**加起来正好 100%**。预览作为第三栏
**必须从 `--split` 里再切一刀**（`--preview-share`），否则总宽超过 100% →
横向滚动条 + 对话栏被挤出可视区，而且不报错。share 还要夹住：
按「对话最多让出一半」来夹，不然 split 拉到上限时对话只剩 15%。

**图片输入只在最后这一轮带图**：历史消息只发文本。base64 有几 MB，
每轮重发会让同一张图被计费十几次，部分中转站还会因请求体过大直接 413。

### 样式（`src/renderer/src/styles/`）

按界面区块分文件，入口是 `index.css`。**只在 main.tsx 里 import 这一个入口** ——
层叠顺序是契约，散在组件里就看不见了。

| 文件 | 行数 | 管什么 |
|---|---|---|
| `index.css` | 46 | 入口。只放 @import 与顺序说明 |
| `base.css` | 347 | 主题变量、基础元素、控件、布局骨架 |
| `chat.css` | 450 | 对话面板：消息气泡、空态/欢迎、输入区、引用胶囊 |
| `dialog.css` | 106 | 弹窗与表单原语 |
| `settings.css` | 397 | 设置页（已并入原 settings-extra.css）|
| `dormant.css` | 169 | 暂未渲染的界面（输出）。**看着没人用也不要删** —— 里面的 `.report` 系列正被 `DoctorDialog` 用着 |
| `sidebar.css` | 618 | 左侧栏：导航、文件树、右键菜单、拖拽落点 |
| `explorer.css` | 514 | 文件树工具栏 / 排序 / 面包屑 / 资源管理器整页视图 / 弹层补充（含 `MoveDialog`）。**必须在 sidebar.css 之后、responsive.css 之前** |
| `logs.css` | 71 | 底部日志抽屉外壳。**必须在 dormant.css 之后**（那里面已有一份 `.logs`）|
| `topbar.css` | 156 | 顶栏 |
| `responsive.css` | 77 | 所有 `@media`。**必须最后** |
| `editor.css` | 108 | 编辑器面板。**必须在拆分文件之后** |

改样式前必读的四条顺序约束（也写在 `index.css` 里）：`base` 最前、
`responsive` 在拆分文件里最后、`editor.css` 在所有拆分文件之后、
`explorer.css` 在 `sidebar.css` 之后但在 `responsive.css` 之前。
另外 `.nav-item` 在 `settings.css` 与 `sidebar.css` 里各有一份，靠顺序共存。

### 文件树 / 资源管理器

本轮的入口与落点，改之前先理清这三句话：

- **行为只有一份**：全部交互（右键菜单、新建/重命名弹层、排序、落点计算、面包屑）
  在 `components/file-tree/useFileTreeController.ts` 里；两个外壳只负责各自的头与工具栏。
- **两种形态共用同一份状态**：侧栏嵌的那份（`FileTree embedded`，由 `Sidebar.tsx` 渲染）
  与内容区整页视图（`components/file-tree/ExplorerPanel.tsx`，`App.tsx` 的 `View='explorer'`）
  读写同一个 zustand store，不存在「两套树逻辑」。
- **右键菜单的落点语义**（`resolveParentDir`）：右键文件夹 → 进它；右键文件 → 它同级；右键空白 → 项目根。
  这是「建完文件夹接着在里面建 html」能成立的地方，改动前先看那段注释。

| 文件 | 管什么 |
|---|---|
| `components/FileTree.tsx` | 装配容器（嵌入 / 非嵌入两种形态，快捷键只挂在嵌入态）|
| `components/file-tree/TreeNode.tsx` | 递归节点。**保留 `data-path` / `data-kind` / `.tree-node` / `paddingLeft: 6 + depth*13`**，自检脚本依赖 |
| `components/file-tree/TreeToolbar.tsx` | 工具栏按钮 + 排序下拉 |
| `components/file-tree/tree-menu.ts` | 菜单项定义与「失效置灰」规则（纯函数）|
| `components/file-tree/TreeOverlays.tsx` | 右键菜单浮层 + 新建/重命名/移动弹层 |
| `components/file-tree/useFileTreeController.ts` | 上面这些的全部行为 |
| `components/file-tree/MoveDialog.tsx` | 「移动到…」目录选择器（拖拽的等价备选路径）|
| `components/file-tree/ExplorerPanel.tsx` | 内容区整页视图外壳（面包屑 + 树 + 信息栏）|
| `components/file-tree/shared.ts` | 扩展名 / 基名 / 图标短标签 / 大小 / `isDescendantOf` |
| `file-templates.ts` | 新建文件时的初始骨架（HTML / CSS / JS / MD / JSON / TXT）|
| `store/explorer-helpers.ts` | `sortNodesBy` / `extOf` / `baseName` / `parentDirOf` / `tabsFromSession` 等纯函数 |
| `dev-stub-fs.ts` | 浏览器预览的内存文件系统（`files` / `dirs` / `readDirSync` / `stubMtime`）|
| `components/InputDialog.tsx` | 应用内输入弹层原语（**替代 `window.prompt`**）|
| `components/NewEntryDialog.tsx` | 新建文件/文件夹弹层（类型胶囊 + 落点面包屑 + 重名校验）|

排序偏好落在 `config.explorer.sortBy`（`'name' | 'type' | 'mtime'`），
**新增枚举值要同步改 `src/main/config.ts` 的 `normalizeExplorer()` 白名单**，
否则会被静默吞掉。`FileNode.mtime` 由主进程 `wsReadDir` 一次 `statSync` 带上（size 与 mtime 同一次 stat）。

### 拖拽移动（文件树）

**两条等价路径，一份行为**：树上直接拖到目标文件夹上，或右键「移动到…」弹层。
两者最终都调 `store.moveEntry` → 主进程 `wsMove`，不存在两套移动逻辑。

| 位置 | 干什么 |
|---|---|
| `TreeNode.tsx` | 原生 HTML5 DnD（`draggable` + dragstart/dragover/drop）。**dragover 必须 preventDefault**，漏了 drop 根本不派发 |
| `store.dropOn` | 界面层的合法性过滤（自己、自己的目录、自己的子孙）——非法时静默 |
| `MoveDialog.tsx` | 备选路径：目标在折叠深层目录、或鼠标拖不稳时用 |
| `main/ipc/workspace.ts` 的 `wsMove` | **权威守卫**（渲染层路径不可信）：重名拦住、目录环拦住、跨盘回退 copy+unlink |

拖拽状态（`dragPath` / `dropTarget`）放 store 而不是组件 state：
TreeNode 是递归渲染的，拖拽起点在另一个节点里，只有公共祖先能同时看到两边。

### 未保存改动（dirty）的三道守卫

`EditorTab.dirty` 以前只用来在标签上画一个 `•`，**不拦任何操作** ——
学生改了文件没存、点了标签上的 × 或换了项目，改动无声消失。
这和 README 里「绝不覆盖学生未保存改动」是同一条原则的两个面：
那条守的是 AI 写入路径，这三道守的是关闭路径。

| 入口 | 实现 | 行为 |
|---|---|---|
| 关标签 × | `store.closeTabChecked` | 二次确认：「先保存」/「放弃」（再问一次）/「取消」 |
| 换项目 | `store.confirmLeaveWorkspace` | 逐个保存，**有一个存不上就取消整个切换** |
| 关窗口 | `App.tsx` 的 `beforeunload` | 有脏标签就 `preventDefault()`，走 Chromium 原生确认框 |

`closeTab`（无守卫）与 `closeTabChecked`（有守卫）**必须分开**：
前者还被「文件已删除」「重命名」这些非用户主动路径调用，
在那些路径上弹「要保存吗」是纯干扰。

### 目录变更后的缓存失效（`forgetSubtrees`）

`childMap` 是「路径 → 该目录的子项」的缓存，`toggleDir` 靠 `if (!childMap[dir])`
判断「加载过没有」。**删目录 / 改名目录 / 移动目录之后必须调 `forgetSubtrees`**，
否则重名的目录重建后会被判定为「已加载」而直接显示旧内容 —— 幽灵文件。
同一个函数也清 `expanded`，因为那些 key 同样指向已经不存在的路径。

顺带：删除 / 移动目录时，**打开着的标签要按前缀一起处理**。
只按精确路径匹配的话，那些标签会留在界面上，一点保存就把刚删掉的目录建回来。

## 详细记录

- ./claude/todo.md —— **未完成的事、坑、需要验证的点**（要动代码前先看这份）
- ./docs/7gai工具对照与实现规划.md —— 工具范围与门控设计（§6.9 记了命令类工具的关键决策）
- ./docs/多系统-测试清单.md —— 分发前真机验证清单
- ./docs/技术框架方案.md —— 完整技术方案
- README.md —— 面向使用者的功能说明与架构取舍理由（踩过的坑基本都写在这里）
