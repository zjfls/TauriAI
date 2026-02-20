import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';

import { showGlobalError } from '../../desktop/src/utils/errorUtils';
import { useConfigStore } from '../../desktop/src/stores/configStore';

// 拦截 console.error，防止“写了 catch 但里面只有一行 console.error(e)”的鸵鸟行为
const originalConsoleError = console.error;
console.error = (...args) => {
  originalConsoleError(...args);

  // 严格隔离：如果有专门配置需要拦截 console.error
  const state = useConfigStore.getState();
  if (state.config?.interceptConsoleError !== false) { // 默认 true
    const errorText = args.map(arg =>
      typeof arg === 'string' ? arg : arg instanceof Error ? arg.message : JSON.stringify(arg)
    ).join(' ');

    // 不要 await，避免阻塞控制台输出本身
    void showGlobalError('捕获到隐藏日志错误 (控制台隔离)', errorText);
  }
};

// Add global error handler for uncaught errors
window.addEventListener('error', (event) => {
  console.error('Global error:', event.error);
  const errMsg = event.error?.message || event.message || '未知 JS 异常';
  void showGlobalError('应用发生未知错误', errMsg);
});

window.addEventListener('unhandledrejection', (event) => {
  const reason: any = (event as any)?.reason;

  const isCancellation = (() => {
    if (!reason) return false;
    const name = typeof reason?.name === 'string' ? reason.name : '';
    if (name === 'Canceled' || name === 'Cancelled' || name === 'AbortError') return true;
    const msg = typeof reason?.message === 'string' ? reason.message : String(reason);
    if (/Canceled:\s*Canceled/i.test(msg)) return true;
    if (/Cancelled:\s*Cancelled/i.test(msg)) return true;
    if (/aborted/i.test(msg)) return true;
    const stack = typeof reason?.stack === 'string' ? reason.stack : '';
    if (stack && /editor\.api/i.test(stack) && /(Canceled|Cancelled)/i.test(msg)) return true;
    return false;
  })();

  if (isCancellation) {
    event.preventDefault();
    return;
  }

  console.error('Unhandled promise rejection:', reason);

  const reasonText = typeof reason === 'string' ? reason : reason instanceof Error ? reason.message : JSON.stringify(reason);
  void showGlobalError('未处理的异步/后端异常', reasonText);
});

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

