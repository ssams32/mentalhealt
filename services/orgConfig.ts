/**
 * services/orgConfig.ts — 기관별 설정 외부화 모듈 (다센터 지원)
 *
 * - 앱 부팅 시 /api/settings에서 설정을 로드해 메모리에 캐시
 * - 조회 실패/설정 비어있음 → constants.ts의 기존 하드코딩 값을 폴백으로 사용 (이중 안전장치)
 * - 모든 getter는 동기 함수이므로 컴포넌트·유틸 어디서든 사용 가능
 * - 설정 변경(관리자) 후에는 새로고침 시 반영 (캐시 무효화는 refreshOrgConfig)
 *
 * ⚠️ 기존 데이터 무손실 원칙: 이 모듈은 읽기 전용. 기존 데이터 행을 절대 수정하지 않음.
 */
import {
    MAIN_TEAMS,
    TEAM_CODES,
    TEAMS_CONFIG,
    NAMBU_SUB_TEAMS,
    ICHEON_REGIONS,
    REFERRAL_PATH_OPTIONS,
} from '../constants';

export interface OrgTeam {
    name: string;
    code: string;
}

export interface OrgSettings {
    orgName: string;
    orgShortName: string;
    region: string;
    setupCompleted: boolean;
    teams: OrgTeam[];
    subTeams: string[];
    subTeamParent: string;
    regions: string[];
    referralPaths: string[];
}

// 폴백 기본값: constants.ts의 현재 값과 100% 동일 (서버 시드와 일치)
const DEFAULT_SETTINGS: OrgSettings = {
    orgName: '이천시정신건강복지센터',
    orgShortName: '이천센터',
    region: '이천',
    setupCompleted: true,
    teams: (MAIN_TEAMS as string[]).map((name) => ({
        name,
        code: (TEAM_CODES as Record<string, string>)[name] || 'ET',
    })),
    subTeams: [...NAMBU_SUB_TEAMS],
    subTeamParent: '남부분소',
    regions: [...ICHEON_REGIONS],
    referralPaths: [...REFERRAL_PATH_OPTIONS],
};

let cache: OrgSettings | null = null;
let initPromise: Promise<OrgSettings> | null = null;

function sanitize(raw: any): OrgSettings | null {
    if (!raw || typeof raw !== 'object') return null;
    // 신규 설치(미인증): GET /api/settings는 {setupCompleted:false}만 반환한다.
    // teams가 없어도 마법사가 표시되도록 플래그를 살린 기본값을 반환 (chicken-and-egg 방지).
    if (raw.setupCompleted === false && !(Array.isArray(raw.teams) && raw.teams.length > 0)) {
        return {
            ...DEFAULT_SETTINGS,
            teams: DEFAULT_SETTINGS.teams.map((t) => ({ ...t })),
            subTeams: [...DEFAULT_SETTINGS.subTeams],
            regions: [...DEFAULT_SETTINGS.regions],
            referralPaths: [...DEFAULT_SETTINGS.referralPaths],
            setupCompleted: false,
        };
    }
    const teams = Array.isArray(raw.teams) && raw.teams.length > 0
        ? raw.teams.filter((t: any) => t && t.name).map((t: any) => ({ name: String(t.name), code: String(t.code || 'ET') }))
        : null;
    if (!teams) return null; // teams가 비어있으면 폴백 (드롭다운 붕괴 방지)
    return {
        orgName: String(raw.orgName || DEFAULT_SETTINGS.orgName),
        orgShortName: String(raw.orgShortName || DEFAULT_SETTINGS.orgShortName),
        region: String(raw.region || ''),
        setupCompleted: raw.setupCompleted !== false,
        teams,
        subTeams: Array.isArray(raw.subTeams) ? raw.subTeams.map(String) : [...DEFAULT_SETTINGS.subTeams],
        subTeamParent: typeof raw.subTeamParent === 'string' && raw.subTeamParent ? raw.subTeamParent : DEFAULT_SETTINGS.subTeamParent,
        regions: Array.isArray(raw.regions) && raw.regions.length > 0 ? raw.regions.map(String) : [...DEFAULT_SETTINGS.regions],
        referralPaths: Array.isArray(raw.referralPaths) && raw.referralPaths.length > 0 ? raw.referralPaths.map(String) : [...DEFAULT_SETTINGS.referralPaths],
    };
}

function getAuthHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    try {
        const saved = window.sessionStorage.getItem('currentUser');
        if (saved) {
            const user = JSON.parse(saved);
            if (user?.id) headers['x-user-id'] = user.id;
            if (user?.role) headers['x-user-role'] = user.role;
        }
    } catch { /* 무시 */ }
    return headers;
}

