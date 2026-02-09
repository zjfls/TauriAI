/**
 * ErrorBoundary Component
 * Catches React rendering errors and displays a fallback UI
 */

import { Component, ErrorInfo, ReactNode } from 'react';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null, errorInfo: null };
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('ErrorBoundary caught an error:', error, errorInfo);
    this.setState({ errorInfo });
  }

  render() {
    if (this.state.hasError) {
      const debugStormInfo = (() => {
        try {
          if (!import.meta.env.DEV) return null;
          if (typeof localStorage === 'undefined') return null;
          return {
            sessionStore: localStorage.getItem('tauri-ai:debug:last_session_store_storm'),
            configStore: localStorage.getItem('tauri-ai:debug:last_config_store_storm'),
            toolSessionStore: localStorage.getItem('tauri-ai:debug:last_tool_session_store_storm'),
            uiStore: localStorage.getItem('tauri-ai:debug:last_ui_store_storm'),
            conversationStore: localStorage.getItem('tauri-ai:debug:last_conversation_store_storm'),
          };
        } catch {
          return null;
        }
      })();

      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <div className="flex h-screen w-screen items-center justify-center bg-gray-100 dark:bg-gray-900 p-8">
          <div className="max-w-2xl w-full bg-white dark:bg-gray-800 rounded-lg shadow-lg p-6">
            <h1 className="text-xl font-bold text-red-600 dark:text-red-400 mb-4">
              应用出错了
            </h1>
            <p className="text-gray-600 dark:text-gray-300 mb-4">
              抱歉，应用遇到了一个错误。请尝试刷新页面或重启应用。
            </p>
            <details className="mb-4">
              <summary className="cursor-pointer text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200">
                查看错误详情
              </summary>
              <pre className="mt-2 p-4 bg-gray-100 dark:bg-gray-900 rounded text-xs overflow-auto max-h-64 text-red-600 dark:text-red-400">
                {this.state.error?.toString()}
                {'\n\n'}
                {this.state.errorInfo?.componentStack}
                {debugStormInfo?.sessionStore ? (
                  <>
                    {'\n\n'}
                    {'[debug] last sessionStore storm (localStorage tauri-ai:debug:last_session_store_storm)\n'}
                    {debugStormInfo.sessionStore}
                  </>
                ) : null}
                {debugStormInfo?.configStore ? (
                  <>
                    {'\n\n'}
                    {'[debug] last configStore storm (localStorage tauri-ai:debug:last_config_store_storm)\n'}
                    {debugStormInfo.configStore}
                  </>
                ) : null}
                {debugStormInfo?.toolSessionStore ? (
                  <>
                    {'\n\n'}
                    {'[debug] last toolSessionStore storm (localStorage tauri-ai:debug:last_tool_session_store_storm)\n'}
                    {debugStormInfo.toolSessionStore}
                  </>
                ) : null}
                {debugStormInfo?.uiStore ? (
                  <>
                    {'\n\n'}
                    {'[debug] last uiStore storm (localStorage tauri-ai:debug:last_ui_store_storm)\n'}
                    {debugStormInfo.uiStore}
                  </>
                ) : null}
                {debugStormInfo?.conversationStore ? (
                  <>
                    {'\n\n'}
                    {'[debug] last conversationStore storm (localStorage tauri-ai:debug:last_conversation_store_storm)\n'}
                    {debugStormInfo.conversationStore}
                  </>
                ) : null}
              </pre>
            </details>
            <button
              onClick={() => window.location.reload()}
              className="px-4 py-2 bg-blue-500 hover:bg-blue-600 text-white rounded-lg transition-colors"
            >
              刷新页面
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
