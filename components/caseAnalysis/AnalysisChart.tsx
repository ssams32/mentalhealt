
import React, { useRef, useEffect } from 'react';

declare var Chart: any;

interface AnalysisChartProps {
    title: string;
    type: 'bar' | 'line' | 'pie' | 'doughnut';
    data: any;
    options?: any;
    height?: number; // Optional height override
}

const AnalysisChart: React.FC<AnalysisChartProps> = React.memo(({ title, type, data, options = {} as any, height }) => {
    const chartRef = useRef<HTMLCanvasElement>(null);
    const chartInstance = useRef<any>(null);

    useEffect(() => {
        if (!chartRef.current) return;

        // Apply Bento-style defaults
        const defaultOptions = {
            responsive: true,
            maintainAspectRatio: false,
            animation: {
                duration: 400
            },
            plugins: {
                legend: {
                    position: 'bottom' as const,
                    labels: {
                        usePointStyle: true,
                        padding: 20,
                        font: { family: "'Pretendard', 'Inter', sans-serif", size: 11, weight: 600 },
                        color: '#64748b'
                    }
                },
                tooltip: {
                    backgroundColor: 'rgba(255, 255, 255, 0.95)',
                    titleColor: '#1e293b',
                    bodyColor: '#475569',
                    borderColor: '#e2e8f0',
                    borderWidth: 1,
                    padding: 12,
                    cornerRadius: 12,
                    displayColors: true,
                    titleFont: { weight: 'bold' as const, size: 13 },
                    bodyFont: { size: 12 }
                }
            },
            scales: type !== 'pie' && type !== 'doughnut' ? {
                x: {
                    grid: { display: false },
                    ticks: { color: '#94a3b8', font: { size: 10, weight: 600 } },
                    border: { display: false }
                },
                y: {
                    grid: { color: '#f1f5f9', borderDash: [4, 4] },
                    ticks: { color: '#94a3b8', font: { size: 10 } },
                    border: { display: false }
                }
            } : {}
        };

        const mergedOptions = {
            ...defaultOptions,
            ...options,
            plugins: { ...defaultOptions.plugins, ...options.plugins },
            scales: { ...defaultOptions.scales, ...options.scales }
        };

        if (chartInstance.current && chartInstance.current.config.type === type) {
            chartInstance.current.data = data;
            chartInstance.current.options = mergedOptions;
            chartInstance.current.update('none');
        } else {
            if (chartInstance.current) {
                chartInstance.current.destroy();
            }

            if ((window as any).ChartDataLabels && Chart.register) {
                Chart.register((window as any).ChartDataLabels);
            }

            try {
                chartInstance.current = new Chart(chartRef.current, { type, data, options: mergedOptions });
            } catch (e) {
                console.error('Chart creation error:', e);
            }
        }
    }, [type, data, options]);

    useEffect(() => {
        return () => {
            if (chartInstance.current) {
                chartInstance.current.destroy();
                chartInstance.current = null;
            }
        };
    }, []);

    return (
        <div className="bg-white p-8 rounded-[2.5rem] shadow-sm border-2 border-slate-50 flex flex-col h-full group hover:shadow-xl transition-all duration-500 hover:-translate-y-1">
            <div className="flex justify-between items-center mb-6">
                <div className="flex items-center gap-3">
                    <span className="w-1.5 h-6 bg-indigo-500 rounded-full group-hover:scale-y-125 transition-transform"></span>
                    <h3 className="text-lg font-black text-slate-800 tracking-tight">{title}</h3>
                </div>
                <div className="flex gap-1.5">
                    <div className="w-2 h-2 rounded-full bg-slate-100 group-hover:bg-indigo-100 transition-colors"></div>
                    <div className="w-2 h-2 rounded-full bg-slate-100 group-hover:bg-indigo-200 transition-colors"></div>
                </div>
            </div>
            <div className="flex-1 relative min-h-0" style={height ? { height: `${height}px` } : {}}>
                <canvas ref={chartRef} />
            </div>
        </div>
    );
});

export default AnalysisChart;
