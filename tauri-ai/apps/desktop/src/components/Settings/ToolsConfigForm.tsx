/**
 * ToolsConfigForm Component
 * Configure tool system (toolsets)
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Plus, Search, Trash2, Copy } from 'lucide-react';
import { useConfigStore } from '../../stores/configStore';
import type { AppConfig, ToolSetConfig } from '../../types';

const AVAILABLE_TOOLS = [
  { name: 'echo', label: 'Echo', description: '回显输入（测试用）' },
  { name: 'get_time', label: '时间', description: '获取当前时间（测试用）' },
  { name: 'read_file', label: '读文件', description: '读取本地文件（带行号）' },
  { name: 'list_dir', label: '列目录', description: '列出目录结构（带缩进）' },
  { name: 'rg', label: 'rg', description: '按 pattern 搜索文件（ripgrep）' },
  { name: 'text_edit', label: '文本编辑（抽象）', description: '抽象文本编辑能力：由模型的 textEditImplementation 选择实现（默认 apply_patch）' },
  { name: 'apply_patch', label: 'Apply Patch', description: '按补丁格式修改/创建文件' },
  { name: 'apply_patch_unified_diff', label: 'Apply Patch (Unified Diff)', description: '按 unified diff 块头应用补丁（仅 @@ -a,b +c,d @@）' },
  { name: 'write_file', label: 'Write File', description: '写入/覆写一个文本文件（提供完整内容）' },
  { name: 'replace_string', label: 'Replace String', description: '在文件中做一次精确字符串替换（old_string 必须唯一命中 1 次）' },
  { name: 'shell_command', label: 'Shell 命令', description: '一次性执行命令' },
  { name: 'exec_command', label: 'PTY 启动命令', description: '创建交互式会话' },
  { name: 'write_stdin', label: 'PTY 写入输入', description: '向交互式会话写入 stdin' },
] as const;

const toggleInList = (list: string[], value: string) =>
  list.includes(value) ? list.filter((x) => x !== value) : [...list, value];

const nextUniqueToolsetName = (existing: Set<string>, baseName: string) => {
  const cleanedBase = baseName.trim() || 'toolset';
  let candidate = `${cleanedBase}_copy`;
  let i = 2;
  while (existing.has(candidate)) {
    candidate = `${cleanedBase}_copy${i}`;
    i += 1;
  }
  return candidate;
};

export const ToolsConfigForm: React.FC = () => {
  const { config, saveConfigDebounced } = useConfigStore();
  const [selectedToolsetName, setSelectedToolsetName] = useState<string | null>(null);
  const [toolsetNameDraft, setToolsetNameDraft] = useState('');
  const [searchQuery, setSearchQuery] = useState('');

  const toolsets = config?.tools?.toolsets ?? [];

  const filteredToolsets = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return toolsets;
    return toolsets.filter((t) => t.name.toLowerCase().includes(q));
  }, [toolsets, searchQuery]);

  useEffect(() => {
    if (!config) return;
    if (toolsets.length === 0) {
      setSelectedToolsetName(null);
      return;
    }
    if (selectedToolsetName && toolsets.some((t) => t.name === selectedToolsetName)) return;
    setSelectedToolsetName(toolsets[0].name);
  }, [config, toolsets, selectedToolsetName]);

  useEffect(() => {
    setToolsetNameDraft(selectedToolsetName ?? '');
  }, [selectedToolsetName]);

  if (!config) {
    return (
      <div className="flex items-center justify-center h-64">
        <p className="text-gray-500 dark:text-gray-400">加载配置中...</p>
      </div>
    );
  }

  const save = (updatedConfig: AppConfig) => saveConfigDebounced(updatedConfig);

  const currentToolset = toolsets.find((t) => t.name === selectedToolsetName) ?? null;

  const updateToolset = (name: string, updater: (t: ToolSetConfig) => ToolSetConfig) => {
    const target = toolsets.find((t) => t.name === name);
    if (!target) return;
    const nextToolsets = toolsets.map((t) => (t.name === name ? updater(t) : t));
    save({ ...config, tools: { ...config.tools, toolsets: nextToolsets } });
  };

  const commitRename = () => {
    if (!selectedToolsetName) return;
    const nextName = toolsetNameDraft.trim();
    if (!nextName) {
      setToolsetNameDraft(selectedToolsetName);
      return;
    }
    if (nextName === selectedToolsetName) return;

    const nameConflicts = toolsets.some((t) => t.name === nextName);
    if (nameConflicts) {
      alert('Toolset 名称已存在，请换一个名称');
      setToolsetNameDraft(selectedToolsetName);
      return;
    }

    const nextToolsets = toolsets.map((t) =>
      t.name === selectedToolsetName ? { ...t, name: nextName } : t
    );
    const nextAgents = config.agents.map((a) =>
      a.toolset === selectedToolsetName ? { ...a, toolset: nextName } : a
    );

    save({ ...config, tools: { ...config.tools, toolsets: nextToolsets }, agents: nextAgents });
    setSelectedToolsetName(nextName);
  };

  const handleCreateToolset = () => {
    const existing = new Set(toolsets.map((t) => t.name));
    const base = `toolset_${Date.now()}`;
    let name = base;
    let i = 2;
    while (existing.has(name)) {
      name = `${base}_${i}`;
      i += 1;
    }

    const created: ToolSetConfig = { name, tools: [], persistanceShellEnhance: false };
    save({ ...config, tools: { ...config.tools, toolsets: [...toolsets, created] } });
    setSelectedToolsetName(name);
  };

  const handleDuplicateToolset = () => {
    if (!selectedToolsetName) return;
    const toolset = toolsets.find((t) => t.name === selectedToolsetName);
    if (!toolset) return;

    const existing = new Set(toolsets.map((t) => t.name));
    const duplicated: ToolSetConfig = {
      ...toolset,
      name: nextUniqueToolsetName(existing, toolset.name),
      tools: [...toolset.tools],
      persistanceShellEnhance: Boolean(toolset.persistanceShellEnhance),
    };

    save({ ...config, tools: { ...config.tools, toolsets: [...toolsets, duplicated] } });
    setSelectedToolsetName(duplicated.name);
  };

  const handleDeleteToolset = () => {
    if (!selectedToolsetName) return;
    if (
      !confirm(`确定要删除 toolset「${selectedToolsetName}」吗？相关智能体会自动取消绑定。`)
    )
      return;

    const nextToolsets = toolsets.filter((t) => t.name !== selectedToolsetName);
    const nextAgents = config.agents.map((a) =>
      a.toolset === selectedToolsetName ? { ...a, toolset: undefined } : a
    );

    save({ ...config, tools: { ...config.tools, toolsets: nextToolsets }, agents: nextAgents });
    setSelectedToolsetName(nextToolsets[0]?.name ?? null);
  };

  return (
    <div className="flex gap-6 h-full">
      {/* Toolset List */}
      <div className="w-64 flex-shrink-0 flex flex-col">
        <div className="mb-3">
          <div className="relative">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              type="text"
              placeholder="搜索 toolset..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-9 pr-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-sm"
            />
          </div>
        </div>

        <div className="flex-1 space-y-1 overflow-auto">
          {filteredToolsets.map((toolset) => (
            <div
              key={toolset.name}
              onClick={() => setSelectedToolsetName(toolset.name)}
              className={`flex items-center justify-between px-3 py-2 rounded-lg cursor-pointer transition-colors ${
                selectedToolsetName === toolset.name
                  ? 'bg-blue-100 dark:bg-blue-900/50'
                  : 'hover:bg-gray-100 dark:hover:bg-gray-700'
              }`}
            >
              <span className="text-sm truncate">{toolset.name}</span>
              <span className="text-xs text-gray-500">{toolset.tools.length}</span>
            </div>
          ))}
        </div>

        <button
          onClick={handleCreateToolset}
          className="mt-3 flex items-center justify-center gap-2 w-full py-2 rounded-lg border-2 border-dashed border-gray-300 dark:border-gray-600 text-gray-500 hover:border-blue-500 hover:text-blue-500 transition-colors"
        >
          <Plus size={16} />
          <span className="text-sm">添加 toolset</span>
        </button>
      </div>

      {/* Right Panel */}
      <div className="flex-1 overflow-auto">
        <div className="max-w-2xl space-y-6">
          {!currentToolset ? (
            <div className="py-10 text-center text-gray-500 dark:text-gray-400">
              请选择一个 toolset，或点击左侧“添加 toolset”。
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <h3 className="text-base font-semibold text-gray-800 dark:text-white">Toolset</h3>
                  <span className="text-xs text-gray-500">{currentToolset.tools.length} 个工具</span>
                </div>

                <div className="flex items-center gap-2">
                  <span className="px-2 text-xs text-gray-500 dark:text-gray-400">自动保存</span>
                  <button
                    onClick={handleDuplicateToolset}
                    className="px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg flex items-center gap-1"
                    title="复制 toolset"
                  >
                    <Copy size={14} />
                    复制
                  </button>
                  <button
                    onClick={handleDeleteToolset}
                    className="px-3 py-1.5 text-sm text-red-600 hover:bg-red-50 dark:hover:bg-red-900/30 rounded-lg flex items-center gap-1"
                  >
                    <Trash2 size={14} />
                    删除
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1">
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                    名称
                  </label>
                  <input
                    type="text"
                    value={toolsetNameDraft}
                    onChange={(e) => setToolsetNameDraft(e.target.value)}
                    onBlur={commitRename}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        commitRename();
                        (e.target as HTMLInputElement).blur();
                      }
                      if (e.key === 'Escape') {
                        e.preventDefault();
                        setToolsetNameDraft(selectedToolsetName ?? '');
                        (e.target as HTMLInputElement).blur();
                      }
                    }}
                    className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700"
                  />
                  <p className="text-xs text-gray-500">
                    提示：回车/失焦应用重命名（会同步更新绑定此 toolset 的智能体）
                  </p>
                </div>
                <div className="space-y-1">
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                    工具数量
                  </label>
                  <div className="px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 text-sm text-gray-600 dark:text-gray-300">
                    {currentToolset.tools.length}
                  </div>
                </div>
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                      持久进程
                    </label>
                    <p className="text-xs text-gray-500">
                      允许跨任务保留 PTY 会话，并在聊天页显示“持久进程”面板（仅当 toolset
                      显式开启时才会影响模型侧工具定义）。
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      updateToolset(currentToolset.name, (t) => ({
                        ...t,
                        persistanceShellEnhance: !Boolean(t.persistanceShellEnhance),
                      }));
                    }}
                    className={`relative w-11 h-6 rounded-full transition-colors ${
                      Boolean(currentToolset.persistanceShellEnhance)
                        ? 'bg-blue-600'
                        : 'bg-gray-300 dark:bg-gray-600'
                    }`}
                    title={Boolean(currentToolset.persistanceShellEnhance) ? '已开启' : '已关闭'}
                  >
                    <span
                      className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${
                        Boolean(currentToolset.persistanceShellEnhance) ? 'translate-x-5' : ''
                      }`}
                    />
                  </button>
                </div>

                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                  包含工具
                </label>
                <div className="space-y-2 rounded-lg border border-gray-200 dark:border-gray-700 p-3 bg-white dark:bg-gray-800">
                  {AVAILABLE_TOOLS.map((tool) => {
                    const checked = currentToolset.tools.includes(tool.name);
                    return (
                      <label key={tool.name} className="flex items-start gap-3">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => {
                            let nextTools = toggleInList(currentToolset.tools, tool.name);

                            // 抽象文本编辑：toolset 里只保留 `text_edit`，具体实现由“模型配置”决定。
                            const TEXT_EDIT = 'text_edit';
                            const concreteEditTools = new Set([
                              'apply_patch',
                              'apply_patch_unified_diff',
                              'write_file',
                              'replace_string',
                            ]);

                            if (nextTools.includes(TEXT_EDIT)) {
                              // 当开启抽象文本编辑时，移除底层具体实现开关，避免用户误解“同时开启多个”。
                              nextTools = nextTools.filter((t) => t === TEXT_EDIT || !concreteEditTools.has(t));
                            } else if (concreteEditTools.has(tool.name) && nextTools.includes(tool.name)) {
                              // 用户显式开启具体实现时，关闭抽象开关（更直觉：显式优先）。
                              nextTools = nextTools.filter((t) => t !== TEXT_EDIT);
                            }

                            // apply_patch 工具互斥：一个 toolset 最多只能启用一个。
                            // - apply_patch：自定义锚定头（@@ <原文>）
                            // - apply_patch_unified_diff：unified diff 头（@@ -a,b +c,d @@）
                            if (nextTools.includes('apply_patch') && nextTools.includes('apply_patch_unified_diff')) {
                              const customIdx = nextTools.indexOf('apply_patch');
                              const unifiedIdx = nextTools.indexOf('apply_patch_unified_diff');
                              const drop = customIdx < unifiedIdx ? 'apply_patch_unified_diff' : 'apply_patch';
                              nextTools = nextTools.filter((t) => t !== drop);
                            }
                            updateToolset(currentToolset.name, (t) => ({
                              ...t,
                              tools: Array.from(new Set(nextTools)),
                            }));
                          }}
                          className="mt-1"
                        />
                        <div className="flex-1">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-mono text-gray-800 dark:text-gray-100">
                              {tool.name}
                            </span>
                          </div>
                          <div className="text-xs text-gray-500">
                            {tool.label} · {tool.description}
                          </div>
                        </div>
                      </label>
                    );
                  })}
                </div>
                <p className="text-xs text-gray-500">
                  提示：工具是否真正“可用”，还取决于当前智能体类型与安全策略（read-only 会拒绝写入/PTY 等）。
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default ToolsConfigForm;
