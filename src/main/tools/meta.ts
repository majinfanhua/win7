import type { ToolName, ToolRequirement } from '../../shared/types'
import { RUN_TIMEOUT_DEFAULT_MS, RUN_TIMEOUT_MAX_MS } from './limits'

/**
 * 工具元数据。
 *
 * 除了 ./limits（它本身不 import 任何东西），这个文件不依赖其他模块，
 * 是为了让能力探测（capabilities.ts）能拿到工具清单而不会和工具实现互相 import 成环。
 */

/** 跨系统都能跑的工具：纯文件操作，不依赖任何外部程序 */
export const CROSS_OS_TOOLS: ToolName[] = [
  'readFile',
  'writeFile',
  'editFile',
  'multiEdit',
  'listDir',
  'glob',
  'grep',
  'undoSnapshot'
]

/**
 * 需要命令执行能力的工具。
 *
 * 只在 Windows 10/11（且真的找到 powershell.exe）上启用：
 * Win7 裸机只有 cmd.exe，PowerShell 要装 WMF 升级才有 5.1，不能假定学生机有。
 * 详见 docs/7gai工具对照与实现规划.md §2.3。
 */
export const COMMAND_TOOLS: ToolName[] = ['runCommand', 'jobRun', 'jobPoll', 'jobKill']

/**
 * 记忆与会话检索工具。
 *
 * 与文件类工具的区别：它们操作的不是工作区，而是**应用自己的数据**
 * （归档会话索引、记忆文件）。所以它们不能走 assertInsideRoot ——
 * 那条检查会把它们全挡掉（userData 在工作区之外）。
 *
 * 单独一组而不是并进 CROSS_OS_TOOLS，是为了让「AI 能碰什么」
 * 在设置界面里仍然分得清层次：文件是学生的代码，
 * 这一组是 AI 自己的笔记本，出问题时该关哪个一目了然。
 */
export const MEMORY_TOOLS: ToolName[] = ['listSessions', 'readSession', 'memoryGet', 'memoryWrite']

/** 全部工具，用于设置界面展示与门控计算 */
export const ALL_TOOLS: ToolName[] = [...CROSS_OS_TOOLS, ...COMMAND_TOOLS, ...MEMORY_TOOLS]

/**
 * 已经实现、可以真正交给模型的工具。
 * 尚未实现的工具即使门控通过也不会进工具表 —— 模型看不到就不会去调。
 *
 * 命令类四个已经实现（command-tools.ts），但能不能进工具表还要看门控：
 * 只有 Windows 10/11 且真的找到 powershell.exe 才会出现。
 */
export const IMPLEMENTED_TOOLS: ToolName[] = [...CROSS_OS_TOOLS, ...COMMAND_TOOLS, ...MEMORY_TOOLS]

export const TOOL_REQUIREMENTS: Record<ToolName, ToolRequirement> = {
  readFile: 'none',
  writeFile: 'none',
  editFile: 'none',
  multiEdit: 'none',
  listDir: 'none',
  glob: 'none',
  grep: 'none',
  undoSnapshot: 'none',
  runCommand: 'commandExec',
  jobRun: 'backgroundJobs',
  jobPoll: 'backgroundJobs',
  jobKill: 'backgroundJobs',
  // 记忆与会话检索不需要任何外部程序，也不碰工作区，所以是 none
  listSessions: 'none',
  readSession: 'none',
  memoryGet: 'none',
  memoryWrite: 'none'
}

export const TOOL_LABELS: Record<ToolName, string> = {
  readFile: '读取文件',
  writeFile: '写入文件',
  editFile: '替换一处',
  multiEdit: '替换多处',
  listDir: '列出目录',
  glob: '查找文件',
  grep: '搜索内容',
  undoSnapshot: '撤销修改',
  runCommand: '执行命令',
  jobRun: '后台任务',
  jobPoll: '查询任务',
  jobKill: '终止任务',
  listSessions: '翻归档会话',
  readSession: '读会话记录',
  memoryGet: '读记忆',
  memoryWrite: '记一笔'
}

/** 要求对应的人类说法，用于「本机不支持」的原因文案 */
export const REQUIREMENT_LABELS: Record<ToolRequirement, string> = {
  none: '基础文件操作',
  commandExec: '命令执行能力',
  backgroundJobs: '后台任务能力'
}

/** OpenAI 函数调用格式的工具定义 */
export interface ToolSchema {
  type: 'function'
  function: {
    name: ToolName
    description: string
    parameters: Record<string, unknown>
  }
}

/**
 * 交给模型的工具定义。
 * description 写得像在讲「什么时候该用它」，而不是 API 文档 —— 模型据此决定什么时候调。
 */
