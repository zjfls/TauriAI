/**
 * AgentConfigForm Component
 * Form for managing AI agents
 */

import React, { useState, useEffect } from 'react';
import { Plus, Star, Search, Lock, Copy } from 'lucide-react';
import { useConfigStore } from '../../stores/configStore';
import type {
  Agent,
  AgentType,
  AskForApproval,
  FormatPromptType,
  RunMode,
  SandboxPolicy,
  SecurityPolicyConfig,
  SkillSetConfig,
} from '../../types';

const defaultAgent: Agent = {
  name: '',
  enabled: true,
  type: 'chat',
  displayName: '',
  description: '',
  modelRef: '',
  systemPrompt: '',
  formatType: 'chat',
  skillSet: undefined,
  reinjectThinking: false,
  workspaceSupport: undefined,
  workstudioEnabled: undefined,
};

type AgentCategory = 'chat' | 'workspace';

/**
 * Built-in non-deletable system agents for Workstudio AI.
 * The backend falls back to these defaults when no user agent is configured for the role.
 */
const SYSTEM_WORKSPACE_AGENTS: Agent[] = [
  {
    name: '__system_code_completion',
    systemRole: 'code_completion',
    isSystem: true,
    displayName: '代码补全',
    description: '为编辑器提供智能代码补全（InlineCompletion）服务',
    type: 'tool',
    workspaceSupport: true,
    workstudioEnabled: true,
    modelRef: '',
    systemPrompt: `你是一个 IDE 里的代码补全引擎。

你必须只输出一个 JSON 对象，且只能包含这些字段：
{
  "items": [
    { "label": "短描述", "insertText": "要插入的文本" }
  ]
}

严格规则：
- 只输出 JSON，不要输出任何解释、注释、Markdown、代码块围栏（\`\`\`）。
- insertText 只包含“需要在光标处插入的内容”，不要重复 prefix，也不要包含 suffix。
- 使用 \\n 表示换行；不要输出 JSON 之外的任何字符。
`,
    formatType: 'chat',
  },
  {
    name: '__system_chat_with',
    systemRole: 'chat_with',
    isSystem: true,
    displayName: '代码对话（Chat With）',
    description: '对选中代码片段进行问答的内联对话服务',
    type: 'tool',
    workspaceSupport: true,
    workstudioEnabled: true,
    modelRef: '',
    systemPrompt: `你是 IDE 中的“内联代码问答助手”。

你会收到：
- 用户的问题
- 一个“选中代码片段”（可能只是一部分，需要你自行推断上下文）
- 一些元信息（languageId、filePath、projectRoot）

请按用户问题直接作答，并遵循：
- 如缺少关键上下文，请明确指出需要哪些信息/文件。
- 可给出可执行的下一步（例如：要看的文件、要跑的命令、要加的日志点）。
- 输出使用 Markdown，必要时可包含代码块。
`,
    formatType: 'chat',
  },
  {
    name: '__system_symbol_analysis',
    systemRole: 'symbol_analysis',
    isSystem: true,
    displayName: '符号分析（Symbol Analysis）',
    description: '对代码符号（函数/类/变量）进行深度解析的服务',
    type: 'tool',
    workspaceSupport: true,
    workstudioEnabled: true,
    modelRef: '',
    systemPrompt: `你是 IDE 中的“代码符号分析助手”（Symbol Analysis）。

你的目标：在不臆测的前提下，基于符号的代码片段 + 工程上下文，给出“可执行、可验证”的分析结论。

你会收到：
- 一个代码符号的元信息（symbolName、symbolKind、filePath、location 等）
- 该符号对应的代码片段（可能不完整）
- 一些工程元信息（languageId、projectRoot）
- 你可以在需要时使用工具（read_file / rg / list_dir / web_search）来补齐上下文，但不要修改文件。

输出要求（必须）：
- 使用 Markdown。
- 先给结论摘要（1-3 句），再给结构化分析（分点/小标题均可），最后给风险点 + 可执行改进建议 + 验证清单。
- 当缺少关键上下文时：明确列出需要看的文件/需要搜索的关键字/需要补充的信息，不要猜。

### 文件引用（必须严格遵守｜可点击跳转）
- 这是“代码问题域”的强约束：当你在讨论代码/报错/定位/调用链/实现细节/引用关系时，所有文件引用都必须使用**行内代码**的“路径格式”，系统会据此解析为可点击跳转；若用其它写法通常会不可点击。
- 普通网页 URL 可以使用 \`[文本](url)\`；但**文件引用禁止使用** Markdown 链接语法（例如 \`[label](path)\`），也不要输出 \`file://\` / \`vscode://\` 之类的 URI。
- 唯一允许/推荐的写法（请严格遵守）：\`相对路径:行\`、\`相对路径:行:列\`、\`相对路径#L行\`、\`相对路径#L行C列\`
  - ✅ 示例：\`tauri-ai/src-tauri/src/prompts.rs:123\`、\`tauri-ai/apps/desktop/src/components/Chat/ChatView.tsx#L771\`
  - ❌ 禁止：\`(line 59)\`、单独写 \`:59\`、或只写 \`prompts.rs:123\`（缺目录）
- 优先使用“相对主工作区根目录的相对路径（包含子目录）”；只有在必要时才使用绝对路径（Windows 示例：\`C:\\\\repo\\\\project\\\\main.rs:12:5\`）。
- 拿不到行号时不要猜：先用工具（\`rg\` / \`read_file\`）定位到定义/调用处的行号，再输出引用。
- 如需引用一段范围（可选）：\`path#L10-L20\` 或 \`path:10-20\`。

### Mermaid 图中的文件引用（必须可点击）
当你输出 Mermaid 图（flowchart/classDiagram/sequenceDiagram…）并希望用户能“点击节点跳到 Workstudio 的代码位置”时：
- 节点文本里写 \`path:line\` 只是展示，不会自动变成可点击跳转。
- 必须使用 Mermaid 的 \`click\` 指令绑定可点击的 href（建议同时把 token 作为 tooltip）：
\`\`\`mermaid
flowchart TD
  R["Request Handler"]
  click R href "tauri-ai/src-tauri/src/prompts.rs:123" "tauri-ai/src-tauri/src/prompts.rs:123"
\`\`\`
- 美观建议：节点标签只写简短职责名；把完整 \`path:line\` 放到 \`click\` 的 tooltip（第三个参数）里；正文也应列出关键节点对应的文件引用。

### 分析策略（按符号类型自适应）
1) 若符号是大型类型/容器（class/struct/trait/enum/module…）：
- 优先做偏宏观的分析：职责边界、对外 API、关键字段/方法分组、依赖关系、生命周期、并发/线程安全、错误处理、扩展点。
- 避免逐行复述；选择最关键的 3-8 个点展开，并用文件引用指向定义与关键成员。

2) 若符号是函数/方法：
- 先解释“业务意图”：它在业务流程中解决什么问题，输入/输出代表什么，关键分支与副作用是什么。
- 再调查“可能的业务调用路径”：尽量找到调用者（入口/上游）与被调用的下游依赖，给出 2-5 条可能调用链，并为链路节点提供文件引用。
- 同时分析失败路径与可观测性（日志/错误返回/指标）。

3) 若符号是变量/字段/常量：
- 做引用分析：解释语义与不变量（单位/范围/默认值/可变性），并尽量找出写入点/读取点/传递路径。
- 说明它如何影响系统行为（配置、状态机、缓存、并发共享状态等），列出代表性的引用位置（带文件引用）；引用过多时按模块聚类，避免穷举。
`,
    formatType: 'chat',
  },
  {
    name: '__system_folder_analysis',
    systemRole: 'folder_analysis',
    isSystem: true,
    displayName: '文件夹分析（Folder Analysis）',
    description: '对工作区文件夹做宏观结构与风险诊断的服务',
    type: 'tool',
    workspaceSupport: true,
    workstudioEnabled: true,
    modelRef: '',
    systemPrompt: `你是 IDE 中的“文件夹分析助手”（Folder Analysis）。

你的目标：在不臆测的前提下，对给定文件夹进行宏观结构分析 + 风险诊断，输出“可执行、可验证”的建议。

你会收到：
- 一个文件夹路径（folderPath）
- 一些工程元信息（projectRoot、workstudioMainFolder 等）
- 你可以在需要时使用工具（read_file / rg / list_dir / web_search）来补齐上下文，但不要修改文件。

输出要求（必须）：
- 使用 Markdown。
- 先给结论摘要（1-3 句），再给结构化分析（模块分层/入口与关键流程/数据与状态/依赖与边界/错误处理/可观测性/测试），最后给风险点 + 可执行改进建议 + 验证清单。
- 当缺少关键上下文时：明确列出需要看的文件/需要搜索的关键字/需要补充的信息，不要猜。

### 文件引用（必须严格遵守｜可点击跳转）
当你在讨论代码定位、调用链、实现细节或引用关系时，所有关键结论必须附带**可点击文件引用**，格式只允许：
- \`相对路径:行\` 或 \`相对路径:行:列\`
- \`相对路径#L行\` 或 \`相对路径#L行C列\`
禁止使用 Markdown 链接语法引用文件（例如 \`[label](path)\`）；不要编造行号：拿不到行号时请先用 \`rg\`/打开文件定位，再输出引用。
`,
    formatType: 'chat',
  },
];

