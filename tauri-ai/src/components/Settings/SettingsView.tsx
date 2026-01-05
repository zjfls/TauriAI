/**
 * SettingsView Component
 * Tabbed interface for application settings
 * Requirements: 2.1
 */

import React, { useState } from 'react';
import { Bot, Palette, Sliders, Zap } from 'lucide-react';
import { ModelConfigForm } from './ModelConfigForm';
import { PresetManager } from './PresetManager';
import { useConfigStore } from '../../stores/configStore';
import { useUIStore } from '../../stores/uiStore';
import type { AppConfig, Theme } from '../../types';

type SettingsTab = 'models' | 'presets' | 'appearance' | 'general';

interface TabButtonProps {
  icon: React.ReactNode;
  label: string;
  active: boolean;
  onClick: () => void;
}

const TabButton: React.FC<TabButtonProps> = ({ icon, label, active, onClick }) => (
  <button
    onClick={onClick}
    className={`
      flex items-center gap-2 px-4 py-2.5 text-sm font-medium rounded-lg transition-colors
      ${active
        ? 'bg-blue-100 text-blue-600 dark:bg-blue-900/50 dark:text-blue-400'
        : 'text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800'
      }
    `}
  >
    {icon}
    <span>{label}</span>
  </button>
);

export const SettingsView: React.FC = () => {
  const [activeTab, setActiveTab] = useState<SettingsTab>('models');
  const { config, saveConfig } = useConfigStore();
  const { theme, setTheme } = useUIStore();

  const tabs: { id: SettingsTab; icon: React.ReactNode; label: string }[] = [
    { id: 'models', icon: <Bot size={18} />, label: '模型配置' },
    { id: 'presets', icon: <Zap size={18} />, label: '预设管理' },
    { id: 'appearance', icon: <Palette size={18} />, label: '外观设置' },
    { id: 'general', icon: <Sliders size={18} />, label: '通用设置' },
  ];

  /**
   * Handle theme change - updates both UI store and config store
   * Requirements: 2.6
   */
  const handleThemeChange = (newTheme: Theme) => {
    // Update UI store (applies theme immediately)
    setTheme(newTheme);
    
    // Persist to config store
    if (!config) return;
    const updatedConfig: AppConfig = {
      ...config,
      appearance: { ...config.appearance, theme: newTheme },
    };
    saveConfig(updatedConfig);
  };

  const handleAlwaysOnTopChange = (alwaysOnTop: boolean) => {
    if (!config) return;
    const updatedConfig: AppConfig = {
      ...config,
      appearance: { ...config.appearance, alwaysOnTop },
    };
    saveConfig(updatedConfig);
  };

  const handleLanguageChange = (language: string) => {
    if (!config) return;
    const updatedConfig: AppConfig = {
      ...config,
      general: { ...config.general, language },
    };
    saveConfig(updatedConfig);
  };

  const handleAutoStartChange = (autoStart: boolean) => {
    if (!config) return;
    const updatedConfig: AppConfig = {
      ...config,
      general: { ...config.general, autoStart },
    };
    saveConfig(updatedConfig);
  };

  const renderTabContent = () => {
    if (!config) {
      return (
        <div className="flex items-center justify-center h-64">
          <p className="text-gray-500 dark:text-gray-400">加载配置中...</p>
        </div>
      );
    }

    switch (activeTab) {
      case 'models':
        return <ModelConfigForm />;
      case 'presets':
        return <PresetManager />;
      case 'appearance':
        return (
          <AppearanceSettings
            theme={theme}
            alwaysOnTop={config.appearance.alwaysOnTop}
            onThemeChange={handleThemeChange}
            onAlwaysOnTopChange={handleAlwaysOnTopChange}
          />
        );
      case 'general':
        return (
          <GeneralSettings
            language={config.general.language}
            autoStart={config.general.autoStart}
            onLanguageChange={handleLanguageChange}
            onAutoStartChange={handleAutoStartChange}
          />
        );
      default:
        return null;
    }
  };

  return (
    <div className="flex flex-col h-full bg-gray-50 dark:bg-gray-900">
      {/* Tab Navigation */}
      <div className="flex gap-2 p-4 border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800">
        {tabs.map((tab) => (
          <TabButton
            key={tab.id}
            icon={tab.icon}
            label={tab.label}
            active={activeTab === tab.id}
            onClick={() => setActiveTab(tab.id)}
          />
        ))}
      </div>

      {/* Tab Content */}
      <div className="flex-1 overflow-auto p-6">
        {renderTabContent()}
      </div>
    </div>
  );
};

