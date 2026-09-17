# 7gai 工具对照与实现规划

对比对象：7gai 当前暴露的 16 个工具 vs. 本项目（hangke-ide）现有能力面。
目的：给出「哪些能实现进去、哪些不能」，并列出清单供决定先后顺序。

> 状态：**已定稿（2026-09-14）**。最终范围见第 6 节，实现进度见 §6.8。
> 2026-09-15：计划内的 10 个工具（6 个跨系统 + 4 个仅 Win10/11）已全部落地。
>
> ⚠️ **2026-09-15 修正（重要）**：本文档里所有「仅 Win10/11」的结论**已经作废**。
> 那些结论基于一个错误前提 —— 「Win7 只有 cmd.exe，所以不能执行命令」。
> 实际上 cmd.exe 在**所有** Windows 上都有，python / node 装好会写进 PATH，
> 命令执行在 Win7 上完全可用。当时 `capabilities.ts` 的 Win7 分支
> 甚至根本没去查解释器在不在，直接写死了 `commandExec = false`，
> 代价是 Win7 用户白白少掉 4 个工具。
>
> **现在的状态**：Win7 与 Win10/11 都是 **18 个工具**
> （8 文件 + 4 命令 + 4 记忆/会话 + 2 技能）。后两组是 2026-09-16/17
> 两轮陆续加进来的（`MEMORY_TOOLS` / `SKILL_TOOLS`，见 `tools/meta.ts`），
> 它们不碰工作区、不依赖外部程序，所以两档都有。
> 执行器是 cmd 而不是 PowerShell（见 `src/main/shell.ts` 的注释）。
> 另外 `Glob` / `Grep` 也已补上（自写匹配，不引 minimatch / ripgrep），
> 仍缓做的只剩 `apply_patch`。
>
> 下面的正文**保留原样不动** —— 它记录了当时的推理过程，
> 而那段推理哪里错了本身是有价值的教训：**不要把「某个系统版本缺少某能力」
> 当成事实写进代码，先去探测。**

---

## 0. 先说清楚「实现进去」是什么意思

7gai 这套工具是给**能自己读写代码、跑命令的编码 agent** 用的。要在编辑器里实现它们，
不是写 16 个函数那么简单，而是在对话循环里加一层**工具调用**：

```
用户提问 → AI 返回 tool_call → 主进程执行工具 → 结果回灌 → AI 继续 → … → 最终回答
```

现在的编辑器是**单轮问答**：`aiChat` 一次流式返回完就结束（`src/main/ipc/ai.ts`），
没有任何工具层。所以每个工具都要新增：

1. 主进程的实作（读写 / 搜索 / 执行）
2. `src/shared/types.ts` 的 `IPC` 常量
3. `src/preload/index.ts` 的白名单
4. `src/shared/api.ts` 的 `AppApi` 接口
5. AI 侧的 tool 定义（JSON Schema）+ 循环控制（最大轮数、失败重试）

判断标准不是「能不能写出来」，而是三件事：

- 在 **Electron 22 / Win7 SP1 / 学生机** 上语义是否成立
- 要动多少现有代码（每次都要改上面五处，改漏一处渲染层就拿不到）
- 对「零基础学编程」到底有没有用

---

## 1. 总表

| # | 7gai 工具 | 编辑器现有基础 | 能否实现 | 难度 | 教学价值 | 最终决定 |
|---|---|---|---|---|---|---|
| 1 | `Read` | `readFile` 已有 | 能 | 低 | 高 | 做（补 offset/limit） |
| 2 | `Write` | `writeFile` 已有 | 能 | 低 | 高 | 做（补防误覆盖） |
| 3 | `Edit` | 无 | 能 | 低 | 高 | 做 |
| 4 | `MultiEdit` | 无 | 能 | 中 | 高 | 做 |
| 5 | `LS` | `readDir` 已有 | 能 | 低 | 中 | 做 |
| 6 | `Glob` | 无 | 能 | 中 | 中 | 缓 |
| 7 | `Grep` | 无 | 能 | 中 | 中 | 缓 |
| 8 | `apply_patch` | 无 | 能 | 中高 | 中 | 缓 |
| 9 | `Bash` | 无 | 不能（改名 `RunCommand`） | 高 | 中 | **仅 Win10/11** |
| 10 | `job.run` | 无 | 仅 Win10/11 | 中高 | 低 | **仅 Win10/11** |
| 11 | `job.poll` | 无 | 仅 Win10/11 | 中 | 低 | **仅 Win10/11** |
| 12 | `job.kill` | 无 | 仅 Win10/11 | 中 | 低 | **仅 Win10/11** |
| 13 | `tasks` | 无 | 能 | 中 | 低 | **不做** |
| 14 | `vcs.commit` | 无 | — | — | 中 | **不做**（git 相关） |
| 15 | `vcs.history` | 无 | — | — | 中 | **不做**（git 相关） |
| 16 | `vcs.restore` | 无 | — | — | 中 | **不做**（git 相关） |

