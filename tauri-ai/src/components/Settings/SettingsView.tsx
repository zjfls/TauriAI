/**
 * SettingsView Component
 * Tabbed interface for application settings
 */

import React, { useState } from 'react';
import { Server, Bot, Palette, Sliders, Wrench, Shield, Plug, Sparkles, ChevronDown } from 'lucide-react';
import { ProviderConfigForm } from './ProviderConfigForm';
import { AgentConfigForm } from './AgentConfigForm';
import { ToolsConfigForm } from './ToolsConfigForm';
import { SecurityConfigForm } from './SecurityConfigForm';
import { McpConfigForm } from './McpConfigForm';
import { SkillsConfigForm } from './SkillsConfigForm';
import { SecretInput } from './SecretInput';
import { useConfigStore } from '../../stores/configStore';
import { useUIStore } from '../../stores/uiStore';
import type { AppConfig, Theme, AnsiColorMode, AnsiRenderMode, WebSearchToolSettings } from '../../types';

type SettingsTab = 'providers' | 'agents' | 'tools' | 'mcp' | 'skills' | 'security' | 'appearance' | 'general';

interface TabButtonProps {
  icon: React.ReactNode;
  label: string;
  active: boolean;
  onClick: () => void;
}

const TabButton: React.FC<TabButtonProps> = ({ icon, label, active, onClick }) => (
  <button
    onClick={onClick}
    className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium rounded-lg transition-colors ${
      active
        ? 'bg-blue-100 text-blue-600 dark:bg-blue-900/50 dark:text-blue-400'
        : 'text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800'
    }`}
  >
    {icon}
    <span>{label}</span>
  </button>
);

export const SettingsView: React.FC = () => {
  const [activeTab, setActiveTab] = useState<SettingsTab>('providers');
  const { config, saveConfig } = useConfigStore();
  const { theme, setTheme } = useUIStore();

  const tabs: { id: SettingsTab; icon: React.ReactNode; label: string }[] = [
    { id: 'providers', icon: <Server size={18} />, label: '提供商' },
    { id: 'agents', icon: <Bot size={18} />, label: '智能体' },
    { id: 'tools', icon: <Wrench size={18} />, label: '工具' },
    { id: 'mcp', icon: <Plug size={18} />, label: 'MCP' },
    { id: 'skills', icon: <Sparkles size={18} />, label: 'Skills' },
    { id: 'security', icon: <Shield size={18} />, label: '安全' },
    { id: 'appearance', icon: <Palette size={18} />, label: '外观' },
    { id: 'general', icon: <Sliders size={18} />, label: '通用' },
  ];

  const handleThemeChange = (newTheme: Theme) => {
    setTheme(newTheme);
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

  const handleDebugModeChange = (debugMode: boolean) => {
    if (!config) return;
    const updatedConfig: AppConfig = {
      ...config,
      general: { ...config.general, debugMode },
    };
    saveConfig(updatedConfig);
  };

  const handleDebugSseChange = (debugSse: boolean) => {
    if (!config) return;
    const updatedConfig: AppConfig = {
      ...config,
      general: { ...config.general, debugSse },
    };
    saveConfig(updatedConfig);
  };

  const handleShowUsageChange = (showUsage: boolean) => {
    if (!config) return;
    const updatedConfig: AppConfig = {
      ...config,
      general: { ...config.general, showUsage },
    };
    saveConfig(updatedConfig);
  };

  const handleAnsiRenderModeChange = (ansiRenderMode: AnsiRenderMode) => {
    if (!config) return;
    const updatedConfig: AppConfig = {
      ...config,
      general: { ...config.general, ansiRenderMode },
    };
    saveConfig(updatedConfig);
  };

  const handleAnsiColorModeChange = (ansiColorMode: AnsiColorMode) => {
    if (!config) return;
    const updatedConfig: AppConfig = {
      ...config,
      general: { ...config.general, ansiColorMode },
    };
    saveConfig(updatedConfig);
  };

  const handleWebSearchToolChange = (webSearchTool: WebSearchToolSettings) => {
    if (!config) return;
    const updatedConfig: AppConfig = {
      ...config,
      general: { ...config.general, webSearchTool },
    };
    saveConfig(updatedConfig);
  };

  const handleOpenDevtoolsOnStartChange = (openDevtoolsOnStart: boolean) => {
    if (!config) return;
    const updatedConfig: AppConfig = {
      ...config,
      general: { ...config.general, openDevtoolsOnStart },
    };
    saveConfig(updatedConfig);
  };

  const handlePdfDebugModeChange = (pdfDebugMode: boolean) => {
    if (!config) return;
    const updatedConfig: AppConfig = {
      ...config,
      general: { ...config.general, pdfDebugMode },
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
      case 'providers':
        return <ProviderConfigForm />;
      case 'agents':
        return <AgentConfigForm />;
      case 'tools':
        return <ToolsConfigForm />;
      case 'mcp':
        return <McpConfigForm />;
      case 'skills':
        return <SkillsConfigForm />;
      case 'security':
        return <SecurityConfigForm />;
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
            debugMode={config.general.debugMode ?? false}
            debugSse={config.general.debugSse ?? false}
            openDevtoolsOnStart={config.general.openDevtoolsOnStart ?? false}
            showUsage={config.general.showUsage ?? true}
            pdfDebugMode={config.general.pdfDebugMode ?? false}
            ansiRenderMode={config.general.ansiRenderMode ?? 'color'}
            ansiColorMode={config.general.ansiColorMode ?? 'auto'}
            webSearchTool={config.general.webSearchTool}
            onLanguageChange={handleLanguageChange}
            onAutoStartChange={handleAutoStartChange}
            onDebugModeChange={handleDebugModeChange}
            onDebugSseChange={handleDebugSseChange}
            onOpenDevtoolsOnStartChange={handleOpenDevtoolsOnStartChange}
            onShowUsageChange={handleShowUsageChange}
            onPdfDebugModeChange={handlePdfDebugModeChange}
            onAnsiRenderModeChange={handleAnsiRenderModeChange}
            onAnsiColorModeChange={handleAnsiColorModeChange}
            onWebSearchToolChange={handleWebSearchToolChange}
          />
        );
      default:
        return null;
    }
  };

  return (
    <div className="flex flex-col h-full bg-gray-50 dark:bg-gray-900">
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
      <div className="flex-1 overflow-auto p-6">{renderTabContent()}</div>
    </div>
  );
};

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
    { value: 'tokyo-night', label: 'Tokyo Night' },
    { value: 'dracula', label: 'Dracula' },
    { value: 'nord', label: 'Nord' },
    { value: 'catppuccin', label: 'Catppuccin' },
    { value: 'solarized', label: 'Solarized' },
  ];

  return (
    <div className="max-w-2xl space-y-6">
      <h2 className="text-lg font-semibold text-gray-800 dark:text-white">外观设置</h2>
      <div className="space-y-3">
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">主题</label>
        <div className="flex gap-3">
          {themeOptions.map((option) => (
            <button
              key={option.value}
              onClick={() => onThemeChange(option.value)}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                theme === option.value
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300'
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
      <div className="flex items-center justify-between">
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">窗口置顶</label>
          <p className="text-xs text-gray-500">保持窗口始终在其他窗口之上</p>
        </div>
        <button
          onClick={() => onAlwaysOnTopChange(!alwaysOnTop)}
          className={`relative w-11 h-6 rounded-full transition-colors ${alwaysOnTop ? 'bg-blue-600' : 'bg-gray-300 dark:bg-gray-600'}`}
        >
          <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${alwaysOnTop ? 'translate-x-5' : ''}`} />
        </button>
      </div>
    </div>
  );
};

