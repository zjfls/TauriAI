import { getCurrentWindowLabelSafe } from './windowPresence';

export const getWindowLabelForStorage = (): string => getCurrentWindowLabelSafe();

export const getWindowScopedStorageKey = (prefix: string): string => {
  const label = getWindowLabelForStorage();
  return `${prefix}:${label}`;
};

export const isMainWindowLabel = (label: string): boolean => {
  return label === 'main';
};