分档汇总（定稿）：

- **跨系统都开（6 个）**：`Read` `Write` `Edit` `MultiEdit` `LS` + `撤销快照`
- **仅 Win10/11（4 个）**：`RunCommand`（原 `Bash`）+ `job.run` `job.poll` `job.kill`
- **不做（4 个）**：`vcs.commit` `vcs.history` `vcs.restore`（git 相关）、`tasks`
- **缓做（3 个）**：`Glob` `Grep` `apply_patch`（与 OS 无关，只是优先级低）

---

## 2. 最终不做的 / 需要改语义的

### 2.1 `vcs.commit` / `vcs.history` / `vcs.restore` —— 不做（git 相关）

7gai 的 `vcs.*` 背后是它自己的工作目录 + 自动 checkpoint（每次 Write/Edit 自动提交）。
编辑器里没这个东西。照搬只有两条路，都不好走：

- 依赖学生机装 git —— 多数教室机器没装
- 自研一套 git —— 为了三个接口写一个版本控制系统，成本远超收益

**已定：不做。** 学生需要的「刚才那步改坏了，退回去」用 `撤销快照` 解决 ——
那是纯文件快照，不依赖 git。现有的 `remove` 已经会移到工作区 `.trash`
（`workspace.ts` 的 `moveToTrash`），这个思路直接扩展即可。

### 2.2 `tasks` —— 不做

纯状态管理（一个 JSON 落 userData），技术上最容易。
但它是给 agent 规划多步任务用的，**学生看不见也不需要**。
AI 面板里已经有对话流了，再加一层任务清单只是噪音。

> 注意：它与操作系统**无关**，不应被归入下面的 Win10 门控。

### 2.3 `Bash` —— 改名 `RunCommand`，仅 Win10/11 启用

Win7 SP1 只有 `cmd.exe`；PowerShell 要装 WMF 升级才有 5.1，**裸机是 2.0**。
`Bash` 这个名字连同它的语义（bash 语法、管道、`&&`、`$VAR`）在 Win7 上无法等价实现。

即便在 Win10 上，它也不是 `Bash`：

- Win10 有 PowerShell 5.1（`powershell.exe` 一定在）→ 用它跑 `-NoProfile -NonInteractive -Command`
- 真正的 bash 要 **WSL**，而 WSL 是单独安装的，不能假定学生机有

所以 Win10 上实现的是 `RunCommand(script)`，**不是 `Bash` 的移植**。

真要做的四个坑：

- **编码**：中文 Windows 的 cmd 默认代码页是 936（GBK），Node 按 UTF-8 解出来是乱码。
  要么 `chcp 65001` 先切码页，要么引 `iconv-lite` 解码。
- **路径**：Win7 有 260 字符上限，且没有长路径支持，嵌套目录会直接报错。
- **进程**：要处理超时、进程树终止（Windows 上要 `taskkill /T`，`child.kill()` 杀不干净子进程）。
- **杀软**：校园机器上「编辑器启动子进程」很容易被 360 拦，会变成偶发失败，很难排查。

### 2.4 `job.run` / `job.poll` / `job.kill` —— 随 `RunCommand` 一起，仅 Win10/11

这三个本身好写（`spawn` + `Map<id, child>` + 轮询），但它们存在的意义就是
「跑长命令时不阻塞对话」。没有可用的命令执行能力，它们没有落点，
所以与 `RunCommand` 同档门控。

---

## 3. 现有实现的缺口（做工具层之前要补的）

对比时发现两处现有代码会在工具层放大成问题：

### 3.1 `readFile` 超限时返回的是「假内容」

`src/main/ipc/workspace.ts:96`，文件超过 4 MB 时返回：