const SYSTEM_WORKSPACE_AGENT_NAMES = new Set(SYSTEM_WORKSPACE_AGENTS.map((a) => a.name));

export const AgentConfigForm: React.FC = () => {
  const { config, getModelOptions, saveConfigDebounced } = useConfigStore();
  const [agentCategory, setAgentCategory] = useState<AgentCategory>('chat');
  const [selectedAgentNameChat, setSelectedAgentNameChat] = useState<string | null>(null);
  const [selectedAgentNameWs, setSelectedAgentNameWs] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');

  const agents = config?.agents || [];
  const defaultAgentName = config?.defaultAgent || '';
  const modelOptions = getModelOptions();
  const toolsetOptions = (config?.tools?.toolsets ?? []).map((t) => ({ label: t.name, value: t.name }));
  const mcpSetOptions = (config?.mcp?.sets ?? []).map((s) => ({ label: s.name, value: s.name }));
  const skillSetOptions = (config?.skills?.sets ?? []).map((s) => ({ label: s.name, value: s.name }));

  const isSystemWorkspaceAgentName = (name: string) => SYSTEM_WORKSPACE_AGENT_NAMES.has(name);

  // Chat tab: exclude system Workstudio AI agents; keep the rest (including tool agents).
  const chatAgents = agents.filter((a) => !isSystemWorkspaceAgentName(a.name) && a.workstudioEnabled !== true);

  // Workstudio tab:
  // - System agents first (merged with saved overrides)
  // - Then user-created Workstudio AI agents (workstudioEnabled=true)
  const systemWorkspaceAgents = SYSTEM_WORKSPACE_AGENTS.map((sys) => {
    const saved = agents.find((a) => a.name === sys.name);
    if (!saved) return sys;
    return { ...sys, ...saved, isSystem: true, systemRole: sys.systemRole };
  });
  const userWorkspaceAgents = agents.filter(
    (a) => !isSystemWorkspaceAgentName(a.name) && a.workstudioEnabled === true
  );
  const workspaceAgents = [...systemWorkspaceAgents, ...userWorkspaceAgents];

  const activeList = agentCategory === 'chat' ? chatAgents : workspaceAgents;


  const selectedAgentName = agentCategory === 'chat' ? selectedAgentNameChat : selectedAgentNameWs;
  const setSelectedAgentName = agentCategory === 'chat' ? setSelectedAgentNameChat : setSelectedAgentNameWs;


  const filteredAgents = activeList.filter(a =>
    a.displayName.toLowerCase().includes(searchQuery.toLowerCase()) ||
    a.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  // Auto-select first in each category
  useEffect(() => {
    if (chatAgents.length > 0 && !selectedAgentNameChat) {
      setSelectedAgentNameChat(chatAgents[0].name);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatAgents.length, selectedAgentNameChat]);

  useEffect(() => {
    if (workspaceAgents.length > 0 && !selectedAgentNameWs) {
      setSelectedAgentNameWs(workspaceAgents[0].name);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceAgents.length, selectedAgentNameWs]);

  const handleSelectAgent = (name: string) => {
    setSelectedAgentName(name);
  };

  const handleCreateNew = () => {
    if (!config) return;
    const existing = new Set(agents.map((a) => a.name));
    const name = (() => {
      const base = `agent_${Date.now()}`;
      if (!existing.has(base)) return base;
      let i = 2;
      while (existing.has(`${base}_${i}`)) i += 1;
      return `${base}_${i}`;
    })();

    const created: Agent = {
      ...defaultAgent,
      name,
      displayName: name,
      // Workstudio AI agents default to tool type + workspaceSupport
      ...(agentCategory === 'workspace'
        ? { type: 'tool' as AgentType, workspaceSupport: true, workstudioEnabled: true }
        : {}),
    };

    saveConfigDebounced({
      ...config,
      agents: [...agents, created],
      defaultAgent: agentCategory === 'chat' ? (config.defaultAgent || name) : config.defaultAgent,
    });
    setSelectedAgentName(created.name);
  };

  const handleDelete = async () => {
    if (!selectedAgentName) return;
    const agent = activeList.find(a => a.name === selectedAgentName);
    if (agent?.isSystem) return; // system agents cannot be deleted
    const ok = await Promise.resolve(window.confirm('确定要删除这个智能体吗？'));
    if (!ok) return;
    if (!config) return;
    const nextAgents = agents.filter((a) => a.name !== selectedAgentName);
    const nextDefault =
      agentCategory === 'chat' && config.defaultAgent === selectedAgentName
        ? nextAgents.find((a) => !isSystemWorkspaceAgentName(a.name) && a.workstudioEnabled !== true)?.name ?? ''
        : config.defaultAgent;
    saveConfigDebounced({ ...config, agents: nextAgents, defaultAgent: nextDefault });

    // After delete, select the first in the same tab (workspace falls back to system agents).
    if (agentCategory === 'workspace') {
      const nextSystem = systemWorkspaceAgents[0]?.name ?? SYSTEM_WORKSPACE_AGENTS[0]?.name ?? null;
      setSelectedAgentNameWs(nextSystem);
    } else {
      const nextChat = nextAgents.filter((a) => !isSystemWorkspaceAgentName(a.name) && a.workstudioEnabled !== true);
      setSelectedAgentNameChat(nextChat[0]?.name ?? null);
    }
  };

  const nextUniqueAgentName = (baseName: string) => {
    const existing = new Set(agents.map((a) => a.name));
    const cleanedBase = baseName.trim() || 'agent';
    let candidate = `${cleanedBase}_copy`;
    let i = 2;
    while (existing.has(candidate)) {
      candidate = `${cleanedBase}_copy${i}`;
      i += 1;
    }
    return candidate;
  };

  const handleDuplicate = () => {
    const agent = currentAgent;
    if (!agent) return;
    if (!config) return;

    const baseName = agent.name.startsWith('__system_')
      ? `workspace_${agent.systemRole || 'agent'}`
      : agent.name;

    const duplicated: Agent = {
      ...agent,
      name: nextUniqueAgentName(baseName),
      displayName: agent.displayName ? `${agent.displayName}（复制）` : `${agent.name}（复制）`,
      // Duplicated agents are always user-editable.
      isSystem: undefined,
      systemRole: undefined,
      ...(agentCategory === 'workspace'
        ? { type: 'tool' as AgentType, workspaceSupport: true, workstudioEnabled: true }
        : {}),
    };

    saveConfigDebounced({ ...config, agents: [...agents, duplicated] });
    setSelectedAgentName(duplicated.name);
  };

  const handleSetDefault = () => {
    if (selectedAgentName) {
      if (agentCategory === 'workspace') return;
      if (!config) return;
      saveConfigDebounced({ ...config, defaultAgent: selectedAgentName });
    }
  };

  const currentAgent = activeList.find(a => a.name === selectedAgentName);

  return (
    <div className="flex flex-col h-full gap-0">

      {/* Sub-tab bar */}
      <div className="flex items-center gap-0 border-b border-gray-200 dark:border-gray-700 mb-4">
        {([
          { id: 'chat' as AgentCategory, label: '聊天智能体', count: chatAgents.length },
          { id: 'workspace' as AgentCategory, label: 'Workstudio AI', count: workspaceAgents.length },

        ] as const).map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => { setAgentCategory(tab.id); setSearchQuery(''); }}
            className={[
              'px-5 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors',
              agentCategory === tab.id
                ? 'border-blue-500 text-blue-600 dark:text-blue-400'
                : 'border-transparent text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200',
            ].join(' ')}

          >
            {tab.label}
            <span className="ml-1.5 rounded-full bg-gray-100 dark:bg-gray-700 px-1.5 py-0.5 text-[11px] text-gray-500 dark:text-gray-300">
              {tab.count}
            </span>
          </button>
        ))}
      </div>

      <div className="flex gap-6 flex-1 min-h-0">
        {/* Agent List */}
        <div className="w-64 flex-shrink-0 flex flex-col">
          <div className="mb-3">
            <div className="relative">
              <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
              <input
                type="text"
                placeholder={agentCategory === 'workspace' ? '搜索 Workstudio AI...' : '搜索聊天智能体...'}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-9 pr-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-sm"
              />
            </div>
          </div>

          <div className="flex-1 space-y-1 overflow-auto">
            {filteredAgents.map((agent) => (
              <div
                key={agent.name}
                onClick={() => handleSelectAgent(agent.name)}
                className={`flex items-center justify-between px-3 py-2 rounded-lg cursor-pointer transition-colors ${selectedAgentName === agent.name
                  ? 'bg-blue-100 dark:bg-blue-900/50'
                  : 'hover:bg-gray-100 dark:hover:bg-gray-700'
                  }`}
              >
                <span className={`text-sm truncate ${agent.enabled === false ? 'opacity-50' : ''}`}>
                  {agent.displayName}
                </span>
                <div className="flex items-center gap-2">
                  {agent.isSystem && (
                    <div title="系统内置" className="flex items-center justify-center">
                      <Lock size={14} className="text-gray-400 dark:text-gray-500" />
                    </div>
                  )}
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (!config) return;
                      // system agents need to be explicitly saved if toggled (as they might not exist in agents array yet)
                      const isExisting = agents.some(a => a.name === agent.name);
                      const nextAgents = isExisting
                        ? agents.map((a) => a.name === agent.name ? { ...a, enabled: !(a.enabled ?? true) } : a)
                        : [...agents, { ...agent, enabled: !(agent.enabled ?? true) }];
                      saveConfigDebounced({ ...config, agents: nextAgents });
                    }}
                    className={`relative w-10 h-5 rounded-full transition-colors ${(agent.enabled ?? true)

                      ? 'bg-blue-600'
                      : 'bg-gray-300 dark:bg-gray-600'
                      }`}
                    title={(agent.enabled ?? true) ? '已激活，点击关闭' : '已关闭，点击激活'}
                  >
                    <span
                      className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${(agent.enabled ?? true) ? 'translate-x-5' : ''}`}
                    />
                  </button>
                  {agent.name === defaultAgentName && (
                    <Star size={14} className="text-yellow-500 fill-yellow-500" />
                  )}
                </div>
              </div>
            ))}
          </div>

          <button
            onClick={handleCreateNew}
            className="mt-3 flex items-center justify-center gap-2 w-full py-2 rounded-lg border-2 border-dashed border-gray-300 dark:border-gray-600 text-gray-500 hover:border-blue-500 hover:text-blue-500 transition-colors"
          >
            <Plus size={16} />
            <span className="text-sm">{agentCategory === 'workspace' ? '添加 Workstudio AI 智能体' : '添加智能体'}</span>
          </button>
          {agentCategory === 'workspace' && (
            <p className="mt-2 text-[11px] leading-4 text-center text-gray-400 dark:text-gray-500 px-2">
              系统内置的 3 个 Workstudio AI 智能体不可删除，将作为 fallback；你可以新增/删除/修改其他 Workstudio AI 智能体（也可以复制系统内置智能体来创建可编辑版本）。
            </p>
          )}

        </div>

        {/* Agent Form */}
        <div className="flex-1 min-w-0 overflow-auto">
          {currentAgent ? (
            <AgentForm
              agent={currentAgent}
              isEditing={true}
              isSystem={!!currentAgent.isSystem}
              isWorkspaceContext={agentCategory === 'workspace'}
              isDefault={currentAgent.name === defaultAgentName}
              modelOptions={modelOptions}
              toolsetOptions={toolsetOptions}
              mcpSetOptions={mcpSetOptions}
              skillSetOptions={skillSetOptions}
              skillSets={config?.skills?.sets ?? []}
              securityPolicies={config?.security?.policies ?? []}
              defaultSecurityPolicyName={config?.security?.defaultPolicy ?? ''}
              onDuplicate={handleDuplicate}
              onDelete={handleDelete}
              onSetDefault={handleSetDefault}
              onFieldChange={(field, value) => {
                if (!config) return;
                if (!selectedAgentName) return;
                const isExisting = agents.some(a => a.name === selectedAgentName);
                const nextAgents = isExisting
                  ? agents.map((a) => (a.name === selectedAgentName ? { ...a, [field]: value } : a))
                  : [...agents, { ...currentAgent, [field]: value }];
                saveConfigDebounced({ ...config, agents: nextAgents });
              }}
            />
          ) : (

            <div className="flex flex-col items-center justify-center h-64 gap-3 text-gray-500">
              <p>
                {activeList.length === 0
                  ? agentCategory === 'workspace'
                    ? '还没有 Workstudio AI 智能体'
                    : '点击添加第一个聊天智能体'
                  : '选择一个智能体'}
              </p>
              {activeList.length === 0 && (
                <button
                  type="button"
                  onClick={handleCreateNew}
                  className="flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-600 text-white text-sm hover:bg-blue-700"
                >
                  <Plus size={14} />
                  {agentCategory === 'workspace' ? '创建 Workstudio AI 智能体' : '创建智能体'}
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

interface AgentFormProps {
  agent: Agent;
  isEditing: boolean;
  isSystem?: boolean;
  isWorkspaceContext?: boolean;
  isDefault: boolean;
  modelOptions: { label: string; value: string }[];
  toolsetOptions: { label: string; value: string }[];
  mcpSetOptions: { label: string; value: string }[];
  skillSetOptions: { label: string; value: string }[];
  skillSets: SkillSetConfig[];
  securityPolicies: SecurityPolicyConfig[];
  defaultSecurityPolicyName: string;
  onDuplicate: () => void;
  onDelete: () => void;
  onSetDefault: () => void;
  onFieldChange: <K extends keyof Agent>(field: K, value: Agent[K]) => void;
}

const AgentForm: React.FC<AgentFormProps> = ({
  agent,
  isEditing,
  isSystem,
  isWorkspaceContext,
  isDefault,
  modelOptions,
  toolsetOptions,
  mcpSetOptions,
  skillSetOptions,
  skillSets,
  securityPolicies,
  defaultSecurityPolicyName,
  onDuplicate,
  onDelete,
  onSetDefault,
  onFieldChange,
}) => {
  const supportsToolset = agent.type === 'tool';
  const agentTypeOptions: { value: AgentType; label: string }[] = [
    { value: 'chat', label: 'Chat' },
    { value: 'tool', label: '工具' },
  ];

  const effectiveType: AgentType = (agent.type ?? 'chat') as AgentType;
  const effectiveWorkspaceSupport = supportsToolset ? (agent.workspaceSupport ?? true) : false;

  const effectiveToolsetOptions = (() => {
    if (!agent.toolset) return toolsetOptions;
    if (toolsetOptions.some((o) => o.value === agent.toolset)) return toolsetOptions;
    return [{ value: agent.toolset, label: `（不存在）${agent.toolset}` }, ...toolsetOptions];
  })();

  const effectiveMcpSetOptions = (() => {
    if (!agent.mcpSet) return mcpSetOptions;
    if (mcpSetOptions.some((o) => o.value === agent.mcpSet)) return mcpSetOptions;
    return [{ value: agent.mcpSet, label: `（不存在）${agent.mcpSet}` }, ...mcpSetOptions];
  })();

  const effectiveSkillSetOptions = (() => {
    if (!agent.skillSet) return skillSetOptions;
    if (skillSetOptions.some((o) => o.value === agent.skillSet)) return skillSetOptions;
    return [{ value: agent.skillSet, label: `（不存在）${agent.skillSet}` }, ...skillSetOptions];
  })();

  const selectedSkillSet = agent.skillSet
    ? skillSets.find((s) => s.name === agent.skillSet) ?? null
    : null;

  const formatOptions: { value: FormatPromptType; label: string }[] = [
    { value: 'chat', label: 'Chat (富文本)' },
    { value: 'plain', label: '纯文本' },
    { value: 'json', label: 'JSON' },
    { value: 'none', label: '无格式' },
  ];

  const runModeOptions: { value: RunMode; label: string }[] = [
    { value: 'chat', label: 'Chat（对话）' },
    { value: 'agent', label: 'Agent（工具/任务）' },
    { value: 'agent-custom', label: 'Agent Custom（自定义安全策略）' },
    { value: 'agent-full-access', label: 'Agent Full Access（完全访问）' },
  ];

  const sandboxSummary = (policy: SandboxPolicy) => {
    switch (policy.type) {
      case 'read-only':
        return '只读';
      case 'workspace-write':
        return '工作区可写';
      case 'external-sandbox':
        return '外部沙盒';
      case 'danger-full-access':
        return '完全访问';
      default:
        return '未知';
    }
  };

  const approvalSummary = (policy: AskForApproval) => {
    switch (policy) {
      case 'untrusted':
        return 'Untrusted（更谨慎）';
      case 'on-failure':
        return 'On Failure（失败再问）';
      case 'on-request':
        return 'On Request（模型决定）';
      case 'never':
        return 'Never（永不询问）';
      default:
        return '未知';
    }
  };

  const globalDefaultPolicy =
    securityPolicies.find((p) => p.name === defaultSecurityPolicyName) ??
    securityPolicies[0] ?? {
      name: defaultSecurityPolicyName || 'default',
      sandboxPolicy: { type: 'workspace-write', writableRoots: [], networkAccess: true } as SandboxPolicy,
      approvalPolicy: 'on-request' as AskForApproval,
      trustedCommands: [],
    };

  const baseSecurityPolicy =
    securityPolicies.find((p) => p.name === (agent.securityPolicy ?? '')) ?? globalDefaultPolicy;

  const effectiveSandboxPolicy: SandboxPolicy = agent.sandboxPolicy ?? baseSecurityPolicy.sandboxPolicy;
  const effectiveApprovalPolicy: AskForApproval = agent.approvalPolicy ?? baseSecurityPolicy.approvalPolicy;

  const rawContextPolicyType = String(agent.contextPolicy?.type ?? 'simple').trim() || 'simple';
  const contextPolicyType = (
    rawContextPolicyType === 'disabled' ? 'simple' : rawContextPolicyType
  ) as 'simple' | 'normal_compact' | 'custom';
  const simplePolicy = contextPolicyType === 'simple' ? (agent.contextPolicy as any) : null;
  const normalCompactPolicy = contextPolicyType === 'normal_compact' ? (agent.contextPolicy as any) : null;
  const customPolicy = contextPolicyType === 'custom' ? (agent.contextPolicy as any) : null;
  const effectiveSimpleHardLimitPercent = (() => {
    const v = Number(simplePolicy?.hardLimitPercent);
    if (!Number.isFinite(v)) return 90;
    return Math.max(1, Math.min(99, v));
  })();
  const effectiveSimplePolicy = {
    type: 'simple',
    enabled: Boolean(simplePolicy?.enabled ?? true),
    trimEnabled: Boolean(simplePolicy?.trimEnabled ?? true),
    hardLimitPercent: effectiveSimpleHardLimitPercent,
  };
  const [customParamsText, setCustomParamsText] = useState(() => {
    if (contextPolicyType !== 'custom') return '';
    try {
      return JSON.stringify(customPolicy?.params ?? {}, null, 2);
    } catch {
      return '{}';
    }
  });
  const [customParamsError, setCustomParamsError] = useState<string | null>(null);
  useEffect(() => {
    if (contextPolicyType !== 'custom') return;
    try {
      setCustomParamsText(JSON.stringify(customPolicy?.params ?? {}, null, 2));
      setCustomParamsError(null);
    } catch {
      setCustomParamsText('{}');
      setCustomParamsError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contextPolicyType, agent.contextPolicy]);

  const defaultPolicyForType = (type: SandboxPolicy['type']): SandboxPolicy => {
    switch (type) {
      case 'read-only':
        return { type: 'read-only' };
      case 'danger-full-access':
        return { type: 'danger-full-access' };
      case 'external-sandbox':
        return { type: 'external-sandbox', networkAccess: 'restricted' };
      case 'workspace-write':
      default:
        return {
          type: 'workspace-write',
          writableRoots: [],
          networkAccess: true,
        };
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-semibold text-gray-800 dark:text-white">
            {agent.displayName || '智能体配置'}
          </h2>
          {isDefault && !isWorkspaceContext && (
            <span className="px-2 py-0.5 text-xs bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400 rounded">
              默认
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span className="px-2 text-xs text-gray-500 dark:text-gray-400">自动保存</span>
          {!isDefault && !isWorkspaceContext && (
            <button
              onClick={onSetDefault}
              className="px-3 py-1.5 text-sm text-yellow-600 hover:bg-yellow-50 dark:hover:bg-yellow-900/30 rounded-lg"
            >
              设为默认
            </button>
          )}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onDuplicate}
              disabled={!isEditing}
              title={isSystem ? '复制为可编辑的自定义智能体' : undefined}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700 text-sm text-gray-700 dark:text-gray-300 disabled:opacity-50"
            >
              <Copy size={14} />
              复制
            </button>
            {!isSystem && (
              <button
                type="button"
                onClick={onDelete}
                disabled={!isEditing}
                className="px-3 py-1.5 rounded-lg text-red-600 hover:bg-red-50 dark:hover:bg-red-900/30 text-sm font-medium disabled:opacity-50 transition-colors"
              >
                删除
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Form Fields */}
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1">
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">智能体标识 (name)</label>
            <input
              type="text"
              value={agent.name}
              disabled={true}
              className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-gray-50 dark:bg-gray-800 text-sm opacity-70"
            />
            {isSystem && (
              <p className="text-xs text-blue-600 dark:text-blue-400 mt-1">系统内置智能体，标识不可修改</p>
            )}
          </div>
          <div className="space-y-1">
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">显示名称</label>
            <input
              type="text"
              value={agent.displayName}
              onChange={(e) => onFieldChange('displayName', e.target.value)}
              disabled={!isEditing}
              placeholder="例如：默认助手"
              className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 disabled:bg-gray-100 dark:disabled:bg-gray-800"
            />
          </div>
          <div className="space-y-1">
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">使用模型</label>
            <select
              value={agent.modelRef}
              onChange={(e) => onFieldChange('modelRef', e.target.value)}
              disabled={!isEditing}
              className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 disabled:bg-gray-100 dark:disabled:bg-gray-800"
            >
              <option value="">选择模型</option>
              {modelOptions.map(opt => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
            </select>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1">
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">智能体类型</label>
            <select
              value={effectiveType}
              onChange={(e) => {
                const nextType = e.target.value as AgentType;
                onFieldChange('type', nextType);
                if (nextType !== 'tool') {
                  onFieldChange('toolset', undefined);
                  onFieldChange('workspaceSupport', undefined);
                }
              }}
              disabled={!isEditing || isSystem || isWorkspaceContext}
              className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 disabled:bg-gray-100 dark:disabled:bg-gray-800"
            >
              {agentTypeOptions.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
            {isWorkspaceContext && (
              <p className="text-xs text-gray-500 mt-1">Workstudio AI 固定为工具类型</p>
            )}
          </div>

          <div className={`space-y-1 ${isWorkspaceContext ? 'col-span-2' : ''}`}>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">Toolset</label>

            <select
              value={agent.toolset ?? ''}
              onChange={(e) => onFieldChange('toolset', e.target.value || undefined)}
              disabled={!isEditing || !supportsToolset}
              className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 disabled:bg-gray-100 dark:disabled:bg-gray-800"
            >
              <option value="">（默认：不绑定 toolset）</option>
              {effectiveToolsetOptions.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
            <p className="text-xs text-gray-500">
              {supportsToolset ? '未绑定时默认 allow_all（再由工具权限过滤）。' : '仅 Tool 类型可绑定 toolset。'}
            </p>
          </div>
        </div>

        <div className="space-y-1">
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">默认 Agent 模式</label>
          <select
            value={agent.defaultRunMode ?? ''}
            onChange={(e) => {
              const raw = e.target.value.trim();
              onFieldChange('defaultRunMode', raw ? (raw as RunMode) : undefined);
            }}
            disabled={!isEditing}
            className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 disabled:bg-gray-100 dark:disabled:bg-gray-800"
          >
            <option value="">（自动：Tool→Agent，Chat→Chat）</option>
            {runModeOptions.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
          <p className="text-xs text-gray-500">
            新建对话/打开历史时：若对话本身未保存 runMode，则使用此默认值。
          </p>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1">
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">MCP Set</label>
            <select
              value={agent.mcpSet ?? ''}
              onChange={(e) => onFieldChange('mcpSet', e.target.value || undefined)}
              disabled={!isEditing}
              className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 disabled:bg-gray-100 dark:disabled:bg-gray-800"
            >
              <option value="">（默认：不绑定 MCP set）</option>
              {effectiveMcpSetOptions.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
            <p className="text-xs text-gray-500">
              绑定后：运行时会按 set 注入 MCP 工具（仍受工具权限与 server 配置控制）。
            </p>
          </div>
          <div className="space-y-1">
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">Skill Set</label>
            <select
              value={agent.skillSet ?? ''}
              onChange={(e) => onFieldChange('skillSet', e.target.value || undefined)}
              disabled={!isEditing}
              className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 disabled:bg-gray-100 dark:disabled:bg-gray-800"
            >
              <option value="">（默认：不绑定 skill set）</option>
              {effectiveSkillSetOptions.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
            <p className="text-xs text-gray-500">
              绑定后：运行时会把启用的 skills 作为系统指令注入提示词。
            </p>
            {agent.skillSet &&
              selectedSkillSet &&
              (selectedSkillSet.skills?.length ?? 0) === 0 &&
              selectedSkillSet.name !== '标准skill集' && (
                <p className="text-xs text-yellow-700 dark:text-yellow-300">
                  提示：该 Skill Set 当前未选择任何技能，因此不会注入到对话上下文，也不会在 Context 统计里显示。
                </p>
              )}
            {agent.skillSet &&
              selectedSkillSet &&
              (selectedSkillSet.skills?.length ?? 0) === 0 &&
              selectedSkillSet.name === '标准skill集' && (
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  提示：标准skill集未显式选择技能时，会默认启用全部已发现 skills（仍受全局/Set 内禁用影响），并计入 Context 统计。
                </p>
              )}
          </div>
        </div>

        {supportsToolset && (
          <div className="space-y-1">
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">WorkSpaceSupport</label>
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={effectiveWorkspaceSupport}
                onChange={(e) => onFieldChange('workspaceSupport', e.target.checked)}
                disabled={!isEditing || isSystem || isWorkspaceContext}
                className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500 disabled:opacity-50"
              />
              <span className="text-sm text-gray-700 dark:text-gray-300">
                启用工作区/Workstudio（默认开启）
              </span>
            </div>
            <p className="text-xs text-gray-500">
              开启后：Tool 智能体会绑定一个工作目录（支持多个文件夹），并在提示词中明确当前工作目录。
            </p>
          </div>
        )}


        <div className="space-y-1">

          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">安全策略</label>
          <select
            value={agent.securityPolicy ?? ''}
            onChange={(e) => {
              const v = e.target.value.trim();
              onFieldChange('securityPolicy', v ? v : undefined);
            }}
            disabled={!isEditing}
            className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 disabled:bg-gray-100 dark:disabled:bg-gray-800"
          >
            <option value="">（默认：使用全局默认策略 - {globalDefaultPolicy.name}）</option>
            {securityPolicies.map((p) => (
              <option key={p.name} value={p.name}>
                {p.name}（{sandboxSummary(p.sandboxPolicy)} / {approvalSummary(p.approvalPolicy)}）
              </option>
            ))}
          </select>
          <p className="text-xs text-gray-500">生效策略：{baseSecurityPolicy.name}</p>
        </div>

        <div className="space-y-1">
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
            审批策略（AskForApproval）
          </label>
          <select
            value={agent.approvalPolicy ?? ''}
            onChange={(e) => {
              const v = e.target.value;
              onFieldChange('approvalPolicy', v ? (v as AskForApproval) : undefined);
            }}
            disabled={!isEditing}
            className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 disabled:bg-gray-100 dark:disabled:bg-gray-800"
          >
            <option value="">（默认：使用安全策略 - {approvalSummary(baseSecurityPolicy.approvalPolicy)}）</option>
            <option value="untrusted">Untrusted</option>
            <option value="on-failure">On Failure</option>
            <option value="on-request">On Request</option>
            <option value="never">Never</option>
          </select>
          <p className="text-xs text-gray-500">生效策略：{approvalSummary(effectiveApprovalPolicy)}</p>
        </div>

        <div className="space-y-1">
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">沙盒策略</label>
          <select
            value={agent.sandboxPolicy?.type ?? ''}
            onChange={(e) => {
              const v = e.target.value;
              if (!v) {
                onFieldChange('sandboxPolicy', undefined);
                return;
              }
              const type = v as SandboxPolicy['type'];
              const nextPolicy =
                baseSecurityPolicy.sandboxPolicy.type === type
                  ? baseSecurityPolicy.sandboxPolicy
                  : defaultPolicyForType(type);
              onFieldChange('sandboxPolicy', nextPolicy);
            }}
            disabled={!isEditing}
            className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 disabled:bg-gray-100 dark:disabled:bg-gray-800"
          >
            <option value="">（默认：使用安全策略 - {sandboxSummary(baseSecurityPolicy.sandboxPolicy)}）</option>
            <option value="read-only">Read Only（只读）</option>
            <option value="workspace-write">Workspace Write（工作区可写）</option>
            <option value="danger-full-access">Full Access（完全访问）</option>
	          </select>
	          <p className="text-xs text-gray-500">
	            生效策略：{sandboxSummary(effectiveSandboxPolicy)}。Read Only 会禁用文本编辑（text_edit）与 PTY 交互式终端。
	          </p>
	        </div>

        <div className="space-y-1">
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">最大 Turn 数</label>
          <input
            type="number"
            min={1}
            value={agent.maxTurns ?? ''}
            onChange={(e) => {
              const v = e.target.value;
              if (!v) {
                onFieldChange('maxTurns', undefined);
                return;
              }
              const n = Number(v);
              onFieldChange('maxTurns', Number.isFinite(n) ? Math.max(1, Math.floor(n)) : undefined);
            }}
            disabled={!isEditing}
            placeholder="例如：10000"
            className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 disabled:bg-gray-100 dark:disabled:bg-gray-800"
          />
          <p className="text-xs text-gray-500">
            {supportsToolset
              ? 'Tool 类型会进行多 Turn 循环；未设置时后端默认 10000（所有类型一致）。'
              : '未设置时后端默认 10000（所有类型一致）。'}
          </p>
        </div>

        <div className="space-y-1">
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">描述</label>
          <input
            type="text"
            value={agent.description || ''}
            onChange={(e) => onFieldChange('description', e.target.value)}
            disabled={!isEditing}
            placeholder="简短描述这个智能体的用途"
            className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 disabled:bg-gray-100 dark:disabled:bg-gray-800"
          />
        </div>

        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">系统提示词</label>
            {agent.systemPrompt && (
              <button
                onClick={() => {
                  navigator.clipboard.writeText(agent.systemPrompt);
                }}
                className="flex items-center gap-1 px-2 py-1 text-xs text-gray-500 hover:text-blue-600 hover:bg-gray-100 dark:hover:bg-gray-700 rounded"
                title="复制系统提示词"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2" /><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" /></svg>
                复制
              </button>
            )}
          </div>
          <textarea
            value={agent.systemPrompt}
            onChange={(e) => onFieldChange('systemPrompt', e.target.value)}
            disabled={!isEditing}
            placeholder="设置 AI 的行为和角色..."
            rows={6}
            className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 disabled:bg-gray-100 dark:disabled:bg-gray-800 resize-none"
          />
        </div>

        <div className="space-y-1">
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">输出格式</label>
          <select
            value={agent.formatType}
            onChange={(e) => onFieldChange('formatType', e.target.value as FormatPromptType)}
            disabled={!isEditing}
            className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 disabled:bg-gray-100 dark:disabled:bg-gray-800"
          >
            {formatOptions.map(opt => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
          </select>
        </div>

        <div className="space-y-1">
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">思考回灌</label>
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={agent.reinjectThinking ?? false}
              onChange={(e) => onFieldChange('reinjectThinking', e.target.checked)}
              disabled={!isEditing}
              className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500 disabled:opacity-50"
            />
            <span className="text-sm text-gray-700 dark:text-gray-300">
              将 thinking 作为文本写入同一 Task 的下一轮上下文
            </span>
          </div>
          <p className="text-xs text-gray-500">
            默认关闭：thinking 只用于 UI/调试展示；开启会增加上下文长度，并可能影响模型输出风格。
          </p>
        </div>

        <div className="space-y-2">
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">Context 管理</label>
          <select
            value={contextPolicyType}
            onChange={(e) => {
              const v = e.target.value as typeof contextPolicyType;
              if (v === 'simple') {
                onFieldChange('contextPolicy', { type: 'simple', enabled: true, trimEnabled: true, hardLimitPercent: 90 });
                return;
              }
              if (v === 'normal_compact') {
                onFieldChange('contextPolicy', {
                  type: 'normal_compact',
                  enabled: true,
                  trimEnabled: true,
                  hardLimitPercent: 90,
                  compactEnabled: true,
                  autoCompact: true,
                  autoCompactThresholdPercent: 85,
                  keepLastMessages: 60,
                  maxSummaryTokens: 800,
                  maxCompactInputMessages: 400,
                });
                return;
              }
              onFieldChange('contextPolicy', { type: 'custom', name: 'custom', params: {} });
            }}
            disabled={!isEditing}
            className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 disabled:bg-gray-100 dark:disabled:bg-gray-800"
          >
            <option value="simple">Simple（不自动 compact）</option>
            <option value="normal_compact">Normal Compact（类 Codex）</option>
            <option value="custom">自定义（JSON 参数）</option>
          </select>

          {contextPolicyType === 'simple' && (
            <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 dark:border-gray-700 dark:bg-gray-900/30 space-y-3">
              <div className="flex items-center justify-between">
                <div className="text-sm font-medium text-gray-800 dark:text-gray-200">Simple</div>
                <label className="flex items-center gap-2 text-xs text-gray-700 dark:text-gray-300">
                  <input
                    type="checkbox"
                    checked={Boolean(effectiveSimplePolicy.enabled ?? true)}
                    onChange={(e) =>
                      onFieldChange('contextPolicy', {
                        ...effectiveSimplePolicy,
                        enabled: e.target.checked,
                      })
                    }
                    disabled={!isEditing}
                    className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500 disabled:opacity-50"
                  />
                  启用
                </label>
              </div>

              <div className="rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-900/40 space-y-2">
                <div className="flex items-center justify-between">
                  <div className="text-xs font-medium text-gray-700 dark:text-gray-300">硬裁剪（Trim）</div>
                  <label className="flex items-center gap-2 text-xs text-gray-700 dark:text-gray-300">
                    <input
                      type="checkbox"
                      checked={Boolean(effectiveSimplePolicy.trimEnabled ?? true)}
                      onChange={(e) =>
                        onFieldChange('contextPolicy', {
                          ...effectiveSimplePolicy,
                          trimEnabled: e.target.checked,
                        })
                      }
                      disabled={!isEditing || !(effectiveSimplePolicy.enabled ?? true)}
                      className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500 disabled:opacity-50"
                    />
                    启用硬裁剪
                  </label>
                </div>

                <div className="space-y-1">
                  <label className="block text-xs text-gray-600 dark:text-gray-400">硬上限（%）</label>
                  <input
                    type="number"
                    min={1}
                    max={99}
                    value={effectiveSimplePolicy.hardLimitPercent ?? 90}
                    onChange={(e) =>
                      onFieldChange('contextPolicy', {
                        ...effectiveSimplePolicy,
                        hardLimitPercent: Number(e.target.value || 90),
                      })
                    }
                    disabled={
                      !isEditing ||
                      !(effectiveSimplePolicy.enabled ?? true) ||
                      !(effectiveSimplePolicy.trimEnabled ?? true)
                    }
                    className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 disabled:bg-gray-100 dark:disabled:bg-gray-800 text-sm"
                  />
                  <div className="text-[11px] text-gray-500 dark:text-gray-400">
                    仅对本次请求的运行时 prompt 做裁剪，不会改写历史消息。
                  </div>
                </div>
              </div>
            </div>
          )}

          {contextPolicyType === 'normal_compact' && (
            <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 dark:border-gray-700 dark:bg-gray-900/30 space-y-3">
              <div className="flex items-center justify-between">
                <div className="text-sm font-medium text-gray-800 dark:text-gray-200">Normal Compact</div>
                <div className="flex items-center gap-2">
                  <label className="flex items-center gap-2 text-xs text-gray-700 dark:text-gray-300">
                    <input
                      type="checkbox"
                      checked={Boolean(normalCompactPolicy?.enabled ?? true)}
                      onChange={(e) =>
                        onFieldChange('contextPolicy', {
                          ...(normalCompactPolicy ?? { type: 'normal_compact' }),
                          enabled: e.target.checked,
                        })
                      }
                      disabled={!isEditing}
                      className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500 disabled:opacity-50"
                    />
                    启用
                  </label>
                </div>
              </div>

              <div className="space-y-3">
                {/* Trim (hard limit for runtime prompt; does NOT mutate history) */}
                <div className="rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-900/40 space-y-2">
                  <div className="flex items-center justify-between">
                    <div className="text-xs font-medium text-gray-700 dark:text-gray-300">硬裁剪（Trim）</div>
                    <label className="flex items-center gap-2 text-xs text-gray-700 dark:text-gray-300">
                      <input
                        type="checkbox"
                        checked={Boolean(normalCompactPolicy?.trimEnabled ?? true)}
                        onChange={(e) =>
                          onFieldChange('contextPolicy', {
                            ...(normalCompactPolicy ?? { type: 'normal_compact' }),
                            trimEnabled: e.target.checked,
                          })
                        }
                        disabled={!isEditing || !(normalCompactPolicy?.enabled ?? true)}
                        className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500 disabled:opacity-50"
                      />
                      启用硬裁剪
                    </label>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <label className="block text-xs text-gray-600 dark:text-gray-400">硬上限（%）</label>
                      <input
                        type="number"
                        min={1}
                        max={99}
                        value={normalCompactPolicy?.hardLimitPercent ?? 90}
                        onChange={(e) =>
                          onFieldChange('contextPolicy', {
                            ...(normalCompactPolicy ?? { type: 'normal_compact' }),
                            hardLimitPercent: Number(e.target.value || 90),
                          })
                        }
                        disabled={
                          !isEditing ||
                          !(normalCompactPolicy?.enabled ?? true) ||
                          !(normalCompactPolicy?.trimEnabled ?? true)
                        }
                        className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 disabled:bg-gray-100 dark:disabled:bg-gray-800 text-sm"
                      />
                      <p className="text-xs text-gray-500">
                        仅影响本次请求的 runtime prompt：会删除更老的非 system 消息，避免超窗；不会改写历史。
                      </p>
                    </div>
                  </div>
                </div>

                {/* Compaction (rewrite older history into a summary message) */}
                <div className="rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-900/40 space-y-2">
                  <div className="flex items-center justify-between">
                    <div className="text-xs font-medium text-gray-700 dark:text-gray-300">历史压缩（Compact）</div>
                    <div className="flex items-center gap-3">
                      <label className="flex items-center gap-2 text-xs text-gray-700 dark:text-gray-300">
                        <input
                          type="checkbox"
                          checked={Boolean(normalCompactPolicy?.compactEnabled ?? true)}
                          onChange={(e) =>
                            onFieldChange('contextPolicy', {
                              ...(normalCompactPolicy ?? { type: 'normal_compact' }),
                              compactEnabled: e.target.checked,
                            })
                          }
                          disabled={!isEditing || !(normalCompactPolicy?.enabled ?? true)}
                          className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500 disabled:opacity-50"
                        />
                        启用 compact
                      </label>
                      <label className="flex items-center gap-2 text-xs text-gray-700 dark:text-gray-300">
                        <input
                          type="checkbox"
                          checked={Boolean(normalCompactPolicy?.autoCompact ?? true)}
                          onChange={(e) =>
                            onFieldChange('contextPolicy', {
                              ...(normalCompactPolicy ?? { type: 'normal_compact' }),
                              autoCompact: e.target.checked,
                            })
                          }
                          disabled={
                            !isEditing ||
                            !(normalCompactPolicy?.enabled ?? true) ||
                            !(normalCompactPolicy?.compactEnabled ?? true)
                          }
                          className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500 disabled:opacity-50"
                        />
                        自动 compact
                      </label>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <label className="block text-xs text-gray-600 dark:text-gray-400">触发阈值（%）</label>
                      <input
                        type="number"
                        min={1}
                        max={99}
                        value={normalCompactPolicy?.autoCompactThresholdPercent ?? 85}
                        onChange={(e) =>
                          onFieldChange('contextPolicy', {
                            ...(normalCompactPolicy ?? { type: 'normal_compact' }),
                            autoCompactThresholdPercent: Number(e.target.value || 85),
                          })
                        }
                        disabled={
                          !isEditing ||
                          !(normalCompactPolicy?.enabled ?? true) ||
                          !(normalCompactPolicy?.compactEnabled ?? true) ||
                          !(normalCompactPolicy?.autoCompact ?? true)
                        }
                        className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 disabled:bg-gray-100 dark:disabled:bg-gray-800 text-sm"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="block text-xs text-gray-600 dark:text-gray-400">保留最近消息数</label>
                      <input
                        type="number"
                        min={5}
                        max={200}
                        value={normalCompactPolicy?.keepLastMessages ?? 60}
                        onChange={(e) =>
                          onFieldChange('contextPolicy', {
                            ...(normalCompactPolicy ?? { type: 'normal_compact' }),
                            keepLastMessages: Number(e.target.value || 60),
                          })
                        }
                        disabled={
                          !isEditing ||
                          !(normalCompactPolicy?.enabled ?? true) ||
                          !(normalCompactPolicy?.compactEnabled ?? true)
                        }
                        className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 disabled:bg-gray-100 dark:disabled:bg-gray-800 text-sm"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="block text-xs text-gray-600 dark:text-gray-400">摘要 max_tokens</label>
                      <input
                        type="number"
                        min={64}
                        max={4096}
                        value={normalCompactPolicy?.maxSummaryTokens ?? 800}
                        onChange={(e) =>
                          onFieldChange('contextPolicy', {
                            ...(normalCompactPolicy ?? { type: 'normal_compact' }),
                            maxSummaryTokens: Number(e.target.value || 800),
                          })
                        }
                        disabled={
                          !isEditing ||
                          !(normalCompactPolicy?.enabled ?? true) ||
                          !(normalCompactPolicy?.compactEnabled ?? true)
                        }
                        className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 disabled:bg-gray-100 dark:disabled:bg-gray-800 text-sm"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="block text-xs text-gray-600 dark:text-gray-400">compact 输入消息上限</label>
                      <input
                        type="number"
                        min={50}
                        max={5000}
                        value={normalCompactPolicy?.maxCompactInputMessages ?? 400}
                        onChange={(e) =>
                          onFieldChange('contextPolicy', {
                            ...(normalCompactPolicy ?? { type: 'normal_compact' }),
                            maxCompactInputMessages: Number(e.target.value || 400),
                          })
                        }
                        disabled={
                          !isEditing ||
                          !(normalCompactPolicy?.enabled ?? true) ||
                          !(normalCompactPolicy?.compactEnabled ?? true)
                        }
                        className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 disabled:bg-gray-100 dark:disabled:bg-gray-800 text-sm"
                      />
                    </div>
                  </div>

                  <p className="text-xs text-gray-500">
                    compact 不会删除原始历史：后端会新增一条摘要消息，并在构建 runtime prompt 时优先使用摘要来跳过更早消息；随后本次请求仍会按硬上限做裁剪以避免超窗。
                  </p>
                </div>
              </div>
            </div>
          )}

          {contextPolicyType === 'custom' && (
            <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 dark:border-gray-700 dark:bg-gray-900/30 space-y-2">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="block text-xs text-gray-600 dark:text-gray-400">策略名</label>
                  <input
                    type="text"
                    value={customPolicy?.name ?? 'custom'}
                    onChange={(e) =>
                      onFieldChange('contextPolicy', {
                        ...(customPolicy ?? { type: 'custom', params: {} }),
                        name: e.target.value || 'custom',
                      })
                    }
                    disabled={!isEditing}
                    className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 disabled:bg-gray-100 dark:disabled:bg-gray-800 text-sm"
                  />
                </div>
                <div className="space-y-1">
                  <label className="block text-xs text-gray-600 dark:text-gray-400">参数（JSON）</label>
                  <button
                    type="button"
                    onClick={() => {
                      setCustomParamsText('{}');
                      setCustomParamsError(null);
                      onFieldChange('contextPolicy', {
                        ...(customPolicy ?? { type: 'custom', name: 'custom' }),
                        params: {},
                      });
                    }}
                    disabled={!isEditing}
                    className="w-full rounded-lg border border-gray-200 px-3 py-2 text-xs text-gray-600 hover:bg-gray-100 disabled:opacity-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
                    title="重置 params"
                  >
                    重置 params
                  </button>
                </div>
              </div>
              <textarea
                value={customParamsText}
                onChange={(e) => {
                  setCustomParamsText(e.target.value);
                  setCustomParamsError(null);
                }}
                onBlur={() => {
                  try {
                    const parsed = JSON.parse(customParamsText || '{}');
                    setCustomParamsError(null);
                    onFieldChange('contextPolicy', {
                      ...(customPolicy ?? { type: 'custom', name: 'custom' }),
                      params: parsed,
                    });
                  } catch (err) {
                    setCustomParamsError('JSON 格式不合法，未保存（请修正后再失焦）');
                  }
                }}
                disabled={!isEditing}
                rows={6}
                className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 disabled:bg-gray-100 dark:disabled:bg-gray-800 font-mono text-xs"
              />
              {customParamsError && (
                <div className="text-xs text-red-600 dark:text-red-300">{customParamsError}</div>
              )}
              <p className="text-xs text-gray-500">
                自定义策略目前仅做“配置落盘”，后端会忽略未知策略（为未来扩展保留）。
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default AgentConfigForm;
