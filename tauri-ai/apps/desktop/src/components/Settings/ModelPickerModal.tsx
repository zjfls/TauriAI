/**
 * ModelPickerModal Component
 * Modal for fetching and selecting models from provider API
 */

import React, { useState, useEffect, useMemo } from 'react';
import { X, Search, Plus, Check, Loader2, RefreshCw, ChevronDown, ChevronRight } from 'lucide-react';
import { fetchProviderModels, type ModelInfo } from '../../services/configService';
import type { Provider } from '../../types';

interface ModelPickerModalProps {
  provider: Provider;
  onClose: () => void;
  onAddModels: (modelNames: string[]) => void;
}

// Group models by prefix (e.g., "qwen3-235b" from "qwen3-235b-a22b-instruct")
function groupModels(models: ModelInfo[]): Map<string, ModelInfo[]> {
  const groups = new Map<string, ModelInfo[]>();
  
  for (const model of models) {
    // Extract group name from model id
    const parts = model.id.split(/[-_]/);
    let groupName = parts[0];
    
    // Try to include version number in group name
    if (parts.length > 1 && /^v?\d/.test(parts[1])) {
      groupName = `${parts[0]}-${parts[1]}`;
    }
    
    if (!groups.has(groupName)) {
      groups.set(groupName, []);
    }
    groups.get(groupName)!.push(model);
  }
  
  return groups;
}