```ts
content: `// 文件过大（4.2 MB），已跳过加载。`,
truncated: true
```

界面上没问题（用户能看懂）。但工具层里 AI 会把这行当**文件真实内容**收下，
然后基于它去改代码 —— 必须改成**抛错**，或在工具返回值里明确标注。

### 3.2 `writeFile` 没有「是否读过」的保护

`workspace.ts:108` 是直接覆盖（原子写：临时文件 + rename，这点没问题）。
对话式改代码时，AI 只凭记忆里的内容写回整个文件，很容易把用户手动改的东西冲掉。
建议加一条：工具调用 `writeFile` 前必须本会话读过该文件，否则报错要求先 `Read`。

### 3.3 `Edit` 需要「唯一性校验」

`old_string` 在文件里出现多次时必须拒绝并报错，否则会改错地方。
这是 `Edit` 唯一比 `Write` 难的地方，但也是最容易被忽略的。

---

## 4. Win7 / Electron 22 的具体限制（会影响写法）

内置 Node 是 **16.17.1**，下面这些常用 API 在这条线上**没有**：

| API | 最低 Node 版本 | 本项目 |
|---|---|---|
| `structuredClone` | 17.0.0 | 没有 |
| `AbortSignal.timeout()` | 17.3.0 | 没有 |
| `node:test` 测试运行器 | 18.0.0 | 没有 |
| `fs.glob` | 22.0.0 | 没有 |
| `fs.cp` | 16.7.0 | 有 |
| `fs.rm` | 14.14.0 | 有 |
| `fs.promises` | 10.0.0 | 有 |

**关键认知：系统门控解不开上面这些限制。** 打包产物仍是 Electron 22（为了兼容 Win7），
所以在 Win10 上跑的**仍是 Node 16.17.1**。门控只解决「这台机器有没有这个能力」，
不解决「运行时版本老」。想真正解开只能出两个包（Win7 版 22 + Win10 版 3x），
成本是 CI 双份构建 + 两套兼容分支 + Win7 那份继续维护 —— **不做**。

其它要注意的：

- 遍历大目录**不要用同步 API**。Win7 上机械盘 + 杀软实时扫描会把主进程卡住，界面直接白。
- glob 匹配用 `minimatch`（纯 JS、体积小）；不要引 `fast-glob`（依赖链长，且会拖慢启动）。
- `Grep` 若走 ripgrep 二进制：每个平台一个 exe，包体积涨几 MB，Win7 上还有杀软误报风险。
  教学场景目录小，**纯 JS 遍历够用**，不引二进制。
- 所有新增 IPC 必须同步改五处（见第 0 节），漏一处就静默失败。

---

## 5. 最小落地顺序

跨系统都开的那一档，最小可用集是 5 个工具 + 1 个安全网：

| 顺序 | 工具 | 说明 |
|---|---|---|
| 1 | `readFile`（补 offset/limit） | 大文件按段读，不再返回假内容 |
| 2 | `writeFile`（补防误覆盖） | 没读过就拒绝写 |
| 3 | `editFile` | 单处替换 + 唯一性校验 |
| 4 | `multiEdit` | 多处替换，原子（全成或全不写） |
| 5 | `listDir` | 现有 `readDir` 加 depth / ignore 参数 |
| 6 | `undoSnapshot` | 每次写之前存一份，学生点「撤销」回退 |

对应新增的 IPC 通道：

- `ai:tool-exec` —— 渲染层不直接调，主进程在工具循环内部执行
- `evt:ai-tool` —— 把「正在读 hello.py」这类过程推给 UI 展示
- `ws:undo` / `ws:snapshot-list` —— 快照与撤销

---

## 6. 定稿范围与门控实施要点

### 6.1 范围（最终）

| 档 | 工具 | 门控条件 | 状态 |
|---|---|---|---|
| 跨系统都开 | `Read` `Write` `Edit` `MultiEdit` `LS` + `撤销快照` | 无（纯文件操作） | ✅ 已实现 |
| 仅 Win10/11 | `RunCommand` + `job.run` `job.poll` `job.kill` | 设置允许 **且** 系统探测通过 | ✅ 已实现 |
| 不做 | `vcs.*`×3（git）、`tasks` | — | — |
| 缓做 | `Glob` `Grep` `apply_patch` | — | — |

### 6.2 两层：设置 + 系统探测

**动态能力要能在设置里配**（2026-09-14 确定），所以分两层：

| 层 | 作用 | 来源 |
|---|---|---|
| **设置** | 决定「愿意放开到哪」 | 老师 / 使用者改，落 `config.json` |
| **系统探测** | 决定「这台机器实际能做到哪」 | 运行时只读 |

**最终生效 = 设置上限 ∩ 系统能力 − 逐项关闭**

新增 `AppConfig.capability` section：

```ts
export type CapabilityMode = 'auto' | 'conservative' | 'full'

