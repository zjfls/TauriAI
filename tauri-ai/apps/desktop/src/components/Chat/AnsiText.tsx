import React, { useMemo } from 'react';
import type { AnsiColorMode, AnsiRenderMode } from '../../types';
import { useUIStore, getEffectiveTheme } from '../../stores/uiStore';
import { parseAnsi, resolveAnsiPalette, resolveAnsiStyle, normalizeAnsiColorMode, normalizeAnsiRenderMode } from '../../utils/ansi';
import { stripAnsi } from '../../utils/stripAnsi';

interface AnsiTextProps {
  text: string;
  renderMode?: AnsiRenderMode;
  colorMode?: AnsiColorMode;
}

export const AnsiText: React.FC<AnsiTextProps> = ({ text, renderMode, colorMode }) => {
  const theme = useUIStore((state) => state.theme);
  const effectiveTheme = getEffectiveTheme(theme);

  const normalizedRenderMode = normalizeAnsiRenderMode(renderMode);
  const normalizedColorMode = normalizeAnsiColorMode(colorMode);

  const palette = useMemo(
    () => resolveAnsiPalette(normalizedColorMode, effectiveTheme),
    [normalizedColorMode, effectiveTheme]
  );

  if (!text) {
    return null;
  }

  if (normalizedRenderMode === 'raw') {
    return <>{text}</>;
  }

  if (normalizedRenderMode === 'strip') {
    return <>{stripAnsi(text)}</>;
  }

  const segments = useMemo(() => parseAnsi(text), [text]);

  return (
    <>
      {segments.map((segment, idx) => {
        if (!segment.text) return null;
        const style = resolveAnsiStyle(segment.state, palette);
        return (
          <span key={idx} style={style}>
            {segment.text}
          </span>
        );
      })}
    </>
  );
};
