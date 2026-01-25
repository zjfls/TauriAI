/**
 * ToolsConfigForm Component
 * Configure tool system (permissions + toolsets)
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Plus, Search, Trash2 } from 'lucide-react';
import { useConfigStore } from '../../stores/configStore';
import type { AppConfig, ToolSetConfig } from '../../types';

const AVAILABLE_TOOLS = [
  { name: 'echo', label: 'Echo', description: '回显输入（测试用）' },
  { name: 'get_time', label: '时间', description: '获取当前时间（测试用）' },
  { name: 'read_file', label: '读文件', description: '读取本地文件（带行号）' },
  { name: 'list_dir', label: '列目录', description: '列出目录结构（带缩进）' },
  { name: 'rg', label: 'rg', description: '按 pattern 搜索文件（ripgrep）' },
  { name: 'shell_command', label: 'Shell 命令', description: '一次性执行命令', permission: 'shellExec' },
  { name: 'exec_command', label: 'PTY 启动命令', description: '创建交互式会话', permission: 'ptyExec' },
  { name: 'write_stdin', label: 'PTY 写入输入', description: '向交互式会话写入 stdin', permission: 'ptyExec' },
] as const;

type ToolPermissionKey = 'shellExec' | 'ptyExec';

const toggleInList = (list: string[], value: string) =>
  list.includes(value) ? list.filter((x) => x !== value) : [...list, value];

export const ToolsConfigForm: React.FC = () => {
  const { config, saveConfig } = useConfigStore();
  const [selectedToolsetName, setSelectedToolsetName] = useState<string | null>(null);
  const [editingToolset, setEditingToolset] = useState<ToolSetConfig | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  const toolsets = config?.tools?.toolsets ?? [];

  const filteredToolsets = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return toolsets;
    return toolsets.filter((t) => t.name.toLowerCase().includes(q));
  }, [toolsets, searchQuery]);

  useEffect(() => {
    if (isCreating) return;
    if (filteredToolsets.length === 0) return;
    if (selectedToolsetName) return;
    setSelectedToolsetName(filteredToolsets[0].name);
  }, [filteredToolsets, selectedToolsetName, isCreating]);

  if (!config) {
    return (
      <div className="flex items-center justify-center h-64">
        <p className="text-gray-500 dark:text-gray-400">加载配置中...</p>
      </div>
    );
  }

  const save = (updatedConfig: AppConfig) => {
    saveConfig(updatedConfig);
  };

  const handleEnabledChange = (enabled: boolean) => {
    save({
      ...config,
      tools: { ...config.tools, enabled },
    });
  };

  const handlePermissionChange = (key: ToolPermissionKey, value: boolean) => {
    save({
      ...config,
      tools: {
        ...config.tools,
        permissions: { ...config.tools.permissions, [key]: value },
      },
    });
  };

  const handleSelectToolset = (name: string) => {
    setSelectedToolsetName(name);
    setEditingToolset(null);
    setIsCreating(false);
  };

  const handleCreateToolset = () => {
    setIsCreating(true);
    setSelectedToolsetName(null);
    setEditingToolset({
      name: `toolset_${Date.now()}`,
      tools: [],
      persistanceShellEnhance: false,
    });
  };

  const handleEditToolset = () => {
    if (!selectedToolsetName) return;
    const toolset = toolsets.find((t) => t.name === selectedToolsetName);
    if (!toolset) return;
    setEditingToolset({ ...toolset, tools: [...toolset.tools] });
    setIsCreating(false);
  };

  const handleCancelEdit = () => {
    setEditingToolset(null);
    setIsCreating(false);
  };

  const handleSaveToolset = () => {
    if (!editingToolset) return;
    const name = editingToolset.name.trim();
    if (!name) return;

    const originalName = isCreating ? null : selectedToolsetName;
    const nameChanged = originalName && originalName !== name;

    const nameConflicts = toolsets.some((t) => t.name === name && t.name !== originalName);
    if (nameConflicts) {
      alert('Toolset 名称已存在，请换一个名称');
      return;
    }

    const normalizedTools = Array.from(new Set(editingToolset.tools));
    const persistanceShellEnhance = Boolean(editingToolset.persistanceShellEnhance);

    const nextToolsets = (() => {
      if (isCreating) {
        return [...toolsets, { name, tools: normalizedTools, persistanceShellEnhance }];
      }
      return toolsets.map((t) =>
        t.name === originalName
          ? { ...t, name, tools: normalizedTools, persistanceShellEnhance }
          : t
      );
    })();

    const nextAgents = nameChanged
      ? config.agents.map((a) => (a.toolset === originalName ? { ...a, toolset: name } : a))
      : config.agents;

    save({
      ...config,
      tools: { ...config.tools, toolsets: nextToolsets },
      agents: nextAgents,
    });

    setEditingToolset(null);
    setIsCreating(false);
    setSelectedToolsetName(name);
  };

  const handleDeleteToolset = () => {
    if (!selectedToolsetName) return;
    if (!confirm(`确定要删除 toolset「${selectedToolsetName}」吗？相关智能体会自动取消绑定。`)) return;

    const nextToolsets = toolsets.filter((t) => t.name !== selectedToolsetName);
    const nextAgents = config.agents.map((a) =>
      a.toolset === selectedToolsetName ? { ...a, toolset: undefined } : a
    );

    save({
      ...config,
      tools: { ...config.tools, toolsets: nextToolsets },
      agents: nextAgents,
    });

    setEditingToolset(null);
    setIsCreating(false);
    setSelectedToolsetName(nextToolsets[0]?.name ?? null);
  };

  const currentToolset = editingToolset ?? toolsets.find((t) => t.name === selectedToolsetName) ?? null;
  const isEditing = Boolean(editingToolset);

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
              onClick={() => handleSelectToolset(toolset.name)}
              className={`flex items-center justify-between px-3 py-2 rounded-lg cursor-pointer transition-colors ${
                selectedToolsetName === toolset.name && !isCreating
                  ? 'bg-blue-100 dark:bg-blue-900/50'
                  : 'hover:bg-gray-100 dark:hover:bg-gray-700'
              }`}
            >
              <span className="text-sm truncate">{toolset.name}</span>
              <span className="text-xs text-gray-500">{toolset.tools.length}</span>
            </div>
          ))}
          {isCreating && (
            <div className="px-3 py-2 rounded-lg bg-blue-100 dark:bg-blue-900/50 text-sm">新建 toolset</div>
          )}
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
          {/* Global tool settings */}
          <div className="space-y-4">
            <h2 className="text-lg font-semibold text-gray-800 dark:text-white">工具设置</h2>

            <div className="flex items-center justify-between">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">启用工具系统</label>
                <p className="text-xs text-gray-500">关闭后，Tool 智能体不会向模型发送工具定义，也不会执行工具调用。</p>
              </div>
              <button
                onClick={() => handleEnabledChange(!config.tools.enabled)}
                className={`relative w-11 h-6 rounded-full transition-colors ${
                  config.tools.enabled ? 'bg-blue-600' : 'bg-gray-300 dark:bg-gray-600'
                }`}
              >
                <span
                  className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${
                    config.tools.enabled ? 'translate-x-5' : ''
                  }`}
                />
              </button>
            </div>

            <div className="pt-3 border-t border-gray-200 dark:border-gray-700 space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">允许执行 Shell 命令</label>
                  <p className="text-xs text-gray-500">开启后才会暴露 `shell_command`。</p>
                </div>
                <button
                  onClick={() => handlePermissionChange('shellExec', !config.tools.permissions.shellExec)}
                  className={`relative w-11 h-6 rounded-full transition-colors ${
                    config.tools.permissions.shellExec ? 'bg-blue-600' : 'bg-gray-300 dark:bg-gray-600'
                  }`}
                >
                  <span
                    className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${
                      config.tools.permissions.shellExec ? 'translate-x-5' : ''
                    }`}
                  />
                </button>
              </div>

              <div className="flex items-center justify-between">
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">允许 PTY 交互执行</label>
                  <p className="text-xs text-gray-500">开启后才会暴露 `exec_command` / `write_stdin`。</p>
                </div>
                <button
                  onClick={() => handlePermissionChange('ptyExec', !config.tools.permissions.ptyExec)}
                  className={`relative w-11 h-6 rounded-full transition-colors ${
                    config.tools.permissions.ptyExec ? 'bg-blue-600' : 'bg-gray-300 dark:bg-gray-600'
                  }`}
                >
                  <span
                    className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${
                      config.tools.permissions.ptyExec ? 'translate-x-5' : ''
                    }`}
                  />
                </button>
              </div>
            </div>
          </div>

          {/* Toolset editor */}
          <div className="pt-3 border-t border-gray-200 dark:border-gray-700">
            {!currentToolset ? (
              <div className="py-10 text-center text-gray-500 dark:text-gray-400">
                请选择一个 toolset，或点击左侧“添加 toolset”
              </div>
            ) : (
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <h3 className="text-base font-semibold text-gray-800 dark:text-white">Toolset</h3>
                    {!isEditing && (
                      <span className="text-xs text-gray-500">
                        {currentToolset.tools.length} 个工具
                      </span>
                    )}
                  </div>

                  <div className="flex items-center gap-2">
                    {isEditing ? (
                      <>
                        <button
                          onClick={handleCancelEdit}
                          className="px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg"
                        >
                          取消
                        </button>
                        <button
                          onClick={handleSaveToolset}
                          className="px-3 py-1.5 text-sm bg-blue-600 text-white hover:bg-blue-700 rounded-lg"
                        >
                          保存
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          onClick={handleEditToolset}
                          className="px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg"
                        >
                          编辑
                        </button>
                        <button
                          onClick={handleDeleteToolset}
                          className="px-3 py-1.5 text-sm text-red-600 hover:bg-red-50 dark:hover:bg-red-900/30 rounded-lg flex items-center gap-1"
                        >
                          <Trash2 size={14} />
                          删除
                        </button>
                      </>
                    )}
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-1">
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">名称</label>
                    <input
                      type="text"
                      value={currentToolset.name}
                      onChange={(e) => setEditingToolset({ ...(currentToolset as ToolSetConfig), name: e.target.value })}
                      disabled={!isEditing}
                      className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 disabled:bg-gray-100 dark:disabled:bg-gray-800"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">工具数量</label>
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
                        允许跨任务保留 PTY 会话，并在聊天页显示“持久进程”面板（仅当 toolset 开启时才会影响模型侧工具定义）。
                      </p>
                    </div>
                    <button
                      type="button"
                      disabled={!isEditing}
                      onClick={() => {
                        setEditingToolset({
                          ...(currentToolset as ToolSetConfig),
                          persistanceShellEnhance: !Boolean(currentToolset.persistanceShellEnhance),
                        });
                      }}
                      className={`relative w-11 h-6 rounded-full transition-colors ${
                        Boolean(currentToolset.persistanceShellEnhance)
                          ? 'bg-blue-600'
                          : 'bg-gray-300 dark:bg-gray-600'
                      } disabled:opacity-60 disabled:cursor-not-allowed`}
                      title={Boolean(currentToolset.persistanceShellEnhance) ? '已开启' : '已关闭'}
                    >
                      <span
                        className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${
                          Boolean(currentToolset.persistanceShellEnhance) ? 'translate-x-5' : ''
                        }`}
                      />
                    </button>
                  </div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">包含工具</label>
                  <div className="space-y-2 rounded-lg border border-gray-200 dark:border-gray-700 p-3 bg-white dark:bg-gray-800">
                    {AVAILABLE_TOOLS.map((tool) => {
                      const checked = currentToolset.tools.includes(tool.name);
                      const permission = (tool as { permission?: ToolPermissionKey }).permission;
                      const permissionEnabled =
                        !permission || (config.tools.permissions as Record<ToolPermissionKey, boolean>)[permission];

                      return (
                        <label key={tool.name} className="flex items-start gap-3">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => {
                              const nextTools = toggleInList(currentToolset.tools, tool.name);
                              setEditingToolset({ ...(currentToolset as ToolSetConfig), tools: nextTools });
                            }}
                            disabled={!isEditing}
                            className="mt-1"
                          />
                          <div className="flex-1">
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-mono text-gray-800 dark:text-gray-100">{tool.name}</span>
                              {!permissionEnabled && (
                                <span className="text-xs text-orange-600 bg-orange-50 dark:bg-orange-900/30 dark:text-orange-300 px-2 py-0.5 rounded">
                                  需要开启权限
                                </span>
                              )}
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
                    提示：工具是否真正“可用”，还取决于上面的权限开关，以及当前智能体是否为 Tool 类型。
                  </p>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default ToolsConfigForm;
