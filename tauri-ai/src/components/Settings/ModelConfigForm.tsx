/**
 * ModelConfigForm Component
 * Form for creating and editing AI model configurations
 * Requirements: 6.6
 */

import React, { useState, useEffect } from 'react';
import { Plus, Trash2, Edit2, Check, X, Loader2, Wifi, WifiOff } from 'lucide-react';
import { useConfigStore } from '../../stores/configStore';
import { testConnection } from '../../services/configService';
import type { ModelConfig, Provider, ModelParameters } from '../../types';

// Generate unique ID
const generateId = () => `model_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

// Default model parameters
const defaultParameters: ModelParameters = {
  temperature: 0.7,
  maxTokens: 2048,
  topP: 1,
  frequencyPenalty: 0,
  presencePenalty: 0,
  systemPrompt: '',
};

// Default model config
const createDefaultModel = (): ModelConfig => ({
  id: generateId(),
  name: '',
  provider: 'openai',
  apiBase: '',
  apiKey: '',
  model: '',
  parameters: { ...defaultParameters },
});

export const ModelConfigForm: React.FC = () => {
  const { config, addModel, updateModel, deleteModel, setActiveModel } = useConfigStore();
  const [selectedModelId, setSelectedModelId] = useState<string | null>(null);
  const [editingModel, setEditingModel] = useState<ModelConfig | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle');
  const [testMessage, setTestMessage] = useState('');

  const models = config?.models || [];
  const activeModelId = config?.activeModelId;

  // Select first model by default
  useEffect(() => {
    if (models.length > 0 && !selectedModelId) {
      setSelectedModelId(models[0].id);
    }
  }, [models, selectedModelId]);

  const handleSelectModel = (modelId: string) => {
    setSelectedModelId(modelId);
    setEditingModel(null);
    setIsCreating(false);
    setTestStatus('idle');
  };

  const handleCreateNew = () => {
    setIsCreating(true);
    setEditingModel(createDefaultModel());
    setSelectedModelId(null);
    setTestStatus('idle');
  };

  const handleEdit = () => {
    const model = models.find((m) => m.id === selectedModelId);
    if (model) {
      setEditingModel({ ...model });
    }
  };

  const handleCancel = () => {
    setEditingModel(null);
    setIsCreating(false);
    if (models.length > 0) {
      setSelectedModelId(models[0].id);
    }
  };

  const handleSave = () => {
    if (!editingModel || !editingModel.name.trim()) return;

    if (isCreating) {
      addModel(editingModel);
      setSelectedModelId(editingModel.id);
    } else {
      updateModel(editingModel);
    }
    setEditingModel(null);
    setIsCreating(false);
  };

  const handleDelete = () => {
    if (!selectedModelId) return;
    if (confirm('确定要删除这个模型配置吗？')) {
      deleteModel(selectedModelId);
      setSelectedModelId(models.length > 1 ? models.find((m) => m.id !== selectedModelId)?.id || null : null);
    }
  };

  const handleSetActive = () => {
    if (selectedModelId) {
      setActiveModel(selectedModelId);
    }
  };

  const handleTestConnection = async () => {
    const modelToTest = editingModel || models.find((m) => m.id === selectedModelId);
    if (!modelToTest) return;

    setTestStatus('testing');
    setTestMessage('');

    try {
      const result = await testConnection(modelToTest);
      if (result.success) {
        setTestStatus('success');
        setTestMessage(result.message || '连接成功');
      } else {
        setTestStatus('error');
        setTestMessage(result.message || '连接失败');
      }
    } catch (error) {
      setTestStatus('error');
      setTestMessage(error instanceof Error ? error.message : '连接测试失败');
    }
  };

  const updateEditingField = <K extends keyof ModelConfig>(field: K, value: ModelConfig[K]) => {
    if (editingModel) {
      setEditingModel({ ...editingModel, [field]: value });
    }
  };

  const updateEditingParameter = <K extends keyof ModelParameters>(field: K, value: ModelParameters[K]) => {
    if (editingModel) {
      setEditingModel({
        ...editingModel,
        parameters: { ...editingModel.parameters, [field]: value },
      });
    }
  };

  const currentModel = editingModel || models.find((m) => m.id === selectedModelId);

  return (
    <div className="flex gap-6 h-full">
      {/* Model List */}
      <div className="w-64 flex-shrink-0">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300">模型列表</h3>
          <button
            onClick={handleCreateNew}
            className="p-1.5 rounded-lg text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/30 transition-colors"
            title="添加模型"
          >
            <Plus size={18} />
          </button>
        </div>
        <div className="space-y-1">
          {models.map((model) => (
            <button
              key={model.id}
              onClick={() => handleSelectModel(model.id)}
              className={`
                w-full flex items-center gap-2 px-3 py-2 rounded-lg text-left transition-colors
                ${selectedModelId === model.id && !isCreating
                  ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-300'
                  : 'text-gray-700 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700'
                }
              `}
            >
              <span className="flex-1 truncate text-sm">{model.name || '未命名'}</span>
              {model.id === activeModelId && (
                <span className="w-2 h-2 rounded-full bg-green-500" title="当前激活" />
              )}
            </button>
          ))}
          {isCreating && (
            <div className="px-3 py-2 rounded-lg bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-300 text-sm">
              新建模型
            </div>
          )}
        </div>
      </div>

      {/* Model Form */}
      <div className="flex-1 min-w-0">
        {currentModel ? (
          <ModelForm
            model={currentModel}
            isEditing={!!editingModel}
            isActive={currentModel.id === activeModelId}
            testStatus={testStatus}
            testMessage={testMessage}
            onFieldChange={updateEditingField}
            onParameterChange={updateEditingParameter}
            onEdit={handleEdit}
            onSave={handleSave}
            onCancel={handleCancel}
            onDelete={handleDelete}
            onSetActive={handleSetActive}
            onTestConnection={handleTestConnection}
          />
        ) : (
          <div className="flex items-center justify-center h-64 text-gray-500 dark:text-gray-400">
            {models.length === 0 ? '点击 + 添加第一个模型配置' : '选择一个模型查看详情'}
          </div>
        )}
      </div>
    </div>
  );
};


/**
 * Model Form Component
 * Displays and edits model configuration details
 */
interface ModelFormProps {
  model: ModelConfig;
  isEditing: boolean;
  isActive: boolean;
  testStatus: 'idle' | 'testing' | 'success' | 'error';
  testMessage: string;
  onFieldChange: <K extends keyof ModelConfig>(field: K, value: ModelConfig[K]) => void;
  onParameterChange: <K extends keyof ModelParameters>(field: K, value: ModelParameters[K]) => void;
  onEdit: () => void;
  onSave: () => void;
  onCancel: () => void;
  onDelete: () => void;
  onSetActive: () => void;
  onTestConnection: () => void;
}

const ModelForm: React.FC<ModelFormProps> = ({
  model,
  isEditing,
  isActive,
  testStatus,
  testMessage,
  onFieldChange,
  onParameterChange,
  onEdit,
  onSave,
  onCancel,
  onDelete,
  onSetActive,
  onTestConnection,
}) => {
  const providerOptions: { value: Provider; label: string }[] = [
    { value: 'openai', label: 'OpenAI' },
    { value: 'anthropic', label: 'Anthropic' },
    { value: 'ollama', label: 'Ollama' },
    { value: 'custom', label: '自定义' },
  ];

  const getDefaultApiBase = (provider: Provider): string => {
    switch (provider) {
      case 'openai':
        return 'https://api.openai.com/v1';
      case 'anthropic':
        return 'https://api.anthropic.com';
      case 'ollama':
        return 'http://localhost:11434';
      default:
        return '';
    }
  };

  const handleProviderChange = (provider: Provider) => {
    onFieldChange('provider', provider);
    if (!model.apiBase) {
      onFieldChange('apiBase', getDefaultApiBase(provider));
    }
  };

  return (
    <div className="space-y-6">
      {/* Header with Actions */}
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-gray-800 dark:text-white">
          {isEditing ? (model.id.startsWith('model_') && !model.name ? '新建模型' : '编辑模型') : '模型详情'}
        </h2>
        <div className="flex items-center gap-2">
          {isEditing ? (
            <>
              <button
                onClick={onCancel}
                className="flex items-center gap-1 px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-700 rounded-lg transition-colors"
              >
                <X size={16} />
                取消
              </button>
              <button
                onClick={onSave}
                className="flex items-center gap-1 px-3 py-1.5 text-sm bg-blue-600 text-white hover:bg-blue-700 rounded-lg transition-colors"
              >
                <Check size={16} />
                保存
              </button>
            </>
          ) : (
            <>
              {!isActive && (
                <button
                  onClick={onSetActive}
                  className="px-3 py-1.5 text-sm text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/30 rounded-lg transition-colors"
                >
                  设为默认
                </button>
              )}
              <button
                onClick={onEdit}
                className="flex items-center gap-1 px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-700 rounded-lg transition-colors"
              >
                <Edit2 size={16} />
                编辑
              </button>
              <button
                onClick={onDelete}
                className="flex items-center gap-1 px-3 py-1.5 text-sm text-red-600 hover:bg-red-50 dark:hover:bg-red-900/30 rounded-lg transition-colors"
              >
                <Trash2 size={16} />
                删除
              </button>
            </>
          )}
        </div>
      </div>

      {/* Form Fields */}
      <div className="grid grid-cols-2 gap-4">
        {/* Name */}
        <div className="space-y-1">
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
            名称 <span className="text-red-500">*</span>
          </label>
          <input
            type="text"
            value={model.name}
            onChange={(e) => onFieldChange('name', e.target.value)}
            disabled={!isEditing}
            placeholder="例如：GPT-4"
            className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-800 dark:text-white disabled:bg-gray-100 dark:disabled:bg-gray-800 disabled:cursor-not-allowed focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          />
        </div>

        {/* Provider */}
        <div className="space-y-1">
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
            提供商
          </label>
          <select
            value={model.provider}
            onChange={(e) => handleProviderChange(e.target.value as Provider)}
            disabled={!isEditing}
            className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-800 dark:text-white disabled:bg-gray-100 dark:disabled:bg-gray-800 disabled:cursor-not-allowed focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          >
            {providerOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        {/* Model Name */}
        <div className="space-y-1">
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
            模型名称
          </label>
          <input
            type="text"
            value={model.model}
            onChange={(e) => onFieldChange('model', e.target.value)}
            disabled={!isEditing}
            placeholder="例如：gpt-4-turbo"
            className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-800 dark:text-white disabled:bg-gray-100 dark:disabled:bg-gray-800 disabled:cursor-not-allowed focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          />
        </div>

        {/* API Base */}
        <div className="space-y-1">
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
            API 地址
          </label>
          <input
            type="text"
            value={model.apiBase || ''}
            onChange={(e) => onFieldChange('apiBase', e.target.value)}
            disabled={!isEditing}
            placeholder={getDefaultApiBase(model.provider)}
            className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-800 dark:text-white disabled:bg-gray-100 dark:disabled:bg-gray-800 disabled:cursor-not-allowed focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          />
        </div>

        {/* API Key */}
        <div className="col-span-2 space-y-1">
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
            API 密钥
          </label>
          <input
            type="password"
            value={model.apiKey || ''}
            onChange={(e) => onFieldChange('apiKey', e.target.value)}
            disabled={!isEditing}
            placeholder={model.provider === 'ollama' ? '本地模型无需密钥' : '输入 API 密钥'}
            className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-800 dark:text-white disabled:bg-gray-100 dark:disabled:bg-gray-800 disabled:cursor-not-allowed focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          />
        </div>
      </div>

      {/* Parameters Section */}
      <div className="space-y-4">
        <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300">模型参数</h3>
        <div className="grid grid-cols-2 gap-4">
          {/* Temperature */}
          <div className="space-y-1">
            <label className="block text-xs text-gray-600 dark:text-gray-400">
              Temperature: {model.parameters.temperature}
            </label>
            <input
              type="range"
              min="0"
              max="2"
              step="0.1"
              value={model.parameters.temperature}
              onChange={(e) => onParameterChange('temperature', parseFloat(e.target.value))}
              disabled={!isEditing}
              className="w-full"
            />
          </div>

          {/* Max Tokens */}
          <div className="space-y-1">
            <label className="block text-xs text-gray-600 dark:text-gray-400">
              最大 Token 数
            </label>
            <input
              type="number"
              value={model.parameters.maxTokens || ''}
              onChange={(e) => onParameterChange('maxTokens', parseInt(e.target.value) || undefined)}
              disabled={!isEditing}
              placeholder="2048"
              className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-800 dark:text-white disabled:bg-gray-100 dark:disabled:bg-gray-800 disabled:cursor-not-allowed focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm"
            />
          </div>

          {/* Top P */}
          <div className="space-y-1">
            <label className="block text-xs text-gray-600 dark:text-gray-400">
              Top P: {model.parameters.topP ?? 1}
            </label>
            <input
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={model.parameters.topP ?? 1}
              onChange={(e) => onParameterChange('topP', parseFloat(e.target.value))}
              disabled={!isEditing}
              className="w-full"
            />
          </div>

          {/* Frequency Penalty */}
          <div className="space-y-1">
            <label className="block text-xs text-gray-600 dark:text-gray-400">
              频率惩罚: {model.parameters.frequencyPenalty ?? 0}
            </label>
            <input
              type="range"
              min="-2"
              max="2"
              step="0.1"
              value={model.parameters.frequencyPenalty ?? 0}
              onChange={(e) => onParameterChange('frequencyPenalty', parseFloat(e.target.value))}
              disabled={!isEditing}
              className="w-full"
            />
          </div>
        </div>

        {/* System Prompt */}
        <div className="space-y-1">
          <label className="block text-xs text-gray-600 dark:text-gray-400">
            系统提示词
          </label>
          <textarea
            value={model.parameters.systemPrompt || ''}
            onChange={(e) => onParameterChange('systemPrompt', e.target.value)}
            disabled={!isEditing}
            placeholder="设置 AI 的行为和角色..."
            rows={3}
            className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-800 dark:text-white disabled:bg-gray-100 dark:disabled:bg-gray-800 disabled:cursor-not-allowed focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm resize-none"
          />
        </div>
      </div>

      {/* Test Connection */}
      <div className="flex items-center gap-4 pt-4 border-t border-gray-200 dark:border-gray-700">
        <button
          onClick={onTestConnection}
          disabled={testStatus === 'testing'}
          className="flex items-center gap-2 px-4 py-2 bg-gray-100 hover:bg-gray-200 dark:bg-gray-700 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-300 rounded-lg transition-colors disabled:opacity-50"
        >
          {testStatus === 'testing' ? (
            <Loader2 size={18} className="animate-spin" />
          ) : testStatus === 'success' ? (
            <Wifi size={18} className="text-green-500" />
          ) : testStatus === 'error' ? (
            <WifiOff size={18} className="text-red-500" />
          ) : (
            <Wifi size={18} />
          )}
          测试连接
        </button>
        {testMessage && (
          <span
            className={`text-sm ${
              testStatus === 'success' ? 'text-green-600' : 'text-red-600'
            }`}
          >
            {testMessage}
          </span>
        )}
      </div>
    </div>
  );
};

export default ModelConfigForm;