export interface CapabilityConfig {
  /** auto：按系统探测；conservative：只用跨系统那 6 个；full：忽略探测全开 */
  mode: CapabilityMode
  /** 在上一层范围内再逐项关掉，值是工具名 */
  disabled: string[]
}
```

| mode | 含义 | 典型用途 |
|---|---|---|
| `auto`（默认） | 探测到什么就用什么 | 正常情况 |
| `conservative` | 只放开跨系统那 6 个 | 老师想让所有机器行为一致（Win7/Win10 学生看到的能力相同） |
| `full` | 忽略探测，全开 | 探测误判时人工兜底（如某精简版 Win10 探不到 PowerShell 但实际有） |

`full` 的风险要接住：**允许强开，但工具真的不可用时返回结构化错误**，例如

```
TOOL_UNAVAILABLE: 本机（Windows 7 SP1）不支持命令执行，请改用直接修改文件的方式
```

模型收到这种可读错误会自己绕开，比硬拦（设置里改不动）和静默失败都好。

### 6.3 设置界面要有什么

设置是**独立页面**（不是弹窗），左侧分栏：

- 左导航：`AI 模型` / `工具能力`，各自带一句副标题
- `工具能力` 那栏：
  - 下拉：自动（推荐）/ 保守 / 全开
  - **一块只读状态**：本机系统名、当前生效的工具数与名称、未启用清单及原因、探测备注
    —— 没这块，老师改完不知道生效没有
  - 折叠的「高级」：逐工具勾选（写进 `disabled`）

页面级的两点：保存后留在本页（给一句「已保存」），返回时若有未保存改动先问一句。

**改完必须立即生效**：工具表不能在启动时只组装一次，要在保存设置后（或每次发请求前）重建，
否则老师改完得重启。工具表若有缓存，`setConfig` 后要失效。

### 6.4 门控做在哪（不是按钮显隐）

**关键是发给模型的工具表要动态过滤：**

```
启动 → detectPlatform() + 能力探测 → 与设置求交 → 组装工具表 → 只把可用工具发给模型
```

不过滤的话，模型在 Win7 上照样会调 `RunCommand`，拿回一堆错误，白烧 token，
学生看到满屏红字 —— 比不实现更糟。

探测要**查实际能力而不是只看版本号**（Win10 LTSC / 精简版可能缺组件）：
探测一次，结果缓存到进程生命周期。

### 6.5 配置层的三个坑（改 `config.ts` 时必须处理）

1. **`normalize()` 是白名单式的**。`src/main/config.ts:16` 只合并
   `ai` / `editor` / `legacyGraphics` / `lastWorkspace` 四个 section：

   ```ts
   return {
     ai: { ...DEFAULT_CONFIG.ai, ...(input.ai || {}) },
     editor: { ...DEFAULT_CONFIG.editor, ...(input.editor || {}) },
     legacyGraphics: { ...DEFAULT_CONFIG.legacyGraphics, ...(input.legacyGraphics || {}) },
     lastWorkspace: typeof input.lastWorkspace === 'string' ? input.lastWorkspace : ''
   }
   ```

   **新增顶层 section 不加进去，每次加载会被静默吞掉**（设置里改完、重启就没了，
   而且不报错）。这是最容易漏的一处。

2. **`setConfig(patch)` 顶层是浅合并**（`normalize({ ...getConfig(), ...patch })`）。
   传 `{ capability: { mode: 'full' } }` 会把整个 `capability` 替掉 ——
   所以 `CapabilityConfig` 要么保持扁平，要么在 `normalize` 里显式合并，
   要么 UI 每次提交完整 section。

3. **老配置文件兼容**。学生机 / 老师机上已有 `config.json` 没有这个字段，
   `normalize` 会补默认值（这点是对的），但**设置界面要能看出「当前是默认值还是被改过」**，
   否则老师会以为改失败了。

### 6.6 最大的坑：CI 只测得到一条分支

CI runner 是 Server 2022，`osTier` 判为 **win10** → 探测全通过。
**Win7 那条降级分支永远不会被 CI 跑到**，坏了也不知道。

解法：跟现有 `--software` / `--force-gpu` 同一套路，加个覆盖开关：

```
--capability-profile=win7   # 强制按 Win7 能力集运行，无视探测
```

CI 里跑两次自检（默认 + `--capability-profile=win7`），然后对比两份报告。

断言写成**子集关系**而不是「两次数量不同」：命令类工具目前还没实现，
两档的数量本来就一样（都是 6 个）；等它们上线后数量会自然分开，而子集关系始终成立。
具体断言三条：

1. `overridden === true` 且 `profile` 里含 `win7` —— 覆盖开关真的生效了
2. `detected.commandExec === false` —— Win7 档不启用命令执行（降级分支的核心结论）
3. `effective(win7) ⊆ effective(默认)` —— 更窄的一档不能多出工具来

`--capability-profile` 只能验探测层，**验不了设置那层**。设置那层改在渲染进程自检里做：
真写一次 `setConfig`（`mode: 'conservative'` + 关掉一个工具）→ 真读回配置 → 断言生效集变小 →
再恢复现场。这一条同时盖住 §6.5 的两个陷阱（`normalize()` 白名单、顶层浅合并），
因为两者都不会抛异常，只会“设置页显示成功但实际没生效”。
自检跑在带 `-selftest` 后缀的独立 userData 里，改配置不会影响正常使用。

`npm run smoke` 支持追加参数，本地可以照跑：

```bash
npm run smoke -- --capability-profile=win7 --self-test-out=selftest-win7.json
```

不这样做的话，Win7 那条分支就只能在 CI 上试错，改一行等一次流水线。

### 6.7 已知代价

同一份代码在 Win7 和 Win10 上给学生的能力不一样，老师备课要心里有数。
若教室机器其实全是 Win10，把设置选 `conservative` 或直接按 Win10 一套做都行 ——
现在有了设置这层，这件事从「代码里写死」变成了「老师自己选」。

### 6.8 实现状态

| 部分 | 状态 | 位置 |
|---|---|---|
| 共享类型（`CapabilityConfig` / `ToolName` / `ToolProgress` / `CapabilityInfo`） | ✅ | `src/shared/types.ts` |
| 配置层 `capability` section | ✅ | `src/main/config.ts` |
| 工具元数据（清单 / 能力要求 / 中文名 / 模型可见的 schema） | ✅ | `src/main/tools/meta.ts` |
| 能力探测与门控求交 | ✅ | `src/main/capabilities.ts` |
| 跨系统 6 个工具 + 快照撤销 | ✅ | `src/main/tools/file-tools.ts`、`snapshot.ts` |
| 工具调度（过滤 + 执行 + 可读错误） | ✅ | `src/main/tools/index.ts` |
| 对话工具调用循环（含 400/422 降级链） | ✅ | `src/main/ipc/ai.ts` |
| 设置页（分栏：AI 模型 / 工具能力） | ✅ | `src/renderer/src/components/SettingsPage.tsx` |
| 对话里的工具调用过程展示 | ✅ | `src/renderer/src/components/AiPanel.tsx` |
| 自检断言 + CI 双跑 | ✅ | `src/renderer/src/main.tsx`、`.github/workflows/build.yml` |
| `RunCommand` + `job.*` | ✅ 已实现（2026-09-15） | `src/main/tools/exec.ts`（底层）、`command-tools.ts`（四个工具）、`jobs.ts`（后台任务注册表） |

> `IMPLEMENTED_TOOLS` 现在等于 `ALL_TOOLS`：计划里要做的都已经有实作。
> 但「已实现」不等于「会发给模型」—— 命令类四个仍要过门控，
> Win7 与未探到 powershell.exe 的机器上依然不会出现在工具表里。

### 6.9 命令类工具的实作要点（实现时踩过/绕过的）

细节写在 README 的「执行命令类工具」一节，这里只记决策，避免以后被“优化”回去：

| 决策 | 理由 |
|---|---|
| 跑 PowerShell，不假装是 Bash | Win7 裸机只有 cmd.exe；真 bash 要 WSL，学生机不能假定有 |
| 用 `-EncodedCommand`（UTF-16LE base64）传脚本 | Node 的引号转义是 C 运行时那套，PowerShell 是另一套，`-Command` 下两边对不上 |
| 脚本前先 `[Console]::OutputEncoding = UTF8` | 中文 Windows 默认代码页 936，不切就是乱码 |
| 收字节用 `StringDecoder` | 一个汉字 3 字节，可能被切在两个 chunk 之间 |
| 超时用 `taskkill /T /F`，且**不能先** `child.kill()` | 先杀 powershell 就找不到子进程了，`/T` 遍历不到，留孤儿 |
| 后台任务不落盘，退出时全杀 | 学生关掉编辑器后 `node.exe` 继续占端口，下次启动报「端口被占用」且查不到原因 |
| 工作目录默认项目根目录 | 让绝大多数情况不需额外参数；当然命令本身仍可 `cd ..` |
| 输出限 6 万字符，回灌前再裁到 1.2 万（留头尾） | 一次构建可能吐几十万行，全塞上下文既烧 token 又淹掉真报错 |
| 数值上限集中在 `tools/limits.ts` | schema 里的「上限 5 分钟」和代码里的限必须同一个数，分两处写早晚跑偏 |
