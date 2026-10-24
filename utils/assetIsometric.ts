/**
 * assetIsometric.ts — Stage 1 이식본 (로직 무변경)
 * 원본: ~/workspace/office-asset-fullstack/src/lib/isometric-math.ts
 * (2:1 투영, 깊이 인덱스, 회전 반영 유효 치수, AABB 겹침 검사)
 * 기존 utils/isometric.ts는 수정하지 않고 별도 파일로 분리한다.
 * TILE 64x32, 층 높이 24는 원본과 동일.
 */

export const TILE_WIDTH = 64;
export const TILE_HEIGHT = 32;
export const LAYER_HEIGHT = 24;

export interface GridCoord {
  gridX: number;
  gridY: number;
  zLayer?: number;
}

export interface ScreenCoord {
  screenX: number;
  screenY: number;
}

export interface GridObjectBox {
  id: string;
  coordX: number;
  coordY: number;
  widthCells: number;
  depthCells: number;
  zLayer: number;
  rotationDeg: 0 | 90 | 180 | 270;
}

export function gridToScreen(
  coord: GridCoord,
  cameraOffset: { x: number; y: number } = { x: 0, y: 0 }
): ScreenCoord {
  const z = coord.zLayer ?? 0;
  const screenX = (coord.gridX - coord.gridY) * (TILE_WIDTH / 2) + cameraOffset.x;
  const screenY =
    (coord.gridX + coord.gridY) * (TILE_HEIGHT / 2) - z * LAYER_HEIGHT + cameraOffset.y;
  return { screenX, screenY };
}

export function screenToGrid(
  screen: ScreenCoord,
  cameraOffset: { x: number; y: number } = { x: 0, y: 0 }
): { gridX: number; gridY: number } {
  const relX = screen.screenX - cameraOffset.x;
  const relY = screen.screenY - cameraOffset.y;
  const gridX = Math.floor((relX / (TILE_WIDTH / 2) + relY / (TILE_HEIGHT / 2)) / 2);
  const gridY = Math.floor((relY / (TILE_HEIGHT / 2) - relX / (TILE_WIDTH / 2)) / 2);
  return { gridX, gridY };
}

export function calculateIsometricDepthIndex(
  gridX: number,
  gridY: number,
  zLayer: number = 0,
  priority: number = 0
): number {
  return (gridX + gridY) * 100 + zLayer * 10 + priority;
}

export function getEffectiveDimensions(obj: Pick<GridObjectBox, 'widthCells' | 'depthCells' | 'rotationDeg'>) {
  const isRotated = obj.rotationDeg === 90 || obj.rotationDeg === 270;
  return {
    effWidth: isRotated ? obj.depthCells : obj.widthCells,
    effDepth: isRotated ? obj.widthCells : obj.depthCells,
  };
}

export function validateFloorPlanLayout(
  roomGridWidth: number,
  roomGridDepth: number,
  objects: GridObjectBox[]
): {
  valid: boolean;
  outOfBoundsIds: string[];
  collisionPairs: Array<[string, string]>;
} {
  const outOfBoundsIds: string[] = [];
  const collisionPairs: Array<[string, string]> = [];

  for (const obj of objects) {
    const { effWidth, effDepth } = getEffectiveDimensions(obj);
    if (
      obj.coordX < 0 ||
      obj.coordY < 0 ||
      obj.coordX + effWidth > roomGridWidth ||
      obj.coordY + effDepth > roomGridDepth
    ) {
      outOfBoundsIds.push(obj.id);
    }
  }

  for (let i = 0; i < objects.length; i++) {
    for (let j = i + 1; j < objects.length; j++) {
      const a = objects[i];
      const b = objects[j];
      if (a.zLayer !== b.zLayer) continue;

      const dimA = getEffectiveDimensions(a);
      const dimB = getEffectiveDimensions(b);

      const overlapX = a.coordX < b.coordX + dimB.effWidth && a.coordX + dimA.effWidth > b.coordX;
      const overlapY = a.coordY < b.coordY + dimB.effDepth && a.coordY + dimA.effDepth > b.coordY;

      if (overlapX && overlapY) {
        collisionPairs.push([a.id, b.id]);
      }
    }
  }

  return {
    valid: outOfBoundsIds.length === 0 && collisionPairs.length === 0,
    outOfBoundsIds,
    collisionPairs,
  };
}
