/**
 * ProviderConfigForm Component
 * Form for managing AI service providers and their models
 */

import React, { useState, useEffect } from 'react';
import { Plus, Trash2, ChevronDown, ChevronRight, Wifi, WifiOff, Loader2, Search, Download, Brain, Eye, Wrench, Copy } from 'lucide-react';
import { useConfigStore } from '../../stores/configStore';
import { testConnection } from '../../services/configService';
import { ModelPickerModal } from './ModelPickerModal';
import { SecretInput } from './SecretInput';
import type { Provider, Model, ProviderType, ModelCapabilities, TextEditImplementation } from '../../types';

// Helper to infer capabilities from model name (mirrors backend logic)
const inferCapabilities = (modelName: string): ModelCapabilities => {
  const nameLower = modelName.toLowerCase();
  return {
    thinking: nameLower.includes('deepseek-r1') ||
      nameLower.includes('deepseek-reasoner') ||
      nameLower.includes('-r1-') ||
      nameLower.includes('reasoner') ||
      nameLower.includes('thinking'),
    vision: nameLower.includes('vision') ||
      nameLower.includes('-vl') ||
      nameLower.includes('gpt-4o') ||
      nameLower.includes('gpt-4-turbo') ||
      nameLower.includes('claude-3'),
    functionCalling: nameLower.includes('gpt-') ||
      nameLower.includes('claude-') ||
      nameLower.includes('deepseek-v') ||
      nameLower.includes('qwen'),
    webSearch: false,
  };
};

// Helper to infer context length from model name
const inferContextLength = (modelName: string): number | undefined => {
  const nameLower = modelName.toLowerCase();
  // GLM series
  if (nameLower.includes('glm-4.7')) return 256000;
  // GPT-4 series
  if (nameLower.includes('gpt-4o') || nameLower.includes('gpt-4-turbo')) return 128000;
  if (nameLower.includes('gpt-4-32k')) return 32768;
  if (nameLower.includes('gpt-4')) return 8192;
  // GPT-3.5 series
  if (nameLower.includes('gpt-3.5-turbo-16k')) return 16384;
  if (nameLower.includes('gpt-3.5')) return 4096;
  // Claude series
  if (nameLower.includes('claude-3')) return 200000;
  if (nameLower.includes('claude-2')) return 100000;
  // DeepSeek series
  if (nameLower.includes('deepseek-v3')) return 64000;
  if (nameLower.includes('deepseek-r1')) return 64000;
  if (nameLower.includes('deepseek-coder')) return 16384;
  // Qwen series
  if (nameLower.includes('qwen-72b') || nameLower.includes('qwen2')) return 32768;
  if (nameLower.includes('qwen')) return 8192;
  // Default: don't set, let user configure
  return undefined;
};

const defaultCapabilities: ModelCapabilities = {
  thinking: false,
  vision: false,
  functionCalling: false,
  webSearch: false,
};

const defaultModel: Model = {
  name: '',
  temperature: 0.7,
  temperatureEnabled: true,
  maxTokens: 4096,
  topP: 1,
  topPEnabled: true,
  capabilities: defaultCapabilities,
};

const defaultProvider: Provider = {
  name: '',
  displayName: '',
  type: 'openai_compatible',
  apiBase: '',
  apiKey: '',
  enabled: true,
  models: [],
};

