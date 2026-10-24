import React, { useEffect, useRef } from 'react';
import { gridToScreen, calculateIsometricDepthIndex, getEffectiveDimensions } from '../../utils/assetIsometric';

/**
 * AssetIsoCanvas — Stage 2 이식본.
 * 원본: ~/workspace/office-asset-fullstack/src/components/IsoCanvas.tsx (Canvas 2D).
 * 변경점: 'use client' 지시어 제거, import 경로를 utils/assetIsometric.ts로 교체.
 * PixiJS를 도입하지 않는다. 클릭 선택은 근접 중심 판정이며, 목록형 대체 화면이
 * 항상 함께 제공되므로 클릭이 유일한 선택 수단이 아니다.
 */

export type IsoObject = {
    id: string;
    label: string;
    coordX: number;
    coordY: number;
    widthCells: number;
    depthCells: number;
    zLayer: number;
    rotationDeg: 0 | 90 | 180 | 270;
    color?: string;
};

const AssetIsoCanvas: React.FC<{
    gridWidth: number;
    gridDepth: number;
    objects: IsoObject[];
    selectedId?: string | null;
    onSelect?: (id: string) => void;
}> = ({ gridWidth, gridDepth, objects, selectedId, onSelect }) => {
    const ref = useRef<HTMLCanvasElement>(null);
    const offset = { x: gridDepth * 32 + 20, y: 40 };
    const width = (gridWidth + gridDepth) * 32 + 40;
    const height = (gridWidth + gridDepth) * 16 + 160;

    useEffect(() => {
        const canvas = ref.current;
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        ctx.clearRect(0, 0, width, height);
        ctx.strokeStyle = '#e5e7eb';
        ctx.lineWidth = 1;
        for (let x = 0; x < gridWidth; x++) {
            for (let y = 0; y < gridDepth; y++) {
                const p = gridToScreen({ gridX: x, gridY: y, zLayer: 0 }, offset);
                ctx.beginPath();
                ctx.moveTo(p.screenX, p.screenY - 16);
                ctx.lineTo(p.screenX + 32, p.screenY);
                ctx.lineTo(p.screenX, p.screenY + 16);
                ctx.lineTo(p.screenX - 32, p.screenY);
                ctx.closePath();
                ctx.stroke();
            }
        }
        const sorted = [...objects].sort(
            (a, b) => calculateIsometricDepthIndex(a.coordX, a.coordY, a.zLayer) - calculateIsometricDepthIndex(b.coordX, b.coordY, b.zLayer)
        );
        for (const o of sorted) {
            const { effWidth, effDepth } = getEffectiveDimensions(o);
            const corners = [
                gridToScreen({ gridX: o.coordX, gridY: o.coordY, zLayer: o.zLayer }, offset),
                gridToScreen({ gridX: o.coordX + effWidth, gridY: o.coordY, zLayer: o.zLayer }, offset),
                gridToScreen({ gridX: o.coordX + effWidth, gridY: o.coordY + effDepth, zLayer: o.zLayer }, offset),
                gridToScreen({ gridX: o.coordX, gridY: o.coordY + effDepth, zLayer: o.zLayer }, offset),
            ];
            ctx.beginPath();
            ctx.moveTo(corners[0].screenX, corners[0].screenY);
            for (const c of corners.slice(1)) ctx.lineTo(c.screenX, c.screenY);
            ctx.closePath();
            ctx.fillStyle = o.color ?? '#93c5fd';
            ctx.fill();
            ctx.strokeStyle = o.id === selectedId ? '#dc2626' : '#1e40af';
            ctx.lineWidth = o.id === selectedId ? 3 : 1;
            ctx.stroke();
            const cx = (corners[0].screenX + corners[2].screenX) / 2;
            const cy = (corners[0].screenY + corners[2].screenY) / 2;
            ctx.fillStyle = '#111827';
            ctx.font = '12px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText(o.label.slice(0, 12), cx, cy);
        }
    }, [gridWidth, gridDepth, objects, selectedId, width, height, offset.x, offset.y]);

    function handleClick(e: React.MouseEvent<HTMLCanvasElement>) {
        if (!onSelect) return;
        const rect = ref.current?.getBoundingClientRect();
        if (!rect) return;
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        let best: IsoObject | null = null;
        let bestDist = 48;
        for (const o of objects) {
            const { effWidth, effDepth } = getEffectiveDimensions(o);
            const c = gridToScreen({ gridX: o.coordX + effWidth / 2, gridY: o.coordY + effDepth / 2, zLayer: o.zLayer }, offset);
            const d = Math.hypot(c.screenX - mx, c.screenY - my);
            if (d < bestDist) { bestDist = d; best = o; }
        }
        if (best) onSelect(best.id);
    }

    return (
        <canvas
            ref={ref} width={width} height={height}
            className="max-w-full cursor-pointer border bg-white rounded-xl"
            onClick={handleClick}
        />
    );
};

export default AssetIsoCanvas;
