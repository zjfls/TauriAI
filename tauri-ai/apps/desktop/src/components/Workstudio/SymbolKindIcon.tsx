import React from 'react';

/**
 * SymbolKindIcon — 与 VSCode 保持一致的符号类型图标组件
 *
 * 使用内联 SVG 实现，参考 VSCode codicons 的配色方案：
 * - 橙黄色：容器类型（class、struct、interface、enum、trait、impl、module）
 * - 蓝紫色：可调用类型（function、method、constructor、operator）
 * - 天蓝色：值类型（variable、constant、field、property、enum_member）
 * - 绿色：类型别名（type、type_param）
 * - 灰色：其他（symbol、keyword、null 等）
 */

type SymbolKindConfig = {
    letter: string;
    color: string;       // 亮色模式颜色
    darkColor: string;   // 暗色模式颜色
    shape: 'square' | 'circle';
};

const def = (
    letter: string,
    color: string,
    darkColor: string,
    shape: 'square' | 'circle',
): SymbolKindConfig => ({ letter, color, darkColor, shape });

const KIND_CONFIG: Record<string, SymbolKindConfig> = {
    // 容器类型 — 橙黄
    class: def('C', '#D4760C', '#EE9D28', 'square'),
    struct: def('S', '#D4760C', '#EE9D28', 'square'),
    interface: def('I', '#8B5D0F', '#B89A60', 'circle'),
    enum: def('E', '#B8610A', '#CC8B3C', 'square'),
    trait: def('T', '#9B6B0F', '#C99C40', 'square'),
    impl: def('I', '#D4760C', '#EE9D28', 'square'),
    module: def('M', '#7B5EAE', '#B39DD1', 'square'),
    namespace: def('N', '#7B5EAE', '#B39DD1', 'square'),
    package: def('P', '#7B5EAE', '#B39DD1', 'square'),
    object: def('O', '#D4760C', '#EE9D28', 'square'),
    // 可调用类型 — 蓝紫
    function: def('ƒ', '#5B7FCC', '#75BEFF', 'square'),
    method: def('m', '#5B7FCC', '#75BEFF', 'circle'),
    constructor: def('⊕', '#5B7FCC', '#75BEFF', 'circle'),
    operator: def('±', '#5B7FCC', '#75BEFF', 'circle'),
    macro: def('#', '#6FA070', '#8FC48F', 'square'),
    // 值类型 — 天蓝
    variable: def('v', '#3B88B8', '#75BEFF', 'circle'),
    constant: def('c', '#3B88B8', '#75BEFF', 'square'),
    field: def('f', '#3B88B8', '#75BEFF', 'circle'),
    property: def('p', '#3B88B8', '#75BEFF', 'circle'),
    enum_member: def('e', '#B8610A', '#CC8B3C', 'circle'),
    parameter: def('a', '#3B88B8', '#75BEFF', 'circle'),
    type_param: def('T', '#4E9970', '#75C490', 'circle'),
    // 类型别名
    type: def('T', '#4E9970', '#75C490', 'square'),
    // 其他
    static: def('S', '#6E6E7A', '#9898A8', 'square'),
    keyword: def('k', '#6E6E7A', '#9898A8', 'square'),
    null: def('∅', '#6E6E7A', '#9898A8', 'circle'),
    // fallback
    symbol: def('◈', '#6E6E7A', '#9898A8', 'circle'),
};

const FALLBACK_CONFIG: SymbolKindConfig = {
    letter: '◈',
    color: '#6E6E7A',
    darkColor: '#9898A8',
    shape: 'circle',
};

const normalizeKind = (kind: string): string =>
    String(kind ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_') || 'symbol';

type SymbolKindIconProps = {
    kind: string;
    size?: number;
    className?: string;
    /** 是否强制暗色模式（不传则自动检测） */
    dark?: boolean;
};

export const SymbolKindIcon: React.FC<SymbolKindIconProps> = ({
    kind,
    size = 14,
    className = '',
    dark,
}) => {
    const normalized = normalizeKind(kind);
    const config = KIND_CONFIG[normalized] ?? FALLBACK_CONFIG;

    const isDark =
        dark !== undefined
            ? dark
            : typeof document !== 'undefined' &&
            document.documentElement?.classList?.contains('dark');

    const color = isDark ? config.darkColor : config.color;
    const r = size / 2;

    return (
        <svg
            width={size}
            height={size}
            viewBox={`0 0 ${size} ${size}`}
            className={`inline-block shrink-0 ${className}`}
            aria-label={normalized}
            role="img"
        >
            {config.shape === 'square' ? (
                <rect
                    x={1}
                    y={1}
                    width={size - 2}
                    height={size - 2}
                    rx={2}
                    ry={2}
                    fill={color}
                    fillOpacity={isDark ? 0.18 : 0.12}
                    stroke={color}
                    strokeWidth={1.2}
                />
            ) : (
                <circle
                    cx={r}
                    cy={r}
                    r={r - 1}
                    fill={color}
                    fillOpacity={isDark ? 0.18 : 0.12}
                    stroke={color}
                    strokeWidth={1.2}
                />
            )}
            <text
                x={r}
                y={r + 0.5}
                textAnchor="middle"
                dominantBaseline="middle"
                fontSize={size <= 12 ? size * 0.6 : size * 0.55}
                fontFamily="'SF Mono', 'Cascadia Code', 'Fira Code', monospace"
                fontWeight="600"
                fill={color}
            >
                {config.letter}
            </text>
        </svg>
    );
};

export default SymbolKindIcon;
