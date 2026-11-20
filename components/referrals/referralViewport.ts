export const DESKTOP_BREAKPOINT_PX = 1024;

type MatchMediaFn = (query: string) => { matches: boolean };

export function isDesktopViewport(matchMediaFn?: MatchMediaFn | null): boolean {
    if (typeof matchMediaFn !== 'function') return true;
    return matchMediaFn(`(min-width: ${DESKTOP_BREAKPOINT_PX}px)`).matches;
}
