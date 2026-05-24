/**
 * isometric.ts
 * Core Math for 2.5D Projection
 * Apple-style precision for pixel-perfect alignment.
 */

export const TILE_WIDTH = 64;  // Standard tile width
export const TILE_HEIGHT = 32; // Standard tile height (2:1 ratio)

/**
 * Convert Cartesian (Grid) coordinates to Isometric (Screen) coordinates.
 * @param x Grid X
 * @param y Grid Y
 * @returns { x, y } Screen pixel coordinates (centered relative to origin)
 */
/**
 * Convert Cartesian (Grid) coordinates to Isometric (Screen) coordinates.
 * Apple-style precision: Use consistent rounding to prevent sub-pixel gaps.
 */
export const toScreen = (x: number, y: number) => {
    return {
        x: Math.round((x - y) * (TILE_WIDTH / 2)),
        y: Math.round((x + y) * (TILE_HEIGHT / 2))
    };
};

export const toGrid = (screenX: number, screenY: number) => {
    const halfW = TILE_WIDTH / 2;
    const halfH = TILE_HEIGHT / 2;

    // Use floating point for intermediate calculation to avoid premature snapping
    const x = (screenX / halfW + screenY / halfH) / 2;
    const y = (screenY / halfH - screenX / halfW) / 2;

    return { x, y };
};

/**
 * Snap a floating point grid coordinate to the nearest integer.
 */
export const snapToGrid = (coord: number) => Math.round(coord);

/**
 * Calculate Z-Index based on Grid Y (Depth).
 * Objects 'lower' on the screen (higher Y) should be on top.
 * Step 14: Refined Tie-breaking Painter's Algorithm.
 */
export const getZIndex = (x: number, y: number, floorLevel: number = 0) => {
    // We multiply coordinates by 10 to ensure even fractional positions (if any) are sorted.
    // Tie-breaker: use X to ensure stable rendering order for items on the same depth line.
    const depth = (x + y) * 100 + x;
    return Math.floor(depth) + (floorLevel * 1000000);
};

