
import { useConfigStore } from '../stores/configStore';

// 记录当前处于激活状态的弹窗数量
let activeDialogCount = 0;
const MAX_ACTIVE_DIALOGS = 3;

// 节流控制：记录上一次触发弹窗的时间戳
let lastErrorTime = 0;
// 节流间隔：在这个时间范围内的连续报错将被丢弃，避免系统级卡死 (毫秒)
const ERROR_THROTTLE_MS = 2000;

/**
 * 全局通用报错弹窗工具
 * 带有防风暴(Throttle)节流机制，并且限制最大弹出数量，防止连续的抛错卡死操作系统原生弹窗。
 * 
 * @param title 弹窗标题
 * @param errorMessage 错误详细信息
 * @param err 原生 Error 对象（可选，用于提取 StackTrace）
 */
export async function showGlobalError(title: string, errorMessage: string, err?: unknown) {
    if (activeDialogCount >= MAX_ACTIVE_DIALOGS) {
        console.warn(`[GlobalError active limit reached] ${title}: ${errorMessage}`);
        return;
    }

    const now = Date.now();
    if (now - lastErrorTime < ERROR_THROTTLE_MS) {
        console.warn(`[GlobalError throttled] ${title}: ${errorMessage}`);
        return;
    }

    lastErrorTime = now;
    activeDialogCount++;

    const errorId = `err_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    const stack = err instanceof Error ? err.stack : undefined;

    window.dispatchEvent(
        new CustomEvent('tauriai:global-error', {
            detail: {
                id: errorId,
                title,
                message: errorMessage,
                stack,
            },
        })
    );
}

// 监听由于用户关闭弹窗引起的计数器下降
if (typeof window !== 'undefined') {
    window.addEventListener('tauriai:global-error-closed', () => {
        activeDialogCount = Math.max(0, activeDialogCount - 1);
    });
}

/**
 * 包装后的 Tauri API 调用工具
 * 用以替换直接的 @tauri-apps/api/core里的 invoke。
 * 
 * 在开启了【严格报错模式 (strictErrorMode)】时，
 * 此函数拦截捕捉到的业务报错，除了将其正常的 Promise.reject 给上层业务外，
 * 会强行调用原生弹窗将其曝光。
 * 
 * @param command 后端命令名
 * @param args 参数
 */
import { invoke as coreInvoke, InvokeArgs } from '@tauri-apps/api/core';

export async function tauriInvoke<T>(command: string, args?: InvokeArgs): Promise<T> {
    try {
        return await coreInvoke<T>(command, args);
    } catch (err: unknown) {
        // 检查全局设定：是否开启了“严格报错模式覆盖”
        const state = useConfigStore.getState();
        const isStrictMode = state.config?.strictErrorMode === true;

        if (isStrictMode) {
            const errorText = typeof err === 'string' ? err : err instanceof Error ? err.message : JSON.stringify(err);
            // 在严格模式下，即使业务外围包裹了 try...catch，错误也会强制曝光
            void showGlobalError(`业务局部报错被捕获 (严格模式): ${command}`, errorText, err);
        }

        // 原样跑出供业务层的 catch 做出例如 UI 降级或红字提示的局部渲染处理
        throw err;
    }
}
