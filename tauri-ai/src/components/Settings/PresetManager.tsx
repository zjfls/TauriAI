/**
 * PresetManager Component
 * Manages presets (model config + system prompt combinations)
 * Requirements: 8.4
 */

import React, { useState, useEffect } from 'react';
import { Plus, Trash2, Edit2, Check, X, Zap } from 'lucide-react';
import { useConfigStore } from '../../stores/configStore';
import type { Preset, ModelParameters, AppConfig } from '../../types';

// Generate unique ID
const generateId = () => `preset_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

// Create default preset
const createDefaultPreset = (): Preset => ({
  id: generateId(),
  name: '',
  modelConfigId: '',
  systemPrompt: '',
  parametersOverride: undefined,
});

export const PresetManager: React.FC = () => {
  const { config, saveConfig } = useConfigStore();
  const [selectedPresetId, setSelectedPresetId] = useState<string | null>(null);
  const [editingPreset, setEditingPreset] = useState<Preset | null>(null);
  const [isCreating, setIsCreating] = useState(false);

  const presets = config?.presets || [];
  const models = config?.models || [];

  // Select first preset by default
  useEffect(() => {
    if (presets.length > 0 && !selectedPresetId) {
      setSelectedPresetId(presets[0].id);
    }
  }, [presets, selectedPresetId]);

  const handleSelectPreset = (presetId: string) => {
    setSelectedPresetId(presetId);
    setEditingPreset(null);
    setIsCreating(false);
  };

  const handleCreateNew = () => {
    setIsCreating(true);
    const newPreset = createDefaultPreset();
    // Set default model if available
    if (models.length > 0) {
      newPreset.modelConfigId = models[0].id;
    }
    setEditingPreset(newPreset);
    setSelectedPresetId(null);
  };

  const handleEdit = () => {
    const preset = presets.find((p) => p.id === selectedPresetId);
    if (preset) {
      setEditingPreset({ ...preset });
    }
  };

  const handleCancel = () => {
    setEditingPreset(null);
    setIsCreating(false);
    if (presets.length > 0) {
      setSelectedPresetId(presets[0].id);
    }
  };

  const handleSave = () => {
    if (!editingPreset || !editingPreset.name.trim() || !config) return;

    let updatedPresets: Preset[];
    if (isCreating) {
      updatedPresets = [...presets, editingPreset];
      setSelectedPresetId(editingPreset.id);
    } else {
      updatedPresets = presets.map((p) => (p.id === editingPreset.id ? editingPreset : p));
    }

    const updatedConfig: AppConfig = {
      ...config,
      presets: updatedPresets,
    };
    saveConfig(updatedConfig);
    setEditingPreset(null);
    setIsCreating(false);
  };

  const handleDelete = () => {
    if (!selectedPresetId || !config) return;
    if (confirm('确定要删除这个预设吗？')) {
      const updatedPresets = presets.filter((p) => p.id !== selectedPresetId);
      const updatedConfig: AppConfig = {
        ...config,
        presets: updatedPresets,
      };
      saveConfig(updatedConfig);
      setSelectedPresetId(updatedPresets.length > 0 ? updatedPresets[0].id : null);
    }
  };

  const updateEditingField = <K extends keyof Preset>(field: K, value: Preset[K]) => {
    if (editingPreset) {
      setEditingPreset({ ...editingPreset, [field]: value });
    }
  };

  const updateParameterOverride = <K extends keyof ModelParameters>(
    field: K,
    value: ModelParameters[K] | undefined
  ) => {
    if (editingPreset) {
      const currentOverrides = editingPreset.parametersOverride || {};
      const newOverrides = { ...currentOverrides, [field]: value };
      // Remove undefined values
      Object.keys(newOverrides).forEach((key) => {
        if (newOverrides[key as keyof ModelParameters] === undefined) {
          delete newOverrides[key as keyof ModelParameters];
        }
      });
      setEditingPreset({
        ...editingPreset,
        parametersOverride: Object.keys(newOverrides).length > 0 ? newOverrides : undefined,
      });
    }
  };

  const currentPreset = editingPreset || presets.find((p) => p.id === selectedPresetId);

  return (
    <div className="flex gap-6 h-full">
      {/* Preset List */}
      <div className="w-64 flex-shrink-0">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300">预设列表</h3>
          <button
            onClick={handleCreateNew}
            className="p-1.5 rounded-lg text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/30 transition-colors"
            title="添加预设"
          >
            <Plus size={18} />
          </button>
        </div>
        <div className="space-y-1">
          {presets.map((preset) => (
            <button
              key={preset.id}
              onClick={() => handleSelectPreset(preset.id)}
              className={`
                w-full flex items-center gap-2 px-3 py-2 rounded-lg text-left transition-colors
                ${selectedPresetId === preset.id && !isCreating
                  ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-300'
                  : 'text-gray-700 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700'
                }
              `}
            >
              <Zap size={16} className="flex-shrink-0 text-yellow-500" />
              <span className="flex-1 truncate text-sm">{preset.name || '未命名'}</span>
            </button>
          ))}
          {isCreating && (
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-300 text-sm">
              <Zap size={16} className="text-yellow-500" />
              新建预设
            </div>
          )}
          {presets.length === 0 && !isCreating && (
            <p className="text-sm text-gray-500 dark:text-gray-400 px-3 py-2">
              暂无预设
            </p>
          )}
        </div>
      </div>

      {/* Preset Form */}
      <div className="flex-1 min-w-0">
        {currentPreset ? (
          <PresetForm
            preset={currentPreset}
            models={models}
            isEditing={!!editingPreset}
            onFieldChange={updateEditingField}
            onParameterOverrideChange={updateParameterOverride}
            onEdit={handleEdit}
            onSave={handleSave}
            onCancel={handleCancel}
            onDelete={handleDelete}
          />
        ) : (
          <div className="flex items-center justify-center h-64 text-gray-500 dark:text-gray-400">
            {presets.length === 0 ? '点击 + 创建第一个预设' : '选择一个预设查看详情'}
          </div>
        )}
      </div>
    </div>
  );
};


/**
 * Preset Form Component
 * Displays and edits preset details
 */
interface PresetFormProps {
  preset: Preset;
  models: { id: string; name: string }[];
  isEditing: boolean;
  onFieldChange: <K extends keyof Preset>(field: K, value: Preset[K]) => void;
  onParameterOverrideChange: <K extends keyof ModelParameters>(
    field: K,
    value: ModelParameters[K] | undefined
  ) => void;
  onEdit: () => void;
  onSave: () => void;
  onCancel: () => void;
  onDelete: () => void;
}

const PresetForm: React.FC<PresetFormProps> = ({
  preset,
  models,
  isEditing,
  onFieldChange,
  onParameterOverrideChange,
  onEdit,
  onSave,
  onCancel,
  onDelete,
}) => {
  const selectedModel = models.find((m) => m.id === preset.modelConfigId);

  return (
    <div className="space-y-6">
      {/* Header with Actions */}
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-gray-800 dark:text-white">
          {isEditing ? (preset.name ? '编辑预设' : '新建预设') : '预设详情'}
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
      <div className="space-y-4">
        {/* Name */}
        <div className="space-y-1">
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
            预设名称 <span className="text-red-500">*</span>
          </label>
          <input
            type="text"
            value={preset.name}
            onChange={(e) => onFieldChange('name', e.target.value)}
            disabled={!isEditing}
            placeholder="例如：代码助手"
            className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-800 dark:text-white disabled:bg-gray-100 dark:disabled:bg-gray-800 disabled:cursor-not-allowed focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          />
        </div>

        {/* Model Selection */}
        <div className="space-y-1">
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
            关联模型
          </label>
          <select
            value={preset.modelConfigId}
            onChange={(e) => onFieldChange('modelConfigId', e.target.value)}
            disabled={!isEditing}
            className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-800 dark:text-white disabled:bg-gray-100 dark:disabled:bg-gray-800 disabled:cursor-not-allowed focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          >
            <option value="">选择模型</option>
            {models.map((model) => (
              <option key={model.id} value={model.id}>
                {model.name}
              </option>
            ))}
          </select>
          {!isEditing && selectedModel && (
            <p className="text-xs text-gray-500 dark:text-gray-400">
              当前关联: {selectedModel.name}
            </p>
          )}
        </div>

        {/* System Prompt */}
        <div className="space-y-1">
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
            系统提示词
          </label>
          <textarea
            value={preset.systemPrompt}
            onChange={(e) => onFieldChange('systemPrompt', e.target.value)}
            disabled={!isEditing}
            placeholder="设置 AI 的行为和角色，例如：你是一个专业的代码助手..."
            rows={6}
            className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-800 dark:text-white disabled:bg-gray-100 dark:disabled:bg-gray-800 disabled:cursor-not-allowed focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-none"
          />
        </div>

        {/* Parameter Overrides */}
        <div className="space-y-3">
          <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300">
            参数覆盖 <span className="text-xs text-gray-500">(可选)</span>
          </h3>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            这些参数将覆盖关联模型的默认参数
          </p>

          <div className="grid grid-cols-2 gap-4">
            {/* Temperature Override */}
            <div className="space-y-1">
              <label className="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-400">
                <input
                  type="checkbox"
                  checked={preset.parametersOverride?.temperature !== undefined}
                  onChange={(e) => {
                    if (e.target.checked) {
                      onParameterOverrideChange('temperature', 0.7);
                    } else {
                      onParameterOverrideChange('temperature', undefined);
                    }
                  }}
                  disabled={!isEditing}
                  className="rounded"
                />
                Temperature: {preset.parametersOverride?.temperature ?? '默认'}
              </label>
              {preset.parametersOverride?.temperature !== undefined && (
                <input
                  type="range"
                  min="0"
                  max="2"
                  step="0.1"
                  value={preset.parametersOverride.temperature}
                  onChange={(e) => onParameterOverrideChange('temperature', parseFloat(e.target.value))}
                  disabled={!isEditing}
                  className="w-full"
                />
              )}
            </div>

            {/* Max Tokens Override */}
            <div className="space-y-1">
              <label className="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-400">
                <input
                  type="checkbox"
                  checked={preset.parametersOverride?.maxTokens !== undefined}
                  onChange={(e) => {
                    if (e.target.checked) {
                      onParameterOverrideChange('maxTokens', 2048);
                    } else {
                      onParameterOverrideChange('maxTokens', undefined);
                    }
                  }}
                  disabled={!isEditing}
                  className="rounded"
                />
                最大 Token 数
              </label>
              {preset.parametersOverride?.maxTokens !== undefined && (
                <input
                  type="number"
                  value={preset.parametersOverride.maxTokens}
                  onChange={(e) => onParameterOverrideChange('maxTokens', parseInt(e.target.value) || undefined)}
                  disabled={!isEditing}
                  className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-800 dark:text-white disabled:bg-gray-100 dark:disabled:bg-gray-800 disabled:cursor-not-allowed focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm"
                />
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Usage Hint */}
      {!isEditing && (
        <div className="p-4 bg-blue-50 dark:bg-blue-900/20 rounded-lg">
          <p className="text-sm text-blue-700 dark:text-blue-300">
            💡 提示：预设可以快速切换不同的 AI 角色和参数配置。在聊天界面中选择预设即可应用。
          </p>
        </div>
      )}
    </div>
  );
};

export default PresetManager;