export const ProviderConfigForm: React.FC = () => {
  const { config, saveConfigDebounced } = useConfigStore();
  const [selectedProviderName, setSelectedProviderName] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [expandedModels, setExpandedModels] = useState<Set<string>>(new Set());
  const [expandedAdvanced, setExpandedAdvanced] = useState<Set<string>>(new Set());
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle');
  const [testMessage, setTestMessage] = useState('');
  const [testModelName, setTestModelName] = useState('');
  const [showModelPicker, setShowModelPicker] = useState(false);

  const providers = config?.providers || [];
  const filteredProviders = providers.filter(p =>
    p.displayName.toLowerCase().includes(searchQuery.toLowerCase()) ||
    p.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  useEffect(() => {
    if (providers.length > 0 && !selectedProviderName) {
      setSelectedProviderName(providers[0].name);
    }
  }, [providers, selectedProviderName]);

  const handleSelectProvider = (name: string) => {
    setSelectedProviderName(name);
    setTestStatus('idle');
  };

  const handleCreateNew = () => {
    if (!config) return;
    const existing = new Set(providers.map((p) => p.name));
    const name = (() => {
      const base = `provider_${Date.now()}`;
      if (!existing.has(base)) return base;
      let i = 2;
      while (existing.has(`${base}_${i}`)) i += 1;
      return `${base}_${i}`;
    })();

    const created: Provider = {
      ...defaultProvider,
      name,
      displayName: name,
    };

    saveConfigDebounced({ ...config, providers: [...providers, created] });
    setSelectedProviderName(created.name);
    setTestStatus('idle');
  };

  const handleDelete = async () => {
    if (!selectedProviderName) return;
    const ok = await Promise.resolve(window.confirm('确定要删除这个提供商吗？'));
    if (!ok) return;
    if (!config) return;
    const nextProviders = providers.filter((p) => p.name !== selectedProviderName);
    saveConfigDebounced({ ...config, providers: nextProviders });
    setSelectedProviderName(nextProviders[0]?.name ?? null);
  };

  const nextUniqueProviderName = (baseName: string) => {
    const existing = new Set(providers.map((p) => p.name));
    const cleanedBase = baseName.trim() || 'provider';
    let candidate = `${cleanedBase}_copy`;
    let i = 2;
    while (existing.has(candidate)) {
      candidate = `${cleanedBase}_copy${i}`;
      i += 1;
    }
    return candidate;
  };

  const handleDuplicate = () => {
    const provider = providers.find((p) => p.name === selectedProviderName);
    if (!provider) return;
    if (!config) return;

    const duplicated: Provider = {
      ...provider,
      name: nextUniqueProviderName(provider.name),
      displayName: provider.displayName ? `${provider.displayName}（复制）` : `${provider.name}（复制）`,
      models: provider.models.map((m) => ({ ...m, capabilities: { ...m.capabilities } })),
    };

    saveConfigDebounced({ ...config, providers: [...providers, duplicated] });
    setSelectedProviderName(duplicated.name);
    setTestStatus('idle');
  };

  const handleToggleEnabled = (name: string, enabled: boolean) => {
    if (!config) return;
    const nextProviders = providers.map((p) => (p.name === name ? { ...p, enabled } : p));
    saveConfigDebounced({ ...config, providers: nextProviders });
  };

  const makeModelKey = (providerName: string, index: number) => `${providerName}::${index}`;

  const toggleModelExpand = (modelKey: string) => {
    const newExpanded = new Set(expandedModels);
    if (newExpanded.has(modelKey)) {
      newExpanded.delete(modelKey);
    } else {
      newExpanded.add(modelKey);
    }
    setExpandedModels(newExpanded);
  };

  const toggleAdvancedExpand = (modelKey: string) => {
    const newExpanded = new Set(expandedAdvanced);
    if (newExpanded.has(modelKey)) {
      newExpanded.delete(modelKey);
    } else {
      newExpanded.add(modelKey);
    }
    setExpandedAdvanced(newExpanded);
  };

  const handleAddModel = () => {
    if (!config) return;
    if (!selectedProviderName) return;
    const newModel = { ...defaultModel, name: `model_${Date.now()}`, capabilities: { ...defaultCapabilities } };
    const nextProviders = providers.map((p) =>
      p.name === selectedProviderName ? { ...p, models: [...p.models, newModel] } : p
    );
    saveConfigDebounced({ ...config, providers: nextProviders });
  };

  const handleUpdateModel = (index: number, model: Model) => {
    if (!config) return;
    if (!selectedProviderName) return;
    const nextProviders = providers.map((p) => {
      if (p.name !== selectedProviderName) return p;
      const models = [...p.models];
      models[index] = model;
      return { ...p, models };
    });
    saveConfigDebounced({ ...config, providers: nextProviders });
  };

  const handleDeleteModel = (index: number) => {
    if (!config) return;
    if (!selectedProviderName) return;

    // 展开状态使用 providerName::index 作为稳定 key；删除模型后需要把后续 index 左移。
    const providerPrefix = `${selectedProviderName}::`;
    const shiftKeysAfterDelete = (set: Set<string>): Set<string> => {
      const next = new Set<string>();
      for (const key of set) {
        if (!key.startsWith(providerPrefix)) {
          next.add(key);
          continue;
        }
        const rawIdx = key.slice(providerPrefix.length);
        const idx = Number.parseInt(rawIdx, 10);
        if (!Number.isFinite(idx)) continue;
        if (idx < index) next.add(key);
        else if (idx > index) next.add(makeModelKey(selectedProviderName, idx - 1));
        // idx === index: drop
      }
      return next;
    };

    setExpandedModels((prev) => shiftKeysAfterDelete(prev));
    setExpandedAdvanced((prev) => shiftKeysAfterDelete(prev));

    const nextProviders = providers.map((p) =>
      p.name === selectedProviderName
        ? { ...p, models: p.models.filter((_, i) => i !== index) }
        : p
    );
    saveConfigDebounced({ ...config, providers: nextProviders });
  };

  const handleTestConnection = async () => {
    const provider = providers.find(p => p.name === selectedProviderName);
    if (!provider) return;
    if (!testModelName) {
      setTestStatus('error');
      setTestMessage('请先选择要测试的模型');
      return;
    }
    setTestStatus('testing');
    try {
      const result = await testConnection(
        provider.type,
        provider.apiBase,
        provider.apiKey,
        testModelName
      );
      setTestStatus(result.success ? 'success' : 'error');
      setTestMessage(result.message);
    } catch (e) {
      setTestStatus('error');
      setTestMessage(e instanceof Error ? e.message : '连接失败');
    }
  };

  const handleOpenModelPicker = () => {
    setShowModelPicker(true);
  };

  const handleAddModelsFromPicker = (modelNames: string[]) => {
    if (!config) return;
    const provider = providers.find((p) => p.name === selectedProviderName);
    if (!provider) return;
    const existingNames = new Set(provider.models.map(m => m.name));
    const newModels: Model[] = modelNames
      .filter(name => !existingNames.has(name))
      .map(name => ({
        name,
        temperature: 0.7,
        maxTokens: 4096,
        topP: 1,
        contextLength: inferContextLength(name),
        capabilities: inferCapabilities(name),
      }));
    if (newModels.length > 0) {
      const nextProviders = providers.map((p) =>
        p.name === provider.name ? { ...p, models: [...p.models, ...newModels] } : p
      );
      saveConfigDebounced({ ...config, providers: nextProviders });
    }
    setShowModelPicker(false);
  };

  const currentProvider = providers.find(p => p.name === selectedProviderName);

  return (
    <div className="flex gap-6 h-full">
      {/* Provider List */}
      <div className="w-64 flex-shrink-0 flex flex-col">
        <div className="mb-3">
          <div className="relative">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              type="text"
              placeholder="搜索提供商..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-9 pr-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-sm"
            />
          </div>
        </div>

        <div className="flex-1 space-y-1 overflow-auto">
          {filteredProviders.map((provider) => (
            <div
              key={provider.name}
              onClick={() => handleSelectProvider(provider.name)}
              className={`flex items-center justify-between px-3 py-2 rounded-lg cursor-pointer transition-colors ${selectedProviderName === provider.name
                  ? 'bg-blue-100 dark:bg-blue-900/50'
                  : 'hover:bg-gray-100 dark:hover:bg-gray-700'
                }`}
            >
              <div className="flex items-center gap-2 min-w-0">
                <span className={`w-2 h-2 rounded-full ${provider.enabled ? 'bg-green-500' : 'bg-gray-400'}`} />
                <span className="text-sm truncate">{provider.displayName}</span>
              </div>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  handleToggleEnabled(provider.name, !provider.enabled);
                }}
                className={`text-xs px-2 py-0.5 rounded ${provider.enabled
                    ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                    : 'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400'
                  }`}
              >
                {provider.enabled ? 'ON' : 'OFF'}
              </button>
            </div>
          ))}
        </div>

        <button
          onClick={handleCreateNew}
          className="mt-3 flex items-center justify-center gap-2 w-full py-2 rounded-lg border-2 border-dashed border-gray-300 dark:border-gray-600 text-gray-500 hover:border-blue-500 hover:text-blue-500 transition-colors"
        >
          <Plus size={16} />
          <span className="text-sm">添加提供商</span>
        </button>
      </div>

      {/* Provider Form */}
      <div className="flex-1 min-w-0">
        {currentProvider ? (
          <ProviderForm
            provider={currentProvider}
            isEditing={true}
            expandedModels={expandedModels}
            expandedAdvanced={expandedAdvanced}
            testStatus={testStatus}
            testMessage={testMessage}
            testModelName={testModelName}
            onDuplicate={handleDuplicate}
            onDelete={handleDelete}
            onFieldChange={(field, value) => {
              if (!config) return;
              if (!selectedProviderName) return;
              const nextProviders = providers.map((p) =>
                p.name === selectedProviderName ? { ...p, [field]: value } : p
              );
              saveConfigDebounced({ ...config, providers: nextProviders });
            }}
            onToggleModelExpand={toggleModelExpand}
            onToggleAdvancedExpand={toggleAdvancedExpand}
            onAddModel={handleAddModel}
            onUpdateModel={handleUpdateModel}
            onDeleteModel={handleDeleteModel}
            onTestConnection={handleTestConnection}
            onOpenModelPicker={handleOpenModelPicker}
            onTestModelChange={setTestModelName}
          />
        ) : (
          <div className="flex items-center justify-center h-64 text-gray-500">
            {providers.length === 0 ? '点击添加第一个提供商' : '选择一个提供商'}
          </div>
        )}
      </div>

      {/* Model Picker Modal */}
      {showModelPicker && currentProvider && (
        <ModelPickerModal
          provider={currentProvider}
          onClose={() => setShowModelPicker(false)}
          onAddModels={handleAddModelsFromPicker}
        />
      )}
    </div>
  );
};