interface GeneralSettingsProps {
  language: string;
  autoStart: boolean;
  debugMode: boolean;
  debugSse: boolean;
  openDevtoolsOnStart: boolean;
  showUsage: boolean;
  pdfDebugMode: boolean;
  ansiRenderMode: AnsiRenderMode;
  ansiColorMode: AnsiColorMode;
  webSearchTool?: WebSearchToolSettings;
  onLanguageChange: (language: string) => void;
  onAutoStartChange: (value: boolean) => void;
  onDebugModeChange: (value: boolean) => void;
  onDebugSseChange: (value: boolean) => void;
  onOpenDevtoolsOnStartChange: (value: boolean) => void;
  onShowUsageChange: (value: boolean) => void;
  onPdfDebugModeChange: (value: boolean) => void;
  onAnsiRenderModeChange: (value: AnsiRenderMode) => void;
  onAnsiColorModeChange: (value: AnsiColorMode) => void;
  onWebSearchToolChange: (value: WebSearchToolSettings) => void;
}

const GeneralSettings: React.FC<GeneralSettingsProps> = ({
  language,
  autoStart,
  debugMode,
  debugSse,
  openDevtoolsOnStart,
  showUsage,
  pdfDebugMode,
  ansiRenderMode,
  ansiColorMode,
  webSearchTool,
  onLanguageChange,
  onAutoStartChange,
  onDebugModeChange,
  onDebugSseChange,
  onOpenDevtoolsOnStartChange,
  onShowUsageChange,
  onPdfDebugModeChange,
  onAnsiRenderModeChange,
  onAnsiColorModeChange,
  onWebSearchToolChange,
}) => {
  const languageOptions = [
    { value: 'zh-CN', label: '简体中文' },
    { value: 'en-US', label: 'English' },
  ];

  const ansiRenderOptions: { value: AnsiRenderMode; label: string }[] = [
    { value: 'color', label: '彩色（ANSI）' },
    { value: 'strip', label: '纯文本（去色）' },
    { value: 'raw', label: '原始控制码' },
  ];

  const ansiColorOptions: { value: AnsiColorMode; label: string }[] = [
    { value: 'auto', label: '跟随主题（VS Code）' },
    { value: 'vscode-dark', label: 'VS Code 深色' },
    { value: 'vscode-light', label: 'VS Code 浅色' },
    { value: 'xterm', label: 'xterm（经典）' },
  ];

  const [sections, setSections] = useState({
    general: true,
    debug: true,
    display: true,
    webSearch: true,
  });

  const toggleSection = (key: keyof typeof sections) => {
    setSections((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const SettingsSection: React.FC<{
    title: string;
    open: boolean;
    onToggle: () => void;
    children: React.ReactNode;
  }> = ({ title, open, onToggle, children }) => (
    <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800">
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center justify-between px-4 py-3 text-left"
      >
        <span className="text-sm font-semibold text-gray-800 dark:text-white">{title}</span>
        <ChevronDown
          size={18}
          className={`text-gray-500 transition-transform ${open ? 'rotate-0' : '-rotate-90'}`}
        />
      </button>
      {open && <div className="px-4 pb-4 space-y-4">{children}</div>}
    </div>
  );

  return (
    <div className="max-w-2xl space-y-6">
      <h2 className="text-lg font-semibold text-gray-800 dark:text-white">通用设置</h2>

      <SettingsSection
        title="通用"
        open={sections.general}
        onToggle={() => toggleSection('general')}
      >
        <div className="space-y-2">
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">语言</label>
          <select
            value={language}
            onChange={(e) => onLanguageChange(e.target.value)}
            className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700"
          >
            {languageOptions.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </div>

        <div className="flex items-center justify-between">
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">开机自启动</label>
            <p className="text-xs text-gray-500">系统启动时自动运行</p>
          </div>
          <button
            onClick={() => onAutoStartChange(!autoStart)}
            className={`relative w-11 h-6 rounded-full transition-colors ${autoStart ? 'bg-blue-600' : 'bg-gray-300 dark:bg-gray-600'}`}
          >
            <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${autoStart ? 'translate-x-5' : ''}`} />
          </button>
        </div>
      </SettingsSection>

      <SettingsSection
        title="调试"
        open={sections.debug}
        onToggle={() => toggleSection('debug')}
      >
        <div className="flex items-center justify-between">
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">调试模式</label>
            <p className="text-xs text-gray-500">显示原始 HTTP 请求/响应信息</p>
          </div>
          <button
            onClick={() => onDebugModeChange(!debugMode)}
            className={`relative w-11 h-6 rounded-full transition-colors ${debugMode ? 'bg-blue-600' : 'bg-gray-300 dark:bg-gray-600'}`}
          >
            <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${debugMode ? 'translate-x-5' : ''}`} />
          </button>
        </div>

        <div className="flex items-center justify-between">
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">输出流式 Raw 消息</label>
            <p className="text-xs text-gray-500">在控制台打印流式 SSE data（需开启调试模式）</p>
          </div>
          <button
            disabled={!debugMode}
            onClick={() => onDebugSseChange(!debugSse)}
            className={`relative w-11 h-6 rounded-full transition-colors ${
              debugSse ? 'bg-blue-600' : 'bg-gray-300 dark:bg-gray-600'
            } ${!debugMode ? 'opacity-60 cursor-not-allowed' : ''}`}
            title={!debugMode ? '请先开启调试模式' : debugSse ? '已开启' : '已关闭'}
          >
            <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${debugSse ? 'translate-x-5' : ''}`} />
          </button>
        </div>

        <div className="flex items-center justify-between">
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">启动时打开 DevTools</label>
            <p className="text-xs text-gray-500">仅开发模式生效，需要重启应用</p>
          </div>
          <button
            onClick={() => onOpenDevtoolsOnStartChange(!openDevtoolsOnStart)}
            className={`relative w-11 h-6 rounded-full transition-colors ${openDevtoolsOnStart ? 'bg-blue-600' : 'bg-gray-300 dark:bg-gray-600'}`}
          >
            <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${openDevtoolsOnStart ? 'translate-x-5' : ''}`} />
          </button>
        </div>

        <div className="flex items-center justify-between">
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">PDF 调试模式</label>
            <p className="text-xs text-gray-500">允许选择 PDF 的特定页面范围进行发送</p>
          </div>
          <button
            onClick={() => onPdfDebugModeChange(!pdfDebugMode)}
            className={`relative w-11 h-6 rounded-full transition-colors ${pdfDebugMode ? 'bg-blue-600' : 'bg-gray-300 dark:bg-gray-600'}`}
          >
            <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${pdfDebugMode ? 'translate-x-5' : ''}`} />
          </button>
        </div>
      </SettingsSection>

      <SettingsSection
        title="显示"
        open={sections.display}
        onToggle={() => toggleSection('display')}
      >
        <div className="space-y-2">
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">工具输出显示</label>
          <select
            value={ansiRenderMode}
            onChange={(e) => onAnsiRenderModeChange(e.target.value as AnsiRenderMode)}
            className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700"
          >
            {ansiRenderOptions.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
          <p className="text-xs text-gray-500">彩色模式会解析 ANSI 控制码显示颜色</p>
        </div>

        <div className="space-y-2">
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">ANSI 颜色方案</label>
          <select
            value={ansiColorMode}
            onChange={(e) => onAnsiColorModeChange(e.target.value as AnsiColorMode)}
            className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700"
          >
            {ansiColorOptions.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
          <p className="text-xs text-gray-500">仅影响 ANSI 16 色调色板，256 色与真彩保持不变</p>
        </div>

        <div className="flex items-center justify-between">
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">显示用量</label>
            <p className="text-xs text-gray-500">在消息中显示 Token 用量统计</p>
          </div>
          <button
            onClick={() => onShowUsageChange(!showUsage)}
            className={`relative w-11 h-6 rounded-full transition-colors ${showUsage ? 'bg-blue-600' : 'bg-gray-300 dark:bg-gray-600'}`}
          >
            <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${showUsage ? 'translate-x-5' : ''}`} />
          </button>
        </div>
      </SettingsSection>

      <SettingsSection
        title="网络搜索工具"
        open={sections.webSearch}
        onToggle={() => toggleSection('webSearch')}
      >
        {(() => {
          const current: WebSearchToolSettings = webSearchTool ?? {
            minIntervalMs: 1200,
            maxResults: 5,
          };

          const set = (next: Partial<WebSearchToolSettings>) => {
            onWebSearchToolChange({ ...current, ...next });
          };

          return (
            <div className="space-y-6">
              {/* 通用设置 */}
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">速率限制（最小间隔 ms）</label>
                  <input
                    type="number"
                    value={current.minIntervalMs ?? 1200}
                    onChange={(e) => set({ minIntervalMs: e.target.value ? Number(e.target.value) : undefined })}
                    className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700"
                  />
                </div>
                <div className="space-y-2">
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">最大返回条数</label>
                  <input
                    type="number"
                    value={current.maxResults ?? 5}
                    onChange={(e) => set({ maxResults: e.target.value ? Number(e.target.value) : undefined })}
                    className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700"
                  />
                </div>
              </div>

              {/* Tavily */}
              <div className="space-y-3 border border-gray-200 dark:border-gray-700 rounded-lg p-4">
                <div className="flex items-center justify-between">
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">Tavily</label>
                  <button
                    onClick={() => set({ tavilyEnabled: !current.tavilyEnabled })}
                    className={`relative w-11 h-6 rounded-full transition-colors ${current.tavilyEnabled ? 'bg-blue-600' : 'bg-gray-300 dark:bg-gray-600'}`}
                  >
                    <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${current.tavilyEnabled ? 'translate-x-5' : ''}`} />
                  </button>
                </div>
                {current.tavilyEnabled && (
                  <div className="space-y-2">
                    <SecretInput
                      value={current.tavilyApiKey ?? ''}
                      onChange={(e) => set({ tavilyApiKey: e.target.value || undefined })}
                      placeholder="Tavily API Key"
                      className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700"
                    />
                  </div>
                )}
              </div>

              {/* Brave Search */}
              <div className="space-y-3 border border-gray-200 dark:border-gray-700 rounded-lg p-4">
                <div className="flex items-center justify-between">
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">Brave Search</label>
                  <button
                    onClick={() => set({ braveEnabled: !current.braveEnabled })}
                    className={`relative w-11 h-6 rounded-full transition-colors ${current.braveEnabled ? 'bg-blue-600' : 'bg-gray-300 dark:bg-gray-600'}`}
                  >
                    <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${current.braveEnabled ? 'translate-x-5' : ''}`} />
                  </button>
                </div>
                {current.braveEnabled && (
                  <div className="space-y-2">
                    <SecretInput
                      value={current.braveApiKey ?? ''}
                      onChange={(e) => set({ braveApiKey: e.target.value || undefined })}
                      placeholder="Brave Search API Key"
                      className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700"
                    />
                  </div>
                )}
              </div>

              {/* Google CSE */}
              <div className="space-y-3 border border-gray-200 dark:border-gray-700 rounded-lg p-4">
                <div className="flex items-center justify-between">
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">Google CSE</label>
                  <button
                    onClick={() => set({ googleEnabled: !current.googleEnabled })}
                    className={`relative w-11 h-6 rounded-full transition-colors ${current.googleEnabled ? 'bg-blue-600' : 'bg-gray-300 dark:bg-gray-600'}`}
                  >
                    <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${current.googleEnabled ? 'translate-x-5' : ''}`} />
                  </button>
                </div>
                {current.googleEnabled && (
                  <div className="space-y-3">
                    <SecretInput
                      value={current.googleApiKey ?? ''}
                      onChange={(e) => set({ googleApiKey: e.target.value || undefined })}
                      placeholder="Google API Key"
                      className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700"
                    />
                    <input
                      value={current.googleCx ?? ''}
                      onChange={(e) => set({ googleCx: e.target.value || undefined })}
                      placeholder="Custom Search Engine CX"
                      className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700"
                    />
                    <p className="text-xs text-gray-500">使用 Google Custom Search JSON API，需要同时配置 Key 与 CX。</p>
                  </div>
                )}
              </div>
            </div>
          );
        })()}
      </SettingsSection>
    </div>
  );
};

export default SettingsView;