export const TOOL_SCHEMAS: ToolSchema[] = [
  {
    type: 'function',
    function: {
      name: 'readFile',
      description:
        '读取工作区里的一个文本文件。大文件请用 offset/limit 分次读，不要一次拉完。返回值开头会标明本次读到的是全文还是片段。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件绝对路径' },
          offset: { type: 'integer', description: '从第几行开始读（从 1 开始），默认 1' },
          limit: { type: 'integer', description: '最多读多少行，默认 800' }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'writeFile',
      description:
        '把整个文件覆盖成新内容。仅用于新建文件或确实要整篇重写的情况；只改几处请用 editFile。调本工具前必须先用 readFile 完整读过这个文件。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件绝对路径' },
          content: { type: 'string', description: '新的完整文件内容' }
        },
        required: ['path', 'content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'editFile',
      description:
        '把文件里的一段文字替换成另一段。oldString 必须在文件里**只出现一次**，否则会报错——多给几行上下文就能保证唯一。改错地方比改不动更麻烦，所以宁可报错。\n\n' +
        '空白不必和磁盘上一模一样：如果没找到完全一致的原文，会自动按「行尾符差异（CRLF/LF）→ 行尾多余空白 → 整块缩进偏移」逐级放宽再试一次，并在结果里告诉你用的是哪一级。' +
        '所以**不要**为了让 oldString 匹配而自己猜缩进或补空格——照着你读到（或记得）的内容原样给就行。相对缩进必须正确：只接受「每一行都平移同样一段空白」的情况。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件绝对路径' },
          oldString: {
            type: 'string',
            description: '要被替换掉的原文（需在文件中唯一）。空白可略有出入，见工具说明'
          },
          newString: { type: 'string', description: '替换成的新内容' },
          replaceAll: { type: 'boolean', description: 'true 时替换全部出现处，默认 false' }
        },
        required: ['path', 'oldString', 'newString']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'multiEdit',
      description:
        '对同一个文件做多处替换，**要么全部成功、要么全部不写**。任何一处失败都会中止且不修改文件，所以可以放心地把一组修改一次性提交。\n\n' +
        '每一处的空白匹配规则与 editFile 相同（会逐级放宽），按列表顺序依次应用，所以后面的替换看到的是前面已经改过的内容。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件绝对路径' },
          edits: {
            type: 'array',
            description: '按顺序应用的替换列表',
            items: {
              type: 'object',
              properties: {
                oldString: { type: 'string', description: '要被替换掉的原文' },
                newString: { type: 'string', description: '替换成的新内容' },
                replaceAll: { type: 'boolean', description: 'true 时替换全部出现处' }
              },
              required: ['oldString', 'newString']
            }
          }
        },
        required: ['path', 'edits']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'listDir',
      description: '列出目录内容，返回缩进的树形文本。先看清楚项目里有什么再动手，比直接猜文件名靠谱。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '目录绝对路径' },
          depth: { type: 'integer', description: '递归层数，默认 1，最大 3' }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'glob',
      description:
        '按文件名模式查找工作区里的文件，返回相对路径列表。' +
        '支持 `*`（不跨目录）、`?`（单个字符）、`**`（跨任意层级）与 `[abc]` 字符集；' +
        '**不支持** `{a,b}` 大括号展开，需要时拆成两次调用。' +
        '模式里不含斜杠时按文件名匹配（`*.html` 等价于 `**/*.html`）。' +
        '想知道「项目里有哪些文件」时先用它，比 listDir 一层层翻快得多。',
      parameters: {
        type: 'object',
        properties: {
          pattern: {
            type: 'string',
            description: '文件名模式，例如 **/*.html 或 *.py 或 src/**/*.js'
          },
          path: { type: 'string', description: '搜索起点目录，默认工作区根目录' }
        },
        required: ['pattern']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'grep',
      description:
        '在工作区的文件内容里搜索正则表达式，返回「文件 + 行号 + 该行内容」。' +
        '找「这个变量在哪定义」「哪里用到了这个函数」用它，不要用 listDir 逐个文件猜。' +
        '能配 glob 参数限定文件类型（如 glob="*.py"）。二进制文件会自动跳过，' +
        '结果过多时会截断并明确告知 —— 那时请缩小 path 或加 glob 过滤。',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: '要搜索的正则表达式' },
          path: { type: 'string', description: '搜索起点目录，默认工作区根目录' },
          glob: { type: 'string', description: '只在匹配这个模式的文件里搜，例如 *.js' },
          ignoreCase: { type: 'boolean', description: 'true 时忽略大小写，默认 false' }
        },
        required: ['pattern']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'undoSnapshot',
      description:
        '把文件回退到上一次修改之前。只有在你发现刚才改错了、或者对方说「帮我改回去」时使用；不要用它来试探。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '只回退这个文件；不填则回退最近一次修改' }
        },
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'runCommand',
      description:
        '在项目目录里跑一条 Windows 命令行（cmd）命令，等它结束后把输出给你。适合跑脚本、构建、解释器这类几十秒内能完事的命令。' +
        '几点必须知道：' +
        '**命令必须用英文写**（英文子命令、英文参数、ASCII 符号）—— 中文 Windows 的控制台对非 ASCII 字符的处理不统一，中文命令容易解析失败；' +
        '要处理中文内容请写在脚本文件里（如 python 源码），再用英文命令跑那个文件；' +
        '命令**不能等待输入**，交互式程序会一直卡到超时，所以给 python / node 传参时要把脚本或文件路径一起给出；' +
        `预计超过 ${RUN_TIMEOUT_DEFAULT_MS / 1000} 秒的命令请改用 jobRun，不要用本工具硬等。`,
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description:
              '要执行的命令，例如 python hello.py 或 npm test。必须用英文与 ASCII 符号，不要写中文'
          },
          cwd: { type: 'string', description: '工作目录，必须在项目内；默认项目根目录' },
          timeoutMs: {
            type: 'integer',
            description: `超时毫秒数，默认 ${RUN_TIMEOUT_DEFAULT_MS}，上限 ${RUN_TIMEOUT_MAX_MS}`
          }
        },
        required: ['command']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'jobRun',
      description:
        '把一个耗时命令放到后台跑，立刻返回任务号。适合安装依赖、跑完整测试套、启动开发服务器这类不会马上结束的命令 —— ' +
        '用 runCommand 等它们会白白耗掉一轮对话。启动后用 jobPoll 查进度，不需要了就 jobKill。' +
        '与 runCommand 一样，命令必须用英文写，且不能等待输入。',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '要执行的命令，必须用英文与 ASCII 符号' },
          cwd: { type: 'string', description: '工作目录，必须在项目内；默认项目根目录' }
        },
        required: ['command']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'jobPoll',
      description:
        '查一个后台任务跑到哪了，返回状态、已用时间和到目前为止的输出。任务结束后会给出退出码（非 0 表示报错）。' +
        '不要反复密集地查：跑长任务时先干别的事，隔一阵再看。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'jobRun 返回的任务号，如 job-1' }
        },
        required: ['id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'jobKill',
      description:
        '终止一个还在跑的后台任务（连同它启动的子进程）。用在服务器卡死、命令明显跑不下去的时候；' +
        '任务已经结束了就不需要调它。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '要终止的任务号，如 job-1' }
        },
        required: ['id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'listSessions',
      description:
        '列出以前归档过的对话（每条只有标题 + 一段梗概，不含正文）。' +
        '当用户提到「我们上次聊的那个」「之前说过的问题」而当前对话里没有相关背景时，用它找。' +
        '**不要**为了解当前对话而调它 —— 当前对话的内容本来就在你眼前。' +
        '只有用户主动归档的会话才会出现在这里。想看某条的完整内容，用 readSession 传它的 id。',
      parameters: {
        type: 'object',
        properties: {
          keyword: {
            type: 'string',
            description: '可选。只在标题、梗概、项目名里包含这个词的会话中查找'
          },
          limit: { type: 'integer', description: '最多返回几条，默认 50' }
        },
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'readSession',
      description:
        '读一条**已归档**会话的完整对话内容，按行返回。' +
        '必须先用 listSessions 拿到 id。一个会话可能很长，所以按行分页：' +
        '先不传 offset 读开头，不够再带 offset 往后读 —— 不要把整个会话一次拉进来。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'listSessions 给出的会话 id' },
          offset: { type: 'integer', description: '从第几行开始，默认 1' },
          limit: { type: 'integer', description: '最多读多少行，默认 120，上限 400' }
        },
        required: ['id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'memoryGet',
      description:
        '读你自己记下来的长期记忆（MEMORY.md 与当天的流水）。' +
        '在开始一件新事情之前、或者用户提到「我上次说过」时，先读一遍能避免重复问同样的问题。' +
        '不要每次回答都读 —— 记忆不会在对话中间自己变化，一次对话里读一次就够。',
      parameters: {
        type: 'object',
        properties: {
          target: {
            type: 'string',
            enum: ['all', 'long', 'daily'],
            description: 'all=长期记忆+今天的流水（默认），long=只要长期记忆，daily=只要某天的流水'
          },
          day: { type: 'string', description: 'target=daily 时指定日期，格式 YYYY-MM-DD，默认今天' }
        },
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'memoryWrite',
      description:
        '记一件事，以后还能想起来。**只在真正值得长期记住时才用**：用户的稳定偏好、' +
        '项目的关键约定、他反复强调的要求。不要记「刚才读了什么文件」「这次改了什么」' +
        '这类在当前对话里本来就有的东西，也不要记一次性的临时信息。\n' +
        '默认写进当天流水（target=daily）；已经沉淀下来、确定长期成立的才写进长期记忆（target=long）。\n' +
        '**绝对不要写入 API Key、密码、私钥这类凭证** —— 长期存储里的内容以后每次对话都可能被发出去，' +
        '写了就等于泄露。要记就记「用户配置了某个服务的密钥」这件事本身。',
      parameters: {
        type: 'object',
        properties: {
          content: { type: 'string', description: '要记的内容，一句话说清。写「用户偏好用 VS Code 风格的快捷键」这类事实' },
          target: {
            type: 'string',
            enum: ['daily', 'long'],
            description: 'daily=当天流水（默认），long=长期记忆（精选过的、跨会话仍成立的）'
          }
        },
        required: ['content']
      }
    }
  }
]
