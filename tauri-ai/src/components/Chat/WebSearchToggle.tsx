/**
 * WebSearchToggle Component
 * 
 * A dropdown menu component that allows users to select which web search provider
to use for the current query. Supports multiple providers (Tavily, Google, Brave)
plus native model search.
 * 
 * Features:
 * - Shows dropdown with available providers when clicked
 * - Displays selected provider with icon
 * - Hidden when no providers are available
 * - Supports disabling during generation
 * 
 * @module WebSearchToggle
 */

import React, { useState, useRef, useEffect } from 'react';

/**
 * Available web search provider types
 */
export type WebSearchProvider = 'tavily' | 'google' | 'brave' | 'native';

/**
 * Props for the WebSearchToggle component
 * 
 * @interface WebSearchToggleProps
 * @property {WebSearchProvider[]} [providers] - List of available providers (hidden if empty)
 * @property {WebSearchProvider | null} [selected] - Currently selected provider
 * @property {Function} [onSelect] - Callback when a provider is selected
 * @property {boolean} [disabled] - Whether the toggle is disabled
 * @property {'native' | 'tool'} [mode] - Current mode for display purposes
 * @property {string} [details] - Additional details to display
 */
interface WebSearchToggleProps {
  providers?: WebSearchProvider[];
  selected?: WebSearchProvider | null;
  onSelect?: (provider: WebSearchProvider | null) => void;
  disabled?: boolean;
  details?: string;
}

/**
 * Provider configuration with display names and icons
 */
const PROVIDER_CONFIG: Record<WebSearchProvider, { name: string; icon: React.ReactNode; color: string }> = {
  native: {
    name: '模型内置',
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10"/>
        <line x1="2" y1="12" x2="22" y2="12"/>
        <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
      </svg>
    ),
    color: '#22c55e', // green-500
  },
  tavily: {
    name: 'Tavily',
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="11" cy="11" r="8"/>
        <path d="m21 21-4.35-4.35"/>
      </svg>
    ),
    color: '#f97316', // orange-500
  },
  google: {
    name: 'Google',
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10"/>
        <path d="M12 2v20"/>
        <path d="M2 12h20"/>
      </svg>
    ),
    color: '#ef4444', // red-500
  },
  brave: {
    name: 'Brave',
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="m12 2 7.5 5.5L19 20l-7 2-7-2L4.5 7.5 12 2z"/>
        <path d="M12 2v20"/>
      </svg>
    ),
    color: '#fb923c', // orange-400
  },
};

/**
 * WebSearchToggle Component
 * 
 * Renders a dropdown button for selecting web search provider.
 * 
 * @param {WebSearchToggleProps} props - Component props
 * @returns {JSX.Element | null} The rendered component or null if no providers
 * 
 * @example
 * ```tsx
 * <WebSearchToggle
 *   providers={['tavily', 'google']}
 *   selected="tavily"
 *   onSelect={(p) => console.log('Selected:', p)}
 * />
 * ```
 */
