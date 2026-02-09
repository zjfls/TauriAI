import React, { useMemo } from 'react';
import { Mafs, Coordinates, Plot } from 'mafs';
import 'mafs/core.css';

interface MathBlockProps {
    code: string;
}

// Parse math expression string to a function
const parseExpression = (expr: string): ((x: number) => number) => {
    // Replace common math functions with Math.* equivalents
    const sanitized = expr
        .replace(/\bsin\b/g, 'Math.sin')
        .replace(/\bcos\b/g, 'Math.cos')
        .replace(/\btan\b/g, 'Math.tan')
        .replace(/\basin\b/g, 'Math.asin')
        .replace(/\bacos\b/g, 'Math.acos')
        .replace(/\batan\b/g, 'Math.atan')
        .replace(/\bsinh\b/g, 'Math.sinh')
        .replace(/\bcosh\b/g, 'Math.cosh')
        .replace(/\btanh\b/g, 'Math.tanh')
        .replace(/\bsqrt\b/g, 'Math.sqrt')
        .replace(/\babs\b/g, 'Math.abs')
        .replace(/\bexp\b/g, 'Math.exp')
        .replace(/\blog\b/g, 'Math.log')
        .replace(/\bln\b/g, 'Math.log')
        .replace(/\blog10\b/g, 'Math.log10')
        .replace(/\blog2\b/g, 'Math.log2')
        .replace(/\bfloor\b/g, 'Math.floor')
        .replace(/\bceil\b/g, 'Math.ceil')
        .replace(/\bround\b/g, 'Math.round')
        .replace(/\bmin\b/g, 'Math.min')
        .replace(/\bmax\b/g, 'Math.max')
        .replace(/\bpow\b/g, 'Math.pow')
        .replace(/\bsign\b/g, 'Math.sign')
        .replace(/\bpi\b/gi, 'Math.PI')
        .replace(/\be\b/g, 'Math.E')
        .replace(/\^/g, '**'); // Support ^ for exponentiation

    try {
        // Create a safe function from the expression
        // eslint-disable-next-line no-new-func
        const fn = new Function('x', `return ${sanitized}`) as (x: number) => number;
        // Wrap with try-catch to handle runtime errors
        return (x: number) => {
            try {
                return fn(x);
            } catch {
                return NaN;
            }
        };
    } catch {
        return () => NaN;
    }
};

// Default colors for multiple functions
const COLORS = ['#2563eb', '#dc2626', '#16a34a', '#9333ea', '#ea580c'];

export const MathBlock: React.FC<MathBlockProps> = ({ code }) => {
    const config = useMemo(() => {
        // Strip comments from JSON (AI sometimes adds // comments)
        const cleanCode = code
            .replace(/\/\/.*$/gm, '') // Remove single-line comments
            .replace(/\/\*[\s\S]*?\*\//g, '') // Remove multi-line comments
            .trim();

        try {
            const parsed = JSON.parse(cleanCode);
            return {
                // Handle cases: array, single value, or undefined
                functions: Array.isArray(parsed.functions)
                    ? parsed.functions.filter(Boolean)  // Remove any undefined entries
                    : parsed.functions
                        ? [parsed.functions]
                        : ['x'],  // Default fallback
                xRange: parsed.xRange || parsed.domain || [-10, 10],
                yRange: parsed.yRange || parsed.range || [-5, 5],
            };
        } catch {
            // If not valid JSON, treat as plain text (one function per line)
            // Also strip any comments from plain text mode
            const lines = cleanCode
                .split('\n')
                .map(line => line.replace(/\/\/.*$/, '').trim())
                .filter(line => line && !line.startsWith('{') && !line.startsWith('}'));
            return {
                functions: lines.length > 0 ? lines : ['x'],
                xRange: [-10, 10] as [number, number],
                yRange: [-5, 5] as [number, number],
            };
        }
    }, [code]);

    interface ParsedFunction {
        fn: (x: number) => number;
        color: string;
        label: string;
    }

    const parsedFunctions = useMemo((): ParsedFunction[] => {
        return config.functions.map((fn: string | { fn?: string; color?: string }, index: number): ParsedFunction => {
            // Handle both string and object formats, with fallback for missing fn
            const expr = typeof fn === 'string' ? fn : (fn?.fn || 'x');
            const color = typeof fn === 'object' && fn?.color ? fn.color : COLORS[index % COLORS.length];
            return {
                fn: parseExpression(expr),
                color,
                label: expr,
            };
        });
    }, [config.functions]);

    // Calculate appropriate subdivisions based on range to prevent label overlap
    const xSpan = Math.abs(config.xRange[1] - config.xRange[0]);
    const ySpan = Math.abs(config.yRange[1] - config.yRange[0]);
    const xSubdivisions = Math.min(Math.max(Math.floor(xSpan / 2), 1), 10);
    const ySubdivisions = Math.min(Math.max(Math.floor(ySpan / 5), 1), 10);

    return (
        <div className="my-4 rounded-lg border border-gray-200 bg-white p-2 shadow-sm dark:border-gray-700 dark:bg-gray-800">
            <Mafs
                viewBox={{
                    x: config.xRange as [number, number],
                    y: config.yRange as [number, number],
                }}
                preserveAspectRatio={false}
                height={300}
            >
                <Coordinates.Cartesian
                    subdivisions={1}
                    xAxis={{ lines: xSubdivisions, labels: (n) => n % Math.ceil(xSpan / 5) === 0 ? n.toString() : '' }}
                    yAxis={{ lines: ySubdivisions, labels: (n) => n % Math.ceil(ySpan / 5) === 0 ? n.toString() : '' }}
                />
                {parsedFunctions.map((pf: ParsedFunction, index: number) => (
                    <Plot.OfX
                        key={index}
                        y={pf.fn}
                        color={pf.color}
                    />
                ))}
            </Mafs>
            <div className="mt-2 flex flex-wrap gap-2 text-xs text-gray-500 dark:text-gray-400">
                {parsedFunctions.map((pf: ParsedFunction, index: number) => (
                    <span key={index} className="flex items-center gap-1">
                        <span
                            className="inline-block h-2 w-4 rounded"
                            style={{ backgroundColor: pf.color }}
                        />
                        <code>{pf.label}</code>
                    </span>
                ))}
            </div>
        </div>
    );
};