/** 앱 부팅 시 1회 호출. 실패해도 폴백 기본값으로 동작. */
export function initOrgConfig(): Promise<OrgSettings> {
    if (initPromise) return initPromise;
    initPromise = (async () => {
        try {
            const base = (import.meta as any).env?.VITE_API_BASE_URL || '/api';
            const res = await fetch(`${base}/settings`, { headers: getAuthHeaders() });
            if (res.ok) {
                const data = await res.json();
                const clean = sanitize(data);
                if (clean) {
                    cache = clean;
                    return clean;
                }
            }
        } catch { /* 폴백 */ }
        cache = { ...DEFAULT_SETTINGS };
        return cache;
    })();
    return initPromise;
}

/** 설정 강제 새로고침 (관리자 설정 변경 후) */
export async function refreshOrgConfig(): Promise<OrgSettings> {
    initPromise = null;
    cache = null;
    _teams = _subTeams = _regions = _paths = null;
    _teamsConfig = null;
    _teamsFor = _subTeamsFor = _regionsFor = _pathsFor = _teamsConfigFor = null;
    return initOrgConfig();
}

/** 동기 조회. initOrgConfig() 이전에 호출되면 폴백 기본값 반환. */
export function getOrgConfig(): OrgSettings {
    return cache || DEFAULT_SETTINGS;
}

export function getOrgName(): string {
    return getOrgConfig().orgName;
}

export function getOrgShortName(): string {
    return getOrgConfig().orgShortName;
}

/** 팀 이름 목록 (기존 MAIN_TEAMS 대체). 동일 설정에 대해 안정적 참조 반환. */
let _teams: string[] | null = null;
let _teamsFor: OrgSettings | null = null;
export function getTeams(): string[] {
    const cfg = getOrgConfig();
    if (_teamsFor !== cfg || !_teams) {
        _teams = cfg.teams.map((t) => t.name);
        _teamsFor = cfg;
    }
    return _teams;
}

/** 팀 코드 조회 (기존 TEAM_CODES[team] || 'ET' 대체) */
export function getTeamCode(teamName: string): string {
    const t = getOrgConfig().teams.find((x) => x.name === teamName);
    if (t && t.code) return t.code;
    return (TEAM_CODES as Record<string, string>)[teamName] || 'ET';
}

/** 팀별 아이콘/타이틀 설정 (기존 TEAMS_CONFIG 대체). 신규 팀은 기본 아이콘. 안정적 참조 반환. */
let _teamsConfig: Record<string, { title: string; icon: string }> | null = null;
let _teamsConfigFor: OrgSettings | null = null;
export function getTeamsConfig(): Record<string, { title: string; icon: string }> {
    const cfg = getOrgConfig();
    if (_teamsConfigFor !== cfg || !_teamsConfig) {
        const built: Record<string, { title: string; icon: string }> = {};
        for (const t of cfg.teams) {
            const legacy = (TEAMS_CONFIG as Record<string, { title: string; icon: string }>)[t.name];
            built[t.name] = { title: t.name, icon: legacy?.icon || 'fa-users' };
        }
        _teamsConfig = built;
        _teamsConfigFor = cfg;
    }
    return _teamsConfig;
}

/** 세부팀을 사용하는 팀 이름 (기존 '남부분소' 하드코딩 대체) */
export function getSubTeamParent(): string {
    return getOrgConfig().subTeamParent;
}

/** 특정 팀의 세부팀 목록. 해당 팀이 아니면 빈 배열. */
export function getSubTeamsFor(teamName: string): string[] {
    const cfg = getOrgConfig();
    if (teamName && teamName === cfg.subTeamParent) return getSubTeams();
    return [];
}
let _subTeams: string[] | null = null;
let _subTeamsFor: OrgSettings | null = null;
export function getSubTeams(): string[] {
    const cfg = getOrgConfig();
    if (_subTeamsFor !== cfg || !_subTeams) {
        _subTeams = [...cfg.subTeams];
        _subTeamsFor = cfg;
    }
    return _subTeams;
}

/** 지역 목록 (기존 ICHEON_REGIONS 대체). 안정적 참조 반환. */
let _regions: string[] | null = null;
let _regionsFor: OrgSettings | null = null;
export function getRegions(): string[] {
    const cfg = getOrgConfig();
    if (_regionsFor !== cfg || !_regions) {
        _regions = [...cfg.regions];
        _regionsFor = cfg;
    }
    return _regions;
}

/** 의뢰경로 목록 (기존 REFERRAL_PATH_OPTIONS 대체). 안정적 참조 반환. */
let _paths: string[] | null = null;
let _pathsFor: OrgSettings | null = null;
export function getReferralPaths(): string[] {
    const cfg = getOrgConfig();
    if (_pathsFor !== cfg || !_paths) {
        _paths = [...cfg.referralPaths];
        _pathsFor = cfg;
    }
    return _paths;
}

/** 초기 설정 완료 여부 */
export function isSetupCompleted(): boolean {
    return getOrgConfig().setupCompleted;
}
