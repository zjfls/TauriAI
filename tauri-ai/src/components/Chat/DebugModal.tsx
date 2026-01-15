/**
 * DebugModal Component
 * Displays raw HTTP request/response information in a structured format
 */

import React, { useState } from 'react';
import { X, ChevronDown, ChevronRight, Copy, Check } from 'lucide-react';
import type { DebugInfo } from '../../types';

interface DebugModalProps {
  isOpen: boolean;
  onClose: () => void;
  debugInfo: DebugInfo | null;
  messageRole: 'user' | 'assistant' | 'error';
}

interface CollapsibleSectionProps {
  title: string;
  defaultExpanded?: boolean;
  children: React.ReactNode;
}

const CollapsibleSection: React.FC<CollapsibleSectionProps> = ({
  title,
  defaultExpanded = true,
  children,
}) => {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);

  return (
    <div className="border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full flex items-center gap-2 px-4 py-2 bg-gray-50 dark:bg-gray-800 text-left text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700"
      >
        {isExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        {title}
      </button>
      {isExpanded && (
        <div className="p-4 bg-white dark:bg-gray-900">{children}</div>
      )}
    </div>
  );
};

interface JsonViewerProps {
  data: unknown;
  label?: string;
}

// Check if response body contains SSE info
interface SseResponseBody {
  _sseInfo?: {
    chunkCount: number;
    note: string;
  };
  content?: string;
  thinking?: string | null;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    cached_tokens?: number;
    reasoning_tokens?: number;
  } | null;
}

const isSseResponseBody = (data: unknown): data is SseResponseBody => {
  return typeof data === 'object' && data !== null && '_sseInfo' in data;
};

const JsonViewer: React.FC<JsonViewerProps> = ({ data, label }) => {
  const [copied, setCopied] = useState(false);
  const jsonString = JSON.stringify(data, null, 2);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(jsonString);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="relative">
      {label && (
        <div className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
          {label}
        </div>
      )}
      <div className="relative group">
        <pre className="text-xs bg-gray-50 dark:bg-gray-800 p-3 rounded-lg overflow-auto max-h-64 text-gray-800 dark:text-gray-200">
          {jsonString}
        </pre>
        <button
          onClick={handleCopy}
          className="absolute top-2 right-2 p-1.5 rounded bg-gray-200 dark:bg-gray-700 opacity-0 group-hover:opacity-100 transition-opacity"
          title="复制"
        >
          {copied ? (
            <Check size={14} className="text-green-500" />
          ) : (
            <Copy size={14} className="text-gray-500 dark:text-gray-400" />
          )}
        </button>
      </div>
    </div>
  );
};

// Component to display SSE response in a more readable format
interface SseResponseViewerProps {
  data: SseResponseBody;
}

const SseResponseViewer: React.FC<SseResponseViewerProps> = ({ data }) => {
  const [copied, setCopied] = useState(false);

  const handleCopyContent = async () => {
    await navigator.clipboard.writeText(data.content || '');
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="space-y-4">
      {/* SSE Info Badge */}
      <div className="flex items-center gap-2">
        <span className="px-2 py-1 bg-purple-100 dark:bg-purple-900 text-purple-700 dark:text-purple-300 rounded text-xs font-medium">
          SSE Stream
        </span>
        <span className="text-xs text-gray-500 dark:text-gray-400">
          {data._sseInfo?.chunkCount} chunks
        </span>
      </div>

      {/* Usage Stats */}
      {data.usage && (
        <div className="p-3 bg-blue-50 dark:bg-blue-900/30 rounded-lg">
          <div className="text-xs font-medium text-blue-700 dark:text-blue-300 mb-2">Token 用量</div>
          <div className="grid grid-cols-3 gap-2 text-xs">
            <div>
              <span className="text-gray-500 dark:text-gray-400">输入: </span>
              <span className="text-gray-800 dark:text-gray-200">{data.usage.prompt_tokens}</span>
            </div>
            <div>
              <span className="text-gray-500 dark:text-gray-400">输出: </span>
              <span className="text-gray-800 dark:text-gray-200">{data.usage.completion_tokens}</span>
            </div>
            <div>
              <span className="text-gray-500 dark:text-gray-400">总计: </span>
              <span className="text-gray-800 dark:text-gray-200">{data.usage.total_tokens}</span>
            </div>
            {data.usage.cached_tokens && (
              <div>
                <span className="text-gray-500 dark:text-gray-400">缓存: </span>
                <span className="text-gray-800 dark:text-gray-200">{data.usage.cached_tokens}</span>
              </div>
            )}
            {data.usage.reasoning_tokens && (
              <div>
                <span className="text-gray-500 dark:text-gray-400">推理: </span>
                <span className="text-gray-800 dark:text-gray-200">{data.usage.reasoning_tokens}</span>
              </div>
            )}
          </div>
        </div>
      )}

      {!data.usage && (
        <div className="p-3 bg-yellow-50 dark:bg-yellow-900/30 rounded-lg">
          <div className="text-xs text-yellow-700 dark:text-yellow-300">
            ⚠️ 服务方未返回 Token 用量信息
          </div>
        </div>
      )}

      {/* Thinking Content */}
      {data.thinking && (
        <div>
          <div className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">思考内容</div>
          <pre className="text-xs bg-purple-50 dark:bg-purple-900/30 p-3 rounded-lg overflow-auto max-h-32 text-purple-800 dark:text-purple-200 whitespace-pre-wrap">
            {data.thinking}
          </pre>
        </div>
      )}

      {/* Main Content */}
      <div className="relative">
        <div className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">响应内容</div>
        <div className="relative group">
          <pre className="text-xs bg-gray-50 dark:bg-gray-800 p-3 rounded-lg overflow-auto max-h-64 text-gray-800 dark:text-gray-200 whitespace-pre-wrap">
            {data.content || '(空)'}
          </pre>
          <button
            onClick={handleCopyContent}
            className="absolute top-2 right-2 p-1.5 rounded bg-gray-200 dark:bg-gray-700 opacity-0 group-hover:opacity-100 transition-opacity"
            title="复制内容"
          >
            {copied ? (
              <Check size={14} className="text-green-500" />
            ) : (
              <Copy size={14} className="text-gray-500 dark:text-gray-400" />
            )}
          </button>
        </div>
      </div>
    </div>
  );
};