export const WebSearchToggle: React.FC<WebSearchToggleProps> = ({
  providers = [],
  selected,
  onSelect,
  disabled = false,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Hide if no providers available
  if (!providers || providers.length === 0) {
    return null;
  }

  const currentProvider = selected ? PROVIDER_CONFIG[selected] : null;
  const isActive = selected !== null && selected !== undefined;

  const handleSelect = (provider: WebSearchProvider | null) => {
    onSelect?.(provider);
    setIsOpen(false);
  };

  return (
    <div ref={menuRef} style={{ position: 'relative' }}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        disabled={disabled}
        title={isActive ? `使用 ${currentProvider?.name} 搜索` : '选择搜索方式'}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          padding: '6px 10px',
          borderRadius: '6px',
          border: 'none',
          backgroundColor: isActive ? `${currentProvider?.color}20` : 'transparent',
          color: isActive ? currentProvider?.color : '#9ca3af',
          cursor: disabled ? 'not-allowed' : 'pointer',
          opacity: disabled ? 0.5 : 1,
          fontSize: '13px',
          fontWeight: 500,
          transition: 'all 0.2s ease',
        }}
        onMouseEnter={(e) => {
          if (!disabled && !isActive) {
            e.currentTarget.style.backgroundColor = 'rgba(156, 163, 175, 0.15)';
            e.currentTarget.style.color = '#d1d5db';
          }
        }}
        onMouseLeave={(e) => {
          if (!disabled && !isActive) {
            e.currentTarget.style.backgroundColor = 'transparent';
            e.currentTarget.style.color = '#9ca3af';
          }
        }}
      >
        {/* Icon */}
        <span style={{ 
          display: 'flex', 
          alignItems: 'center',
          color: isActive ? currentProvider?.color : 'inherit',
        }}>
          {currentProvider?.icon ?? (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8"/>
              <path d="m21 21-4.35-4.35"/>
            </svg>
          )}
        </span>

        {/* Label */}
        <span>
          {currentProvider?.name ?? '搜索'}
        </span>

        {/* Dropdown arrow */}
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{
            transform: isOpen ? 'rotate(180deg)' : 'rotate(0deg)',
            transition: 'transform 0.2s ease',
            marginLeft: '2px',
          }}
        >
          <path d="m6 9 6 6 6-6"/>
        </svg>
      </button>

      {/* Dropdown menu */}
      {isOpen && (
        <div
          style={{
            position: 'absolute',
            bottom: 'calc(100% + 6px)',
            left: 0,
            minWidth: '140px',
            backgroundColor: '#1f2937',
            border: '1px solid #374151',
            borderRadius: '8px',
            padding: '4px',
            boxShadow: '0 10px 15px -3px rgba(0, 0, 0, 0.3)',
            zIndex: 1000,
          }}
        >
          {/* None option - turn off search */}
          <button
            onClick={() => handleSelect(null)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              width: '100%',
              padding: '8px 12px',
              borderRadius: '6px',
              border: 'none',
              backgroundColor: selected === null || selected === undefined ? 'rgba(156, 163, 175, 0.2)' : 'transparent',
              color: selected === null || selected === undefined ? '#f3f4f6' : '#9ca3af',
              cursor: 'pointer',
              fontSize: '13px',
              textAlign: 'left',
              transition: 'all 0.15s ease',
            }}
            onMouseEnter={(e) => {
              if (selected !== null && selected !== undefined) {
                e.currentTarget.style.backgroundColor = 'rgba(156, 163, 175, 0.15)';
                e.currentTarget.style.color = '#d1d5db';
              }
            }}
            onMouseLeave={(e) => {
              if (selected !== null && selected !== undefined) {
                e.currentTarget.style.backgroundColor = 'transparent';
                e.currentTarget.style.color = '#9ca3af';
              }
            }}
          >
            <span style={{ display: 'flex', alignItems: 'center' }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 6 6 18"/>
                <path d="m6 6 12 12"/>
              </svg>
            </span>
            <span>不搜索</span>
          </button>

          {/* Divider */}
          <div style={{ height: '1px', backgroundColor: '#374151', margin: '4px 0' }} />

          {/* Provider options */}
          {providers.map((provider) => {
            const config = PROVIDER_CONFIG[provider];
            const isSelected = selected === provider;
            
            return (
              <button
                key={provider}
                onClick={() => handleSelect(provider)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  width: '100%',
                  padding: '8px 12px',
                  borderRadius: '6px',
                  border: 'none',
                  backgroundColor: isSelected ? `${config.color}20` : 'transparent',
                  color: isSelected ? config.color : '#9ca3af',
                  cursor: 'pointer',
                  fontSize: '13px',
                  textAlign: 'left',
                  transition: 'all 0.15s ease',
                }}
                onMouseEnter={(e) => {
                  if (!isSelected) {
                    e.currentTarget.style.backgroundColor = 'rgba(156, 163, 175, 0.15)';
                    e.currentTarget.style.color = '#d1d5db';
                  }
                }}
                onMouseLeave={(e) => {
                  if (!isSelected) {
                    e.currentTarget.style.backgroundColor = 'transparent';
                    e.currentTarget.style.color = '#9ca3af';
                  }
                }}
              >
                <span style={{ display: 'flex', alignItems: 'center' }}>
                  {config.icon}
                </span>
                <span>{config.name}</span>
                {isSelected && (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginLeft: 'auto' }}>
                    <polyline points="20 6 9 17 4 12"/>
                  </svg>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};
