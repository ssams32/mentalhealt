import React, { useEffect, useRef, useMemo } from 'react';
import { Download, ChevronRight } from 'lucide-react';

// Chart.js is loaded via CDN in index.html
declare const Chart: any;
declare const ChartDataLabels: any;

interface ChartComponentProps {
    title: string;
    data: any[];
    dataKey: string;
    type: 'pie' | 'bar' | 'line';
    layout?: 'horizontal' | 'vertical';
}

const ReportChart: React.FC<ChartComponentProps> = ({ title, data, dataKey, type, layout }) => {
    const chartRef = useRef<HTMLCanvasElement>(null);
    const chartInstanceRef = useRef<any>(null);

    const totalN = data.length;

    const chartDatasetStyle = (chartType: string) => ({
        backgroundColor: (context: any) => {
            const ctx = context.chart.ctx;
            const gradient = ctx.createLinearGradient(0, 0, 0, 400);
            const colors = [
                ['#6366f1', '#4f46e5'], // Indigo
                ['#10b981', '#059669'], // Emerald
                ['#f59e0b', '#d97706'], // Amber
                ['#0ea5e9', '#0284c7'], // Sky Blue
                ['#f43f5e', '#e11d48'], // Rose
                ['#64748b', '#475569']  // Slate
            ];
            const selected = colors[context.dataIndex % colors.length];
            gradient.addColorStop(0, selected[0]);
            gradient.addColorStop(1, selected[1]);
            return gradient;
        },
        borderColor: 'white',
        borderWidth: 2,
        borderRadius: chartType === 'bar' ? 8 : 0,
        hoverBackgroundColor: '#1e293b'
    });

    const chartData = useMemo(() => {
        if (!data || data.length === 0) {
            return { labels: [], datasets: [] };
        }

        const counts: { [key: string]: number } = {};

        // Special handling for age binning (always preserve bin order)
        if (dataKey === 'age') {
            const AGE_BINS = ['10대 미만', '10대', '20대', '30대', '40대', '50대', '60대', '65세 이상', '미상'];
            AGE_BINS.forEach(bin => { counts[bin] = 0; });
            data.forEach(item => {
                const raw = item[dataKey];
                let label = '미상';
                if (raw !== undefined && raw !== null && String(raw).trim() !== '') {
                    const s = String(raw).trim();
                    if (s.includes('대')) {
                        label = s;
                    } else {
                        const n = Number(s.replace(/[^0-9.-]/g, ''));
                        if (!isNaN(n)) {
                            if (n < 10) label = '10대 미만';
                            else if (n >= 65) label = '65세 이상';
                            else label = `${Math.floor(n / 10) * 10}대`;
                        }
                    }
                }
                counts[label] = (counts[label] || 0) + 1;
            });
            const labels = AGE_BINS;
            const values = labels.map(l => counts[l]);
            return { labels, datasets: [{ label: '건수', data: values, ...chartDatasetStyle(type) }] };
        }

        // Default: group by value
        data.forEach(item => {
            const value = item[dataKey] || '미입력';
            counts[value] = (counts[value] || 0) + 1;
        });

        const sortedEntries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
        const labels = sortedEntries.map(e => e[0]);
        const values = sortedEntries.map(e => e[1]);

        return {
            labels: labels,
            datasets: [{
                label: '건수',
                data: values,
                ...chartDatasetStyle(type)
            }]
        };
    }, [data, dataKey, type]);

    useEffect(() => {
        if (!chartRef.current) return;
        if (chartInstanceRef.current) {
            chartInstanceRef.current.destroy();
        }

        const ctx = chartRef.current.getContext('2d');
        if (!ctx) return;

        chartInstanceRef.current = new Chart(ctx, {
            type: type === 'pie' ? 'doughnut' : 'bar',
            data: chartData,
            options: {
                responsive: true,
                maintainAspectRatio: false,
                indexAxis: layout === 'horizontal' ? 'y' : 'x',
                layout: {
                    padding: { top: 35, bottom: 25, left: 20, right: 40 }
                },
                plugins: {
                    legend: {
                        display: type === 'pie',
                        position: 'bottom',
                        labels: {
                            font: { size: 11, weight: 'bold', family: 'Pretendard' },
                            usePointStyle: true,
                            padding: 15,
                            generateLabels: (chart: any) => {
                                const data = chart.data;
                                if (data.labels.length && data.datasets.length) {
                                    return data.labels.map((label: string, i: number) => {
                                        const truncatedLabel = label.length > 8 ? `${label.slice(0, 8)}…` : label;
                                        return {
                                            text: truncatedLabel,
                                            fillStyle: data.datasets[0].backgroundColor(chart.legend.ctx ? { chart, dataIndex: i } : { chart, dataIndex: i }),
                                            strokeStyle: '#ffffff',
                                            lineWidth: 1,
                                            hidden: isNaN(data.datasets[0].data[i]) || chart.getDatasetMeta(0).data[i].hidden,
                                            index: i
                                        };
                                    });
                                }
                                return [];
                            }
                        }
                    },
                    tooltip: {
                        backgroundColor: 'rgba(15, 23, 42, 0.9)',
                        titleFont: { size: 13, weight: 'bold' },
                        bodyFont: { size: 12 },
                        padding: 12,
                        cornerRadius: 12,
                        displayColors: false,
                        callbacks: {
                            label: (context: any) => {
                                const value = context.raw;
                                const percentage = totalN > 0 ? ((value / totalN) * 100).toFixed(1) + '%' : '0%';
                                return ` ${context.label}: ${value}건 (${percentage})`;
                            }
                        }
                    },
                    datalabels: {
                        display: (context: any) => {
                            if (type !== 'pie') return true;
                            const dataset = context.dataset;
                            const total = dataset.data.reduce((acc: number, curr: number) => acc + curr, 0);
                            const val = dataset.data[context.dataIndex];
                            const pct = total > 0 ? val / total : 0;
                            return pct >= 0.05; // Hide labels under 5%
                        },
                        anchor: 'end',
                        align: 'end',
                        offset: 4,
                        color: '#475569',
                        font: { size: 11, weight: '900', family: 'Pretendard' },
                        formatter: (value: any, context: any) => {
                            if (type !== 'pie') return `${value}건`;
                            const label = context.chart.data.labels[context.dataIndex] || '미입력';
                            const dataset = context.dataset;
                            const total = dataset.data.reduce((acc: number, curr: number) => acc + curr, 0);
                            const pct = total > 0 ? Math.round((value / total) * 100) : 0;
                            const truncated = label.length > 6 ? `${label.slice(0, 6)}…` : label;
                            return `${truncated} ${pct}%`;
                        }
                    }
                },
                scales: type === 'pie' ? {} : {
                    x: {
                        grid: { display: false },
                        ticks: { font: { size: 10, weight: 'bold' }, color: '#94a3b8' }
                    },
                    y: {
                        grid: { color: '#f1f5f9' },
                        ticks: { font: { size: 10, weight: 'bold' }, color: '#94a3b8' },
                        beginAtZero: true
                    }
                },
                cutout: type === 'pie' ? '70%' : 0
            },
            plugins: [ChartDataLabels]
        });

        return () => {
            if (chartInstanceRef.current) {
                chartInstanceRef.current.destroy();
            }
        };
    }, [chartData, type, layout, totalN]);

    const handleDownload = () => {
        if (!chartRef.current) return;

        // 투명 배경 방지를 위한 하얀색 임시 캔버스 생성
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = chartRef.current.width;
        tempCanvas.height = chartRef.current.height;
        const ctx = tempCanvas.getContext('2d');
        if (ctx) {
            ctx.fillStyle = '#FFFFFF';
            ctx.fillRect(0, 0, tempCanvas.width, tempCanvas.height);
            ctx.drawImage(chartRef.current, 0, 0);
        }

        const link = document.createElement('a');
        link.download = `${title}.png`;
        link.href = tempCanvas.toDataURL('image/png', 1.0);
        link.click();
    };

    return (
        <div className="group bg-white p-8 rounded-[2.5rem] border-2 border-slate-50 shadow-sm hover:shadow-2xl hover:border-indigo-100 transition-all duration-500 flex flex-col h-[420px] relative overflow-hidden">
            <div className="absolute top-0 left-0 w-2 h-full bg-indigo-500 opacity-0 group-hover:opacity-100 transition-opacity duration-500" />

            <div className="flex justify-between items-start mb-8">
                <div>
                    <h3 className="text-xl font-black text-slate-800 tracking-tight flex items-center gap-2">
                        {title}
                        <ChevronRight size={16} className="text-indigo-300" />
                    </h3>
                    <p className="text-xs font-bold text-slate-400 mt-1">N={totalN}</p>
                </div>
                <button
                    onClick={handleDownload}
                    className="p-3 bg-slate-50 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-2xl transition-all shadow-inner"
                    title="전문 보고서용 이미지 다운로드"
                >
                    <Download size={20} />
                </button>
            </div>

            <div className="flex-1 min-h-0 relative animate-load">
                <canvas ref={chartRef} />
            </div>
        </div>
    );
};

export default React.memo(ReportChart, (prev, next) => {
    // Custom equality check to avoid deep comparison of large data arrays if not needed,
    // but here we want to re-render if data or other props change.
    // React.memo default is shallow compare, which is usually enough for props.
    return (
        prev.title === next.title &&
        prev.dataKey === next.dataKey &&
        prev.type === next.type &&
        prev.layout === next.layout &&
        prev.data === next.data // Shallow check on data array reference
    );
});
