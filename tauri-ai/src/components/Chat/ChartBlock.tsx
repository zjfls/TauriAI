import React, { useMemo } from 'react';
import ReactECharts from 'echarts-for-react';
import { useConfigStore } from '../../stores/configStore';

interface ChartBlockProps {
    code: string;
}

export const ChartBlock: React.FC<ChartBlockProps> = ({ code }) => {
    const { config } = useConfigStore();
    const theme = config?.general?.theme === 'dark' ? 'dark' : undefined;

    const { options, error } = useMemo(() => {
        try {
            // Allow loose JSON (like in JS objects) by simple cleanup or standard JSON.parse
            // For robustness, we assume standard JSON, but maybe strip comments if needed later.
            // ECharts options usually come as JSON from LLMs.
            const parsed = JSON.parse(code);
            return { options: parsed, error: null };
        } catch (e) {
            return { options: null, error: (e as Error).message };
        }
    }, [code]);

    if (error) {
        return (
            <div className="my-2 rounded-lg bg-red-900/20 p-4 text-red-400">
                <p className="text-sm font-medium">图表配置解析失败</p>
                <p className="mt-1 text-xs opacity-70">{error}</p>
                <pre className="mt-2 overflow-x-auto whitespace-pre-wrap text-xs opacity-70 bg-red-900/10 p-2 rounded">
                    {code}
                </pre>
            </div>
        );
    }

    if (!options) {
        return null;
    }

    return (
        <div className="my-4 rounded-lg border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-800">
            <ReactECharts
                option={options}
                theme={theme}
                style={{ height: '400px', width: '100%' }}
                opts={{ renderer: 'svg' }}
            />
        </div>
    );
};