interface HeadersViewerProps {
  headers: Record<string, string>;
}

const HeadersViewer: React.FC<HeadersViewerProps> = ({ headers }) => {
  // Mask sensitive headers
  const maskedHeaders = { ...headers };
  if (maskedHeaders['Authorization']) {
    const auth = maskedHeaders['Authorization'];
    if (auth.startsWith('Bearer ')) {
      maskedHeaders['Authorization'] = `Bearer ${auth.slice(7, 15)}...`;
    }
  }

  return (
    <div className="space-y-1">
      {Object.entries(maskedHeaders).map(([key, value]) => (
        <div key={key} className="flex text-xs">
          <span className="font-medium text-gray-600 dark:text-gray-400 w-40 shrink-0">
            {key}:
          </span>
          <span className="text-gray-800 dark:text-gray-200 break-all">
            {value}
          </span>
        </div>
      ))}
    </div>
  );
};

export const DebugModal: React.FC<DebugModalProps> = ({
  isOpen,
  onClose,
  debugInfo,
  messageRole,
}) => {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50"
        onClick={onClose}
      />

      {/* Modal */}
      <div className="relative w-full max-w-3xl max-h-[80vh] bg-white dark:bg-gray-900 rounded-xl shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-gray-700">
          <h2 className="text-lg font-semibold text-gray-800 dark:text-white">
            调试信息 - {messageRole === 'user' ? '请求' : messageRole === 'error' ? '错误' : '响应'}
          </h2>
          <button
            onClick={onClose}
            className="p-1 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-500"
          >
            <X size={20} />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 overflow-auto max-h-[calc(80vh-80px)] space-y-4">
          {!debugInfo ? (
            <div className="text-center py-8 text-gray-500 dark:text-gray-400">
              <p>暂无调试信息</p>
              <p className="text-sm mt-2">请确保已开启调试模式并重新发送消息</p>
            </div>
          ) : (
            <>
              {/* Request Section */}
              {debugInfo.request && (
                <CollapsibleSection title="HTTP 请求">
                  <div className="space-y-4">
                    <div className="flex items-center gap-2 text-sm">
                      <span className="px-2 py-1 bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300 rounded font-medium">
                        {debugInfo.request.method}
                      </span>
                      <span className="text-gray-800 dark:text-gray-200 break-all">
                        {debugInfo.request.url}
                      </span>
                    </div>

                    <CollapsibleSection title="请求头" defaultExpanded={false}>
                      <HeadersViewer headers={debugInfo.request.headers} />
                    </CollapsibleSection>

                    <CollapsibleSection title="请求体">
                      <JsonViewer data={debugInfo.request.body} />
                    </CollapsibleSection>
                  </div>
                </CollapsibleSection>
              )}

              {/* Response Section */}
              {debugInfo.response && (
                <CollapsibleSection title="HTTP 响应">
                  <div className="space-y-4">
                    <div className="flex items-center gap-2 text-sm">
                      <span
                        className={`px-2 py-1 rounded font-medium ${
                          debugInfo.response.status >= 200 &&
                          debugInfo.response.status < 300
                            ? 'bg-green-100 dark:bg-green-900 text-green-700 dark:text-green-300'
                            : 'bg-red-100 dark:bg-red-900 text-red-700 dark:text-red-300'
                        }`}
                      >
                        {debugInfo.response.status}
                      </span>
                    </div>

                    {Object.keys(debugInfo.response.headers).length > 0 && (
                      <CollapsibleSection title="响应头" defaultExpanded={false}>
                        <HeadersViewer headers={debugInfo.response.headers} />
                      </CollapsibleSection>
                    )}

                    <CollapsibleSection title="响应体">
                      {isSseResponseBody(debugInfo.response.body) ? (
                        <SseResponseViewer data={debugInfo.response.body} />
                      ) : (
                        <JsonViewer data={debugInfo.response.body} />
                      )}
                    </CollapsibleSection>
                  </div>
                </CollapsibleSection>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default DebugModal;