interface ProviderFormProps {
  provider: Provider;
  isEditing: boolean;
  expandedModels: Set<string>;
  expandedAdvanced: Set<string>;
  testStatus: 'idle' | 'testing' | 'success' | 'error';
  testMessage: string;
  testModelName: string;
  onDuplicate: () => void;
  onDelete: () => void;
  onFieldChange: (field: keyof Provider, value: any) => void;
  onToggleModelExpand: (modelKey: string) => void;
  onToggleAdvancedExpand: (modelKey: string) => void;
  onAddModel: () => void;
  onUpdateModel: (index: number, model: Model) => void;
  onDeleteModel: (index: number) => void;
  onTestConnection: () => void;
  onOpenModelPicker: () => void;
  onTestModelChange: (modelName: string) => void;
}

const ProviderForm: React.FC<ProviderFormProps> = ({
  provider,
  isEditing,
  expandedModels,
  expandedAdvanced,
  testStatus,
  testMessage,
  testModelName,
  onDuplicate,
  onDelete,
  onFieldChange,
  onToggleModelExpand,
  onToggleAdvancedExpand,
  onAddModel,
  onUpdateModel,
  onDeleteModel,
  onTestConnection,
  onOpenModelPicker,
  onTestModelChange,
}) => {
  const typeOptions: { value: ProviderType; label: string; description?: string }[] = [
    { value: 'openai', label: 'OpenAI', description: '官方 API (developer role)' },
    { value: 'openai_compatible', label: 'OpenAI Compatible', description: 'DeepSeek, 硅基流动等' },
    { value: 'openai_responses', label: 'OpenAI Responses', description: '推理模型 (o1, o3, gpt-4.1)' },
    { value: 'anthropic', label: 'Anthropic', description: 'Claude 系列' },
    { value: 'google', label: 'Google', description: 'Gemini' },
    { value: 'ollama', label: 'Ollama', description: '本地模型' },
  ];

  const makeModelKey = (index: number) => `${provider.name}::${index}`;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-gray-800 dark:text-white">
          {provider.displayName || '提供商配置'}
        </h2>
        <div className="flex items-center gap-2">
          <span className="px-2 text-xs text-gray-500 dark:text-gray-400">自动保存</span>
          <button
            onClick={onDuplicate}
            className="px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg flex items-center gap-1"
            title="复制提供商"
          >
            <Copy size={14} />
            复制
          </button>
          <button
            onClick={onDelete}
            className="px-3 py-1.5 text-sm text-red-600 hover:bg-red-50 dark:hover:bg-red-900/30 rounded-lg"
          >
            删除
          </button>
        </div>
      </div>

      {/* Form Fields */}
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-1">
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">显示名称</label>
          <input
            type="text"
            value={provider.displayName}
            onChange={(e) => onFieldChange('displayName', e.target.value)}
            disabled={!isEditing}
            placeholder="例如：硅基流动"
            className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 disabled:bg-gray-100 dark:disabled:bg-gray-800"
          />
        </div>
        <div className="space-y-1">
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">类型</label>
          <select
            value={provider.type}
            onChange={(e) => onFieldChange('type', e.target.value as ProviderType)}
            disabled={!isEditing}
            className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 disabled:bg-gray-100 dark:disabled:bg-gray-800"
          >
            {typeOptions.map(opt => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
          </select>
        </div>
        <div className="space-y-1">
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">API 地址</label>
          <input
            type="text"
            value={provider.apiBase}
            onChange={(e) => onFieldChange('apiBase', e.target.value)}
            disabled={!isEditing}
            placeholder="https://api.example.com/v1"
            className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 disabled:bg-gray-100 dark:disabled:bg-gray-800"
          />
        </div>
        <div className="space-y-1">
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">API Key</label>
          <SecretInput
            value={provider.apiKey || ''}
            onChange={(e) => onFieldChange('apiKey', e.target.value)}
            disabled={!isEditing}
            placeholder="sk-..."
            className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 disabled:bg-gray-100 dark:disabled:bg-gray-800"
          />
        </div>
      </div>

      {/* Models Section */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300">模型列表</h3>
          {isEditing && (
            <div className="flex items-center gap-2">
              <button onClick={onOpenModelPicker} className="flex items-center gap-1 text-sm text-green-600 hover:text-green-700">
                <Download size={14} /> 获取模型
              </button>
              <button onClick={onAddModel} className="flex items-center gap-1 text-sm text-blue-600 hover:text-blue-700">
                <Plus size={14} /> 手动添加
              </button>
            </div>
          )}
        </div>
        <div className="border border-gray-200 dark:border-gray-700 rounded-lg divide-y divide-gray-200 dark:divide-gray-700">
          {provider.models.length === 0 ? (
            <div className="px-4 py-3 text-sm text-gray-500">暂无模型</div>
          ) : (
            provider.models.map((model, index) => (
              <div key={makeModelKey(index)} className="px-4 py-2">
                <div
                  className="flex items-center justify-between cursor-pointer"
                  onClick={() => onToggleModelExpand(makeModelKey(index))}
                >
                  <div className="flex items-center gap-2">
                    {expandedModels.has(makeModelKey(index)) ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                    <span className="text-sm font-medium">{model.name}</span>
                  </div>
                  {isEditing && (
                    <button
                      onClick={(e) => { e.stopPropagation(); onDeleteModel(index); }}
                      className="text-red-500 hover:text-red-600"
                    >
                      <Trash2 size={14} />
                    </button>
                  )}
                </div>
                {expandedModels.has(makeModelKey(index)) && (
                  <div className="mt-2 pl-6 space-y-3">
                    <div className="grid grid-cols-4 gap-3">
                      <div>
                        <label className="block text-xs text-gray-500">名称</label>
                        <input
                          type="text"
                          value={model.name}
                          onChange={(e) => onUpdateModel(index, { ...model, name: e.target.value })}
                          disabled={!isEditing}
                          className="w-full px-2 py-1 text-sm rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 disabled:bg-gray-100"
                        />
                      </div>
                      <div className="flex items-end justify-end">
                        <button
                          type="button"
                          onClick={() => onToggleAdvancedExpand(makeModelKey(index))}
                          className="inline-flex items-center gap-1 rounded border border-gray-200 px-2 py-1 text-xs text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
                        >
                          {expandedAdvanced.has(makeModelKey(index)) ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                          <span>高级</span>
                        </button>
                      </div>
                      <div>
                        <label className="block text-xs text-gray-500">Max Tokens</label>
                        <input
                          type="number"
                          value={model.maxTokens || ''}
                          onChange={(e) => onUpdateModel(index, { ...model, maxTokens: parseInt(e.target.value) || undefined })}
                          disabled={!isEditing}
                          className="w-full px-2 py-1 text-sm rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 disabled:bg-gray-100"
                        />
                      </div>
                      <div>
                        <label className="block text-xs text-gray-500">Context (K)</label>
                        <input
                          type="number"
                          value={model.contextLength ? model.contextLength / 1000 : ''}
                          onChange={(e) => onUpdateModel(index, { ...model, contextLength: e.target.value ? parseInt(e.target.value) * 1000 : undefined })}
                          disabled={!isEditing}
                          placeholder="64"
                          className="w-full px-2 py-1 text-sm rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 disabled:bg-gray-100"
                        />
                      </div>
                    </div>
                    {/* Model Capabilities */}
                    <div className="flex items-center gap-4">
                      <span className="text-xs text-gray-500">能力:</span>
                      <label className="flex items-center gap-1 text-xs">
                        <input
                          type="checkbox"
                          checked={model.capabilities?.thinking ?? false}
                          onChange={(e) => onUpdateModel(index, {
                            ...model,
                            capabilities: { ...model.capabilities, thinking: e.target.checked },
                            // Anthropic extended thinking budget default (optional)
                            ...(provider.type === 'anthropic' && e.target.checked && !model.thinkingBudgetTokens
                              ? { thinkingBudgetTokens: 1024 }
                              : {})
                          })}
                          disabled={!isEditing}
                          className="rounded"
                        />
                        <Brain size={12} className="text-purple-500" />
                        <span>思考</span>
                      </label>
                      <label className="flex items-center gap-1 text-xs">
                        <input
                          type="checkbox"
                          checked={model.capabilities?.vision ?? false}
                          onChange={(e) => onUpdateModel(index, {
                            ...model,
                            capabilities: { ...model.capabilities, vision: e.target.checked }
                          })}
                          disabled={!isEditing}
                          className="rounded"
                        />
                        <Eye size={12} className="text-blue-500" />
                        <span>视觉</span>
                      </label>
                      <label className="flex items-center gap-1 text-xs">
                        <input
                          type="checkbox"
                          checked={model.capabilities?.functionCalling ?? false}
                          onChange={(e) => onUpdateModel(index, {
                            ...model,
                            capabilities: { ...model.capabilities, functionCalling: e.target.checked }
                          })}
                          disabled={!isEditing}
                          className="rounded"
                        />
                        <Wrench size={12} className="text-green-500" />
                        <span>工具调用</span>
                      </label>
                      <label className="flex items-center gap-1 text-xs">
                        <input
                          type="checkbox"
                          checked={model.capabilities?.webSearch ?? false}
                          onChange={(e) => onUpdateModel(index, {
                            ...model,
                            capabilities: { ...model.capabilities, webSearch: e.target.checked }
                          })}
                          disabled={!isEditing}
                          className="rounded"
                        />
                        <Search size={12} className="text-orange-500" />
                        <span>网络搜索</span>
                      </label>
                    </div>
                    {/* Advanced Settings */}
                    {expandedAdvanced.has(makeModelKey(index)) && (
                        <div className="pt-2 border-t border-gray-200 dark:border-gray-700">
                          <div className="mt-2 space-y-3">
                            <div className="grid grid-cols-4 gap-3">
                              <div className="col-span-2 space-y-1">
                                <label className="flex items-center justify-between text-xs text-gray-600 dark:text-gray-300">
                                  <span>Temperature</span>
                                  <label className="flex items-center gap-2">
                                    <span className="text-gray-500 dark:text-gray-400">
                                      {model.temperature.toFixed(2)}
                                    </span>
                                    <input
                                      type="checkbox"
                                      checked={model.temperatureEnabled !== false}
                                      onChange={(e) =>
                                        onUpdateModel(index, { ...model, temperatureEnabled: e.target.checked })
                                      }
                                      disabled={!isEditing}
                                      className="rounded"
                                    />
                                  </label>
                                </label>
                                <input
                                  type="range"
                                  min="0"
                                  max="2"
                                  step="0.1"
                                  value={model.temperature}
                                  onChange={(e) =>
                                    onUpdateModel(index, { ...model, temperature: parseFloat(e.target.value) })
                                  }
                                  disabled={!isEditing || model.temperatureEnabled === false}
                                  className="w-full"
                                />
                                <p className="text-[11px] text-gray-500">关闭后，实际请求不会发送 temperature</p>
                              </div>

                              <div className="col-span-2 space-y-1">
                                <label className="flex items-center justify-between text-xs text-gray-600 dark:text-gray-300">
                                  <span>Top P</span>
                                  <label className="flex items-center gap-2">
                                    <span className="text-gray-500 dark:text-gray-400">
                                      {(model.topP ?? 1).toFixed(2)}
                                    </span>
                                      <input
                                        type="checkbox"
                                        checked={model.topPEnabled !== false}
                                        onChange={(e) =>
                                          onUpdateModel(index, {
                                            ...model,
                                            topPEnabled: e.target.checked,
                                            topP: e.target.checked ? (model.topP ?? 1) : model.topP,
                                          })
                                        }
                                        disabled={!isEditing}
                                        className="rounded"
                                      />
                                  </label>
                                </label>
                                <input
                                  type="range"
                                  min="0"
                                  max="1"
                                  step="0.05"
                                  value={model.topP ?? 1}
                                  onChange={(e) =>
                                    onUpdateModel(index, { ...model, topP: parseFloat(e.target.value) })
                                  }
                                  disabled={!isEditing || model.topPEnabled === false}
                                  className="w-full"
                                />
                                <p className="text-[11px] text-gray-500">关闭后，实际请求不会发送 top_p</p>
                              </div>
	                            </div>
	
	                            <div className="grid grid-cols-4 gap-3">
	                                <div>
	                                  <label className="block text-xs text-gray-500">重试次数</label>
	                                  <input
	                                    type="number"
	                                    min="1"
	                                    max="10"
	                                    value={model.retryAttempts ?? ''}
	                                    onChange={(e) => {
	                                      const raw = e.target.value;
	                                      const next = raw ? Number.parseInt(raw, 10) : undefined;
	                                      const normalized =
	                                        typeof next === 'number' && Number.isFinite(next) && next >= 1 ? next : undefined;
	                                      onUpdateModel(index, {
	                                        ...model,
	                                        retryAttempts: normalized,
	                                      });
	                                    }}
	                                    disabled={!isEditing}
	                                    placeholder="8"
	                                    className="w-full px-2 py-1 text-sm rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 disabled:bg-gray-100"
	                                  />
	                                  <span className="text-xs text-gray-400">默认: 8</span>
	                                </div>

                                <div className="col-span-3">
                                  <label className="flex items-center gap-2 text-xs">
                                    <input
                                      type="checkbox"
                                      checked={model.resumePartialOutput ?? false}
                                      onChange={(e) =>
                                        onUpdateModel(index, { ...model, resumePartialOutput: e.target.checked })
                                      }
                                      disabled={!isEditing}
                                      className="rounded"
                                    />
                                    <span className="text-gray-700 dark:text-gray-300">断流后继续（实验）</span>
                                  </label>
                                  <p className="mt-1 text-[11px] text-gray-500">
                                    默认关闭：仅当服务端支持并提供 TurnState 时才能重连续传；开启后允许在已输出部分内容后自动重连继续。
                                  </p>
                                </div>

                                <div className="col-span-4">
                                  <label className="block text-xs text-gray-500">文本编辑实现</label>
                                  <select
                                    value={model.textEditImplementation ?? 'apply_patch'}
                                    onChange={(e) => {
                                      const next = e.target.value as TextEditImplementation;
                                      onUpdateModel(index, {
                                        ...model,
                                        textEditImplementation: next === 'apply_patch' ? undefined : next,
                                      });
                                    }}
                                    disabled={!isEditing}
                                    className="w-full px-2 py-1 text-sm rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 disabled:bg-gray-100"
                                  >
                                    <option value="apply_patch">apply_patch（默认）</option>
                                    <option value="apply_patch_unified_diff">apply_patch_unified_diff（unified diff）</option>
                                    <option value="write_file_replace_string">write_file + replace_string</option>
                                  </select>
                                  <p className="mt-1 text-[11px] text-gray-500">
                                    仅当 toolset 开启 <code className="font-mono">text_edit</code>（抽象文本编辑）时生效。
                                  </p>
                                </div>

                                {model.capabilities?.vision && (
	                                  <div>
	                                    <label className="block text-xs text-gray-500">最大图片数</label>
	                                    <input
	                                      type="number"
                                      min="1"
                                      max="100"
                                      value={model.maxImages ?? 10}
                                      onChange={(e) => onUpdateModel(index, { ...model, maxImages: parseInt(e.target.value) || 10 })}
                                      disabled={!isEditing}
                                      placeholder="10"
                                      className="w-full px-2 py-1 text-sm rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 disabled:bg-gray-100"
                                    />
                                    <span className="text-xs text-gray-400">默认: 10</span>
                                  </div>
                                )}

                                {provider.type === 'anthropic' && (model.capabilities?.thinking ?? false) && (
                                  <div>
                                    <label className="block text-xs text-gray-500">思考预算 Tokens</label>
                                    <input
                                      type="number"
                                      min="1024"
                                      value={model.thinkingBudgetTokens || ''}
                                      onChange={(e) => onUpdateModel(index, { ...model, thinkingBudgetTokens: parseInt(e.target.value) || undefined })}
                                      disabled={!isEditing}
                                      placeholder="1024"
                                      className="w-full px-2 py-1 text-sm rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 disabled:bg-gray-100"
                                    />
                                    <span className="text-xs text-gray-400">留空自动计算（需 ≥1024 且 &lt; Max Tokens）</span>
                                  </div>
                                )}
                              </div>

                              {/* Reasoning Effort 选项 (仅 OpenAI/OpenAI Compatible + 思考能力) */}
                              {(provider.type === 'openai' || provider.type === 'openai_compatible') && (model.capabilities?.thinking ?? false) && (
                                <div className="pt-2 border-t border-gray-200 dark:border-gray-700">
                                  <label className="flex items-center gap-2 text-xs">
                                    <input
                                      type="checkbox"
                                      checked={model.useReasoningEffort ?? false}
                                      onChange={(e) => onUpdateModel(index, { ...model, useReasoningEffort: e.target.checked })}
                                      disabled={!isEditing}
                                      className="rounded"
                                    />
                                    <span className="text-gray-700 dark:text-gray-300">使用 Reasoning Effort</span>
                                  </label>
                                  <p className="mt-1 text-xs text-gray-500">
                                    启用后在聊天界面支持多级推理控制（适用于 GPT-5 系列等支持 reasoning_effort 参数的模型）
                                  </p>
                                </div>
                              )}

                              {/* Kimi thinking: reinject reasoning_content */}
                              {provider.type === 'openai_compatible' && (model.capabilities?.thinking ?? false) && (
                                <div className="pt-2 border-t border-gray-200 dark:border-gray-700">
                                  <label className="flex items-center gap-2 text-xs">
                                    <input
                                      type="checkbox"
                                      checked={model.reinjectReasoningContent ?? false}
                                      onChange={(e) => onUpdateModel(index, { ...model, reinjectReasoningContent: e.target.checked })}
                                      disabled={!isEditing}
                                      className="rounded"
                                    />
                                    <span className="text-gray-700 dark:text-gray-300">回传历史 reasoning_content（Kimi）</span>
                                  </label>
                                  <p className="mt-1 text-xs text-gray-500">
                                    默认关闭：仅发送空的 reasoning_content 占位（满足严格校验）。打开后：将历史 thinking 作为 reasoning_content 一并发送，提升 Kimi 多步推理/工具调用的连贯性。
                                  </p>
                                </div>
                              )}
                            </div>
                        </div>
                      )}
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      </div>

      {/* Test Connection */}
      <div className="flex items-center gap-4 pt-4 border-t border-gray-200 dark:border-gray-700">
        <select
          value={testModelName}
          onChange={(e) => onTestModelChange(e.target.value)}
          className="px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-sm"
        >
          <option value="">选择测试模型</option>
          {provider.models.map(m => (
            <option key={m.name} value={m.name}>{m.name}</option>
          ))}
        </select>
        <button
          onClick={onTestConnection}
          disabled={testStatus === 'testing' || !testModelName}
          className="flex items-center gap-2 px-4 py-2 bg-gray-100 hover:bg-gray-200 dark:bg-gray-700 dark:hover:bg-gray-600 rounded-lg disabled:opacity-50"
        >
          {testStatus === 'testing' ? <Loader2 size={18} className="animate-spin" /> :
            testStatus === 'success' ? <Wifi size={18} className="text-green-500" /> :
              testStatus === 'error' ? <WifiOff size={18} className="text-red-500" /> :
                <Wifi size={18} />}
          测试连接
        </button>
        {testMessage && (
          <span className={`text-sm ${testStatus === 'success' ? 'text-green-600' : 'text-red-600'}`}>
            {testMessage}
          </span>
        )}
      </div>
    </div>
  );
};

export default ProviderConfigForm;