/**
 * Appearance Settings Panel
 */
interface AppearanceSettingsProps {
  theme: Theme;
  alwaysOnTop: boolean;
  onThemeChange: (theme: Theme) => void;
  onAlwaysOnTopChange: (value: boolean) => void;
}

const AppearanceSettings: React.FC<AppearanceSettingsProps> = ({
  theme,
  alwaysOnTop,
  onThemeChange,
  onAlwaysOnTopChange,
}) => {
  const themeOptions: { value: Theme; label: string }[] = [
    { value: 'system', label: '跟随系统' },
    { value: 'light', label: '浅色模式' },
    { value: 'dark', label: '深色模式' },
  ];

  return (
    <div className="max-w-2xl space-y-6">
      <h2 className="text-lg font-semibold text-gray-800 dark:text-white">外观设置</h2>
      
      {/* Theme Selection */}
      <div className="space-y-3">
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
          主题
        </label>
        <div className="flex gap-3">
          {themeOptions.map((option) => (
            <button
              key={option.value}
              onClick={() => onThemeChange(option.value)}
              className={`
                px-4 py-2 rounded-lg text-sm font-medium transition-colors
                ${theme === option.value
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600'
                }
              `}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      {/* Always on Top */}
      <div className="flex items-center justify-between">
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
            窗口置顶
          </label>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            保持窗口始终在其他窗口之上
          </p>
        </div>
        <button
          onClick={() => onAlwaysOnTopChange(!alwaysOnTop)}
          className={`
            relative w-11 h-6 rounded-full transition-colors
            ${alwaysOnTop ? 'bg-blue-600' : 'bg-gray-300 dark:bg-gray-600'}
          `}
        >
          <span
            className={`
              absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform
              ${alwaysOnTop ? 'translate-x-5' : 'translate-x-0'}
            `}
          />
        </button>
      </div>
    </div>
  );
};

/**
 * General Settings Panel
 */
interface GeneralSettingsProps {
  language: string;
  autoStart: boolean;
  onLanguageChange: (language: string) => void;
  onAutoStartChange: (value: boolean) => void;
}

const GeneralSettings: React.FC<GeneralSettingsProps> = ({
  language,
  autoStart,
  onLanguageChange,
  onAutoStartChange,
}) => {
  const languageOptions = [
    { value: 'zh-CN', label: '简体中文' },
    { value: 'en-US', label: 'English' },
  ];

  return (
    <div className="max-w-2xl space-y-6">
      <h2 className="text-lg font-semibold text-gray-800 dark:text-white">通用设置</h2>
      
      {/* Language Selection */}
      <div className="space-y-2">
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
          语言
        </label>
        <select
          value={language}
          onChange={(e) => onLanguageChange(e.target.value)}
          className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-800 dark:text-white focus:ring-2 focus:ring-blue-500 focus:border-transparent"
        >
          {languageOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>

      {/* Auto Start */}
      <div className="flex items-center justify-between">
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
            开机自启动
          </label>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            系统启动时自动运行 TauriAI
          </p>
        </div>
        <button
          onClick={() => onAutoStartChange(!autoStart)}
          className={`
            relative w-11 h-6 rounded-full transition-colors
            ${autoStart ? 'bg-blue-600' : 'bg-gray-300 dark:bg-gray-600'}
          `}
        >
          <span
            className={`
              absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform
              ${autoStart ? 'translate-x-5' : 'translate-x-0'}
            `}
          />
        </button>
      </div>
    </div>
  );
};

export default SettingsView;
