import { invoke, isTauri } from '@tauri-apps/api/core';
import type { ActiveView } from '../types';
import { getViewWindowParams } from './viewWindow';
import { getCurrentWindowLabelSafe } from './windowPresence';

export type WindowRole =
  | 'main_host'
  | 'workspace_host'
  | 'chat_view'
  | 'workstudio_view'
  | 'json_analyzer'
  | 'utility'
  | 'ghost';

export type WindowRouteDomain = 'chat' | 'workstudio' | 'utility';
export type WindowVisibilityState = 'visible' | 'hidden';

type BuildWindowRouteContextArgs = {
  label?: string;
  activeView?: ActiveView | null;
  runtimeReady?: boolean;
};

const logWindowRouteContext = (_stage: string, _detail?: Record<string, unknown>) => {};

const trimOrNull = (value?: string | null): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
};

export const resolveWindowRole = (label: string, view: ActiveView | null | undefined): WindowRole => {
  const normalizedLabel = String(label || '').trim();
  if (!normalizedLabel) return 'utility';
  if (normalizedLabel.startsWith('__tauriai_ghost__') || view === 'drag-ghost') return 'ghost';
  if (normalizedLabel === 'main') return 'main_host';
  if (normalizedLabel.startsWith('workspace-')) return 'workspace_host';
  if (view === 'workstudio' || normalizedLabel.startsWith('view-workstudio-') || normalizedLabel.startsWith('view-workstudio-dir-')) {
    return 'workstudio_view';
  }
  if (view === 'json_analyzer' || normalizedLabel.startsWith('view-json_analyzer')) return 'json_analyzer';
  if (normalizedLabel.startsWith('view-chat-') || view === 'chat' || view === 'history' || view === 'settings' || view === 'practice') {
    return 'chat_view';
  }
  return 'utility';
};

export const resolveWindowRouteDomain = (role: WindowRole): WindowRouteDomain => {
  if (role === 'workstudio_view') return 'workstudio';
  if (role === 'utility' || role === 'json_analyzer' || role === 'ghost') return 'utility';
  return 'chat';
};

export const resolveWindowHostLabel = (label: string, role: WindowRole, explicitHost?: string | null): string | null => {
  const normalizedLabel = String(label || '').trim();
  const normalizedHost = trimOrNull(explicitHost);
  if (!normalizedLabel) return normalizedHost;
  if (role === 'main_host' || role === 'workspace_host') return normalizedLabel;
  if (normalizedHost) return normalizedHost;
  if (role === 'chat_view') return 'main';
  return null;
};

export const resolveWindowCapabilities = (role: WindowRole): string[] => {
  switch (role) {
    case 'main_host':
    case 'workspace_host':
      return [
        'surface.settings',
        'surface.history',
        'surface.practice',
        'session.create',
        'session.create_external',
        'debug.devtools',
      ];
    case 'chat_view':
    case 'workstudio_view':
    case 'json_analyzer':
    case 'utility':
      return ['debug.devtools'];
    default:
      return [];
  }
};

export const buildCurrentWindowRouteContext = (
  args: BuildWindowRouteContextArgs = {}
): {
  label: string;
  role: WindowRole;
  hostWindowLabel: string | null;
  routeDomain: WindowRouteDomain;
  capabilities: string[];
  runtimeReady: boolean;
  visibilityState: WindowVisibilityState;
  osFocused: boolean;
  activeView: ActiveView | null;
} | null => {
  const label = trimOrNull(args.label ?? getCurrentWindowLabelSafe());
  if (!label) return null;

  const params = getViewWindowParams();
  const activeView = (args.activeView ?? params.view ?? null) as ActiveView | null;
  const role = resolveWindowRole(label, params.view ?? activeView);
  const hostWindowLabel = resolveWindowHostLabel(label, role, params.hostWindowLabel);
  const routeDomain = resolveWindowRouteDomain(role);
  const visibilityState: WindowVisibilityState =
    typeof document !== 'undefined' && document.visibilityState === 'visible' ? 'visible' : 'hidden';
  const osFocused = typeof document !== 'undefined' ? document.hasFocus() : false;

  return {
    label,
    role,
    hostWindowLabel,
    routeDomain,
    capabilities: resolveWindowCapabilities(role),
    runtimeReady: Boolean(args.runtimeReady),
    visibilityState,
    osFocused,
    activeView,
  };
};

export const syncCurrentWindowRouteContext = async (args: BuildWindowRouteContextArgs = {}): Promise<void> => {
  if (!isTauri()) return;
  const payload = buildCurrentWindowRouteContext(args);
  if (!payload) return;
  logWindowRouteContext('sync_window_context:request', payload as unknown as Record<string, unknown>);
  await invoke('sync_window_context', payload)
    .then(() => {
      logWindowRouteContext('sync_window_context:ok', {
        label: payload.label,
        role: payload.role,
        hostWindowLabel: payload.hostWindowLabel,
        routeDomain: payload.routeDomain,
        activeView: payload.activeView,
        runtimeReady: payload.runtimeReady,
        osFocused: payload.osFocused,
        visibilityState: payload.visibilityState,
      });
    })
    .catch((error) => {
      logWindowRouteContext('sync_window_context:error', {
        label: payload.label,
        error: error instanceof Error ? error.message : String(error),
      });
    });
};

export const clearCurrentWindowRouteContext = async (label = getCurrentWindowLabelSafe()): Promise<void> => {
  if (!isTauri()) return;
  logWindowRouteContext('clear_window_context:request', { label });
  await invoke('clear_window_context', { label })
    .then(() => {
      logWindowRouteContext('clear_window_context:ok', { label });
    })
    .catch((error) => {
      logWindowRouteContext('clear_window_context:error', {
        label,
        error: error instanceof Error ? error.message : String(error),
      });
    });
};
