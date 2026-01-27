/**
 * McpModal Component
 * Shows MCP set binding + enabled tools for current agent
 */

import React, { useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { X, RefreshCw } from 'lucide-react';
import { useConfigStore } from '../../stores/configStore';

type McpToolInfo = { name: string; description?: string; inputSchema: unknown };
type McpTestResult = { success: boolean; message: string; tools: McpToolInfo[] };

interface McpModalProps {
  isOpen: boolean;
  onClose: () => void;
  agentName: string;
}

export const McpModal: React.FC<McpModalProps> = ({ isOpen, onClose, agentName }) => {
  const config = useConfigStore((s) => s.config);
  const [testingServer, setTestingServer] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<McpTestResult | null>(null);

  const agent = useMemo(() => config?.agents.find((a) => a.name === agentName), [config, agentName]);
  const setName = agent?.mcpSet;
  const mcpSet = useMemo(
    () => (setName ? config?.mcp?.sets.find((s) => s.name === setName) : undefined),
    [config, setName]
  );

  const mcpPermissionEnabled = Boolean(config?.tools?.permissions?.mcpExec);

  const testServer = async (serverName: string) => {
    setTestingServer(serverName);
    setTestResult(null);
    try {
      const res = await invoke<McpTestResult>('test_mcp_server', { serverName });
      setTestResult(res);
    } catch (e) {
      setTestResult({ success: false, message: String(e), tools: [] });
    } finally {
      setTestingServer(null);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="w-full max-w-3xl max-h-[85vh] overflow-auto rounded-xl bg-white dark:bg-gray-900 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-gray-200 dark:border-gray-700 px-5 py-4">
          <div>
            <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">MCP</h2>
            <p className="text-xs text-gray-500">
              agent: <span className="font-mono">{agentName}</span>
              {setName ? (
                <>
                  {' '}| set: <span className="font-mono">{setName}</span>
                </>
              ) : (
                <> | 未绑定 MCP set</>
              )}
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800"
            title="关闭"
          >
            <X size={18} />
          </button>
        </div>

        <div className="p-5 space-y-4">
          <div className="rounded-lg border border-gray-200 dark:border-gray-700 p-4 bg-gray-50 dark:bg-gray-800">
            <div className="text-sm text-gray-700 dark:text-gray-300">
              MCP 工具权限：{mcpPermissionEnabled ? <span className="text-green-600">已开启</span> : <span className="text-red-600">未开启</span>}
            </div>
            <p className="mt-1 text-xs text-gray-500">
              提示：若「工具 → 允许 MCP 工具调用」关闭，则不会向模型暴露 <span className="font-mono">mcp__*</span> 工具。
            </p>
          </div>

          {!mcpSet ? (
            <div className="text-sm text-gray-500 dark:text-gray-400">
              {setName ? '未找到该 MCP set（可能已删除）' : '该 agent 未绑定 MCP set'}
            </div>
          ) : (
            <div className="space-y-3">
              {mcpSet.servers.length === 0 ? (
                <div className="text-sm text-gray-500 dark:text-gray-400">该 MCP set 暂无 server</div>
              ) : (
                mcpSet.servers.map((ss) => (
                  <div key={ss.server} className="rounded-lg border border-gray-200 dark:border-gray-700 p-4">
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-sm font-medium text-gray-900 dark:text-gray-100">
                        {ss.server} {ss.enabled ? '' : <span className="text-xs text-gray-500">（已禁用）</span>}
                      </div>
                      <button
                        onClick={() => testServer(ss.server)}
                        disabled={testingServer === ss.server}
                        className="px-3 py-1.5 text-sm bg-gray-100 hover:bg-gray-200 dark:bg-gray-800 dark:hover:bg-gray-700 rounded-lg flex items-center gap-1 disabled:opacity-60"
                        title="测试连接"
                      >
                        <RefreshCw size={16} />
                        测试
                      </button>
                    </div>

                    <div className="mt-3 grid grid-cols-2 gap-3">
                      <div>
                        <div className="text-xs text-gray-500 mb-1">enabledTools（空=全部允许）</div>
                        <pre className="text-xs bg-gray-50 dark:bg-gray-800 p-2 rounded border border-gray-200 dark:border-gray-700 overflow-auto max-h-28">
                          {ss.enabledTools.length ? ss.enabledTools.join('\n') : '（全部）'}
                        </pre>
                      </div>
                      <div>
                        <div className="text-xs text-gray-500 mb-1">disabledTools</div>
                        <pre className="text-xs bg-gray-50 dark:bg-gray-800 p-2 rounded border border-gray-200 dark:border-gray-700 overflow-auto max-h-28">
                          {ss.disabledTools.length ? ss.disabledTools.join('\n') : '（无）'}
                        </pre>
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          )}

          {testResult && (
            <div className="rounded-lg border border-gray-200 dark:border-gray-700 p-4 bg-white dark:bg-gray-900">
              <div className="text-sm">
                <span className={testResult.success ? 'text-green-600' : 'text-red-600'}>
                  {testResult.success ? '成功' : '失败'}
                </span>
                <span className="ml-2 text-gray-700 dark:text-gray-300">{testResult.message}</span>
              </div>
              {testResult.tools.length > 0 && (
                <div className="mt-2 text-xs text-gray-600 dark:text-gray-300">
                  tools: {testResult.tools.map((t) => t.name).join(', ')}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
