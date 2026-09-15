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

/** 全部工具，用于设置界面展示与门控计算 */
export const ALL_TOOLS: ToolName[] = [...CROSS_OS_TOOLS, ...COMMAND_TOOLS]

/**
 * 已经实现、可以真正交给模型的工具。
 * 尚未实现的工具即使门控通过也不会进工具表 —— 模型看不到就不会去调。
 *
 * 命令类四个已经实现（command-tools.ts），但能不能进工具表还要看门控：
 * 只有 Windows 10/11 且真的找到 powershell.exe 才会出现。
 */
export const IMPLEMENTED_TOOLS: ToolName[] = [...CROSS_OS_TOOLS, ...COMMAND_TOOLS]

export const TOOL_REQUIREMENTS: Record<ToolName, ToolRequirement> = {
  readFile: 'none',
  writeFile: 'none',
  editFile: 'none',
  multiEdit: 'none',
  listDir: 'none',
  undoSnapshot: 'none',
  runCommand: 'commandExec',
  jobRun: 'backgroundJobs',
  jobPoll: 'backgroundJobs',
  jobKill: 'backgroundJobs'
}

export const TOOL_LABELS: Record<ToolName, string> = {
  readFile: '读取文件',
  writeFile: '写入文件',
  editFile: '替换一处',
  multiEdit: '替换多处',
  listDir: '列出目录',
  undoSnapshot: '撤销修改',
  runCommand: '执行命令',
  jobRun: '后台任务',
  jobPoll: '查询任务',
  jobKill: '终止任务'
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
        '把文件里的一段文字替换成另一段。oldString 必须在文件里**只出现一次**，否则会报错——多给几行上下文就能保证唯一。改错地方比改不动更麻烦，所以宁可报错。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件绝对路径' },
          oldString: { type: 'string', description: '要被替换掉的原文（需在文件中唯一）' },
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
        '对同一个文件做多处替换，**要么全部成功、要么全部不写**。任何一处失败都会中止且不修改文件，所以可以放心地把一组修改一次性提交。',
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
        '在项目目录里跑一段 PowerShell 脚本，等它结束后把输出给你。适合跑测试、构建、解释器这类几十秒内能完事的命令。' +
        '几点必须知道：只支持 Windows 10/11（其他系统上调用会返回错误，那时请改用直接读写文件的方式）；' +
        '命令**不能等待输入**，交互式程序会一直卡到超时，所以给 python / node 传参时要把脚本或文件路径一起给出；' +
        `预计超过 ${RUN_TIMEOUT_DEFAULT_MS / 1000} 秒的命令请改用 jobRun，不要用本工具硬等。`,
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: '要执行的 PowerShell 脚本，例如 python hello.py 或 npm test'
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
        '与 runCommand 一样，只支持 Windows 10/11，且命令不能等待输入。',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '要执行的 PowerShell 脚本' },
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
  }
]