export const ModelPickerModal: React.FC<ModelPickerModalProps> = ({
  provider,
  onClose,
  onAddModels,
}) => {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedModels, setSelectedModels] = useState<Set<string>>(new Set());
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());

  // Models already added to provider
  const existingModels = useMemo(() => new Set(provider.models.map(m => m.name)), [provider.models]);

  const fetchModels = async () => {
    setLoading(true);
    setError('');
    try {
      const result = await fetchProviderModels(provider.type, provider.apiBase, provider.apiKey);
      setModels(result);
      // Expand all groups by default
      const groups = groupModels(result);
      setExpandedGroups(new Set(groups.keys()));
    } catch (e) {
      setError(e instanceof Error ? e.message : '获取模型失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchModels();
  }, []);

  // Filter and group models
  const filteredModels = useMemo(() => {
    if (!searchQuery.trim()) return models;
    const query = searchQuery.toLowerCase();
    return models.filter(m => m.id.toLowerCase().includes(query));
  }, [models, searchQuery]);

  const groupedModels = useMemo(() => groupModels(filteredModels), [filteredModels]);

  const toggleGroup = (groupName: string) => {
    const newExpanded = new Set(expandedGroups);
    if (newExpanded.has(groupName)) {
      newExpanded.delete(groupName);
    } else {
      newExpanded.add(groupName);
    }
    setExpandedGroups(newExpanded);
  };

  const toggleModel = (modelId: string) => {
    const newSelected = new Set(selectedModels);
    if (newSelected.has(modelId)) {
      newSelected.delete(modelId);
    } else {
      newSelected.add(modelId);
    }
    setSelectedModels(newSelected);
  };

  const addSingleModel = (modelId: string) => {
    onAddModels([modelId]);
  };

  const addSelectedModels = () => {
    onAddModels(Array.from(selectedModels));
  };

  const selectAllInGroup = (groupName: string) => {
    const groupModels = groupedModels.get(groupName) || [];
    const newSelected = new Set(selectedModels);
    const availableModels = groupModels.filter(m => !existingModels.has(m.id));
    
    // If all available are selected, deselect all; otherwise select all
    const allSelected = availableModels.every(m => newSelected.has(m.id));
    if (allSelected) {
      availableModels.forEach(m => newSelected.delete(m.id));
    } else {
      availableModels.forEach(m => newSelected.add(m.id));
    }
    setSelectedModels(newSelected);
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div 
        className="bg-white dark:bg-gray-800 rounded-xl shadow-2xl w-[600px] max-h-[80vh] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-700">
          <h2 className="text-lg font-semibold text-gray-800 dark:text-white">
            {provider.displayName} 模型
          </h2>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-700 dark:hover:text-gray-300">
            <X size={20} />
          </button>
        </div>

        {/* Search & Actions */}
        <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-700 flex items-center gap-3">
          <div className="flex-1 relative">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              type="text"
              placeholder="搜索模型 ID 或名称"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              autoCorrect="off"
              autoCapitalize="off"
              autoComplete="off"
              spellCheck={false}
              className="w-full pl-9 pr-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-sm"
            />
          </div>
          <button
            onClick={fetchModels}
            disabled={loading}
            className="p-2 rounded-lg border border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700"
            title="刷新"
          >
            <RefreshCw size={18} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>

        {/* Model List */}
        <div className="flex-1 overflow-auto px-4 py-2">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 size={24} className="animate-spin text-blue-500" />
              <span className="ml-2 text-gray-500">加载中...</span>
            </div>
          ) : error ? (
            <div className="text-center py-12 text-red-500">{error}</div>
          ) : filteredModels.length === 0 ? (
            <div className="text-center py-12 text-gray-500">
              {searchQuery ? '没有匹配的模型' : '没有可用的模型'}
            </div>
          ) : (
            <div className="space-y-1">
              {Array.from(groupedModels.entries()).map(([groupName, groupModels]) => (
                <div key={groupName} className="border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
                  {/* Group Header */}
                  <div
                    className="flex items-center justify-between px-3 py-2 bg-gray-50 dark:bg-gray-700/50 cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-700"
                    onClick={() => toggleGroup(groupName)}
                  >
                    <div className="flex items-center gap-2">
                      {expandedGroups.has(groupName) ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                      <span className="font-medium text-sm">{groupName}</span>
                      <span className="text-xs text-gray-500 bg-gray-200 dark:bg-gray-600 px-1.5 py-0.5 rounded">
                        {groupModels.length}
                      </span>
                    </div>
                    <button
                      onClick={(e) => { e.stopPropagation(); selectAllInGroup(groupName); }}
                      className="text-xs text-blue-600 hover:text-blue-700 px-2 py-1"
                    >
                      全选
                    </button>
                  </div>
                  
                  {/* Group Models */}
                  {expandedGroups.has(groupName) && (
                    <div className="divide-y divide-gray-100 dark:divide-gray-700">
                      {groupModels.map(model => {
                        const isExisting = existingModels.has(model.id);
                        const isSelected = selectedModels.has(model.id);
                        
                        return (
                          <div
                            key={model.id}
                            className={`flex items-center justify-between px-3 py-2 hover:bg-gray-50 dark:hover:bg-gray-700/30 ${
                              isExisting ? 'opacity-50' : ''
                            }`}
                          >
                            <div className="flex items-center gap-3">
                              <button
                                onClick={() => !isExisting && toggleModel(model.id)}
                                disabled={isExisting}
                                className={`w-5 h-5 rounded border flex items-center justify-center ${
                                  isExisting
                                    ? 'bg-green-100 border-green-300 dark:bg-green-900/30 dark:border-green-700'
                                    : isSelected
                                    ? 'bg-blue-500 border-blue-500 text-white'
                                    : 'border-gray-300 dark:border-gray-600 hover:border-blue-500'
                                }`}
                              >
                                {(isExisting || isSelected) && <Check size={14} />}
                              </button>
                              <span className="text-sm">{model.id}</span>
                            </div>
                            {!isExisting && (
                              <button
                                onClick={() => addSingleModel(model.id)}
                                className="text-gray-400 hover:text-blue-500 p-1"
                                title="添加"
                              >
                                <Plus size={18} />
                              </button>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-3 border-t border-gray-200 dark:border-gray-700 flex items-center justify-between">
          <span className="text-sm text-gray-500">
            已选择 {selectedModels.size} 个模型
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg"
            >
              取消
            </button>
            <button
              onClick={addSelectedModels}
              disabled={selectedModels.size === 0}
              className="px-4 py-2 text-sm bg-blue-600 text-white hover:bg-blue-700 rounded-lg disabled:opacity-50 disabled:cursor-not-allowed"
            >
              添加选中 ({selectedModels.size})
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ModelPickerModal;
