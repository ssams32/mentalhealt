/**
 * server/assets/assetRouter.js — Stage 1 + Stage 2 (JSON 저장 자산관리)
 * Express 라우터 팩토리. survey/voice-calls 패턴을 따른다:
 *   createAssetRouter({ requireAuth, requireAdmin, getData, persistData })
 * 필수 deps 누락 시 생성 시점에 throw한다.
 * 저장소는 주입받은 getData/persistData만 쓰며, DATA_DIR 아래 Asset_* 파일에 저장한다.
 * 기존 PC_Assets 파일·/api/pcassets 엔드포인트는 읽지도 쓰지도 않는다.
 *
 * Stage 2 파일 집합 (신규):
 *   Asset_FloorPlans, Asset_FloorPlanVersions, Asset_FloorPlanObjects,
 *   Asset_QrCodes, Asset_InventoryPlans, Asset_InventoryTargets, Asset_InventoryChecks
 * Stage 2에서 만들지 않는 파일: Asset_Assignments(이연 — 보고서 참조),
 *   Asset_Approvals(불필요 — 조사 승인은 InventoryChecks 상태 전이로 처리, M-9 확정).
 *
 * 권한 (Stage 2 확정, STAGE2_CHECK.md 참조):
 *   - 공개 QR 조회(GET /public/qr/:token)만 무인증. 그 외 모든 라우트 requireAuth (비로그인 401).
 *   - 배치도 생성·초안 수정·게시·복원, QR 발급·재발급, 조사 계획·검토·승인: admin 전용 (비관리자 403).
 *   - 조사 제출: 전용 가드 requireInventorySubmit — admin·manager 또는
 *     ASSET_AUDIT_ACCESS 플래그 보유 user만 통과. 플래그 보유자는 조사 제출 외의
 *     모든 쓰기(자산·배치도·QR·승인)에서 403이다 (M-4 확정).
 *   - 공개 QR 속도 제한: 인메모리 IP당 분당 30건. 다중 인스턴스에서 공유되지 않는다 (M-10).
 *   - 공식 위치 불변: 조사 제출은 Asset_Locations를 절대 바꾸지 않는다.
 *     관리자 승인 + followUpAction=UPDATE_OFFICIAL_LOCATION일 때만
 *     Asset_Locations 갱신 + Asset_LocationHistory + Asset_AuditLogs를 기록한다.
 *
    // Stage 3 파일: Asset_Imports (작업 헤더), Asset_ImportRows (행별 검증·처리 결과·롤백 스냅샷).
    // 감사로그(Asset_AuditLogs)는 append-only를 유지하며, Stage 3에서도 쓰기·수정·삭제 API를 두지 않는다.
 */

import express from 'express';
import crypto from 'crypto';
import XLSX from 'xlsx';
import {
    sanitizeExcelCell,
    containsFormulaInjectionRisk,
    formatExportCell,
    csvEscape,
} from './assetExcelSanitizer.js';
import {
    OPERATIONAL_STATUSES,
    canTransitionOperationalStatus,
    SPACE_PARENT_KIND,
    SPACE_KINDS,
    validateFloorPlanLayout,
    findDuplicateFurnitureIds,
    FLOOR_PLAN_OBJECT_TYPES,
    FLOOR_PLAN_ROTATIONS,
    INVENTORY_RESULT_STATUSES,
    FOLLOW_UP_ACTIONS,
    validateInventorySubmissionRules,
    normalizeReviewDecision,
    canApplyOfficialLocationUpdate,
    computeInventoryProgress,
} from './assetStateMachine.js';

const ASSETS_FILE = 'Asset_Assets';
const CATEGORIES_FILE = 'Asset_Categories';
const LOCATIONS_FILE = 'Asset_Locations';
const LOCATION_HISTORY_FILE = 'Asset_LocationHistory';
const SPACES_FILE = 'Asset_Spaces';
const AUDIT_FILE = 'Asset_AuditLogs';
const FLOOR_PLANS_FILE = 'Asset_FloorPlans';
const FLOOR_PLAN_VERSIONS_FILE = 'Asset_FloorPlanVersions';
const FLOOR_PLAN_OBJECTS_FILE = 'Asset_FloorPlanObjects';
const QR_CODES_FILE = 'Asset_QrCodes';
const INVENTORY_PLANS_FILE = 'Asset_InventoryPlans';
const INVENTORY_TARGETS_FILE = 'Asset_InventoryTargets';
const INVENTORY_CHECKS_FILE = 'Asset_InventoryChecks';
const IMPORTS_FILE = 'Asset_Imports';
const IMPORT_ROWS_FILE = 'Asset_ImportRows';

/** 검색 정규화: NFKC + 소문자 + 공백·하이픈·언더스코어 제거 (부분일치용). */
export function normalizeSearchText(value) {
    if (value === null || value === undefined) return '';
    return String(value).normalize('NFKC').toLowerCase().replace(/[\s\-_]/g, '');
}

function asString(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function nowIso() {
    return new Date().toISOString();
}

function copyRows(rows) {
    return Array.isArray(rows) ? rows.map((r) => ({ ...r })) : [];
}

export function createAssetRouter(deps = {}) {
    const { requireAuth, requireAdmin, getData, persistData } = deps;

    if (!requireAuth) throw new Error('createAssetRouter requires requireAuth dependency');
    if (!requireAdmin) throw new Error('createAssetRouter requires requireAdmin dependency');
    if (!getData) throw new Error('createAssetRouter requires getData dependency');
    if (!persistData) throw new Error('createAssetRouter requires persistData dependency');

    const router = express.Router();

    // ============ 공개 QR 조회 (무인증 — 이 라우트만 requireAuth보다 먼저 등록) ============
    // 반환은 자산번호·품명·등록 사무실명만으로 제한한다.
    // 시리얼·취득가·담당자 개인정보·내부 ID·QR 내부 ID·토큰 버전은 절대 노출하지 않는다.
    // 속도 제한: 인메모리 IP당 분당 30건 (Stage 0 실측값). 프로세스 메모리기 때문에
    // 다중 인스턴스에서는 공유되지 않고, 재기동 시 초기화된다 (M-10 한계).
    const publicQrRate = new Map(); // ip -> [epoch ms, ...]
    router.get('/public/qr/:token', (req, res) => {
        const ip = req.ip || req.socket?.remoteAddress || 'unknown';
        const nowMs = Date.now();
        const windowMs = 60 * 1000;
        const hits = (publicQrRate.get(ip) || []).filter((t) => nowMs - t < windowMs);
        if (hits.length >= 30) {
            return res.status(429).json({ success: false, error: '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.', code: 'RATE_LIMITED' });
        }
        hits.push(nowMs);
        publicQrRate.set(ip, hits);
        const token = String(req.params.token || '');
        if (!/^[A-Za-z0-9_-]{16,32}$/.test(token)) {
            return res.status(404).json({ success: false, error: 'QR을 찾을 수 없습니다.' });
        }
        const qr = getData(QR_CODES_FILE, []).find((q) => q.publicToken === token) || null;
        if (!qr) return res.status(404).json({ success: false, error: 'QR을 찾을 수 없습니다.' });
        if (qr.status === 'REVOKED') {
            return res.status(410).json({ success: false, error: '폐기된 QR입니다.', code: 'QR_REVOKED' });
        }
        if (qr.status !== 'ACTIVE' && qr.status !== 'DAMAGED_REPORTED') {
            return res.status(404).json({ success: false, error: 'QR을 찾을 수 없습니다.' });
        }
        const asset = getData(ASSETS_FILE, []).find((a) => a.id === qr.assetId && a.isActive) || null;
        if (!asset) return res.status(404).json({ success: false, error: 'QR을 찾을 수 없습니다.' });
        const locations = getData(LOCATIONS_FILE, []);
        const location = locations.find((l) => l.assetId === asset.id) || null;
        const spaces = getData(SPACES_FILE, []);
        const room = location && location.roomId
            ? spaces.find((s) => s.id === location.roomId && s.kind === 'room') || null
            : null;
        // 최소 정보만 반환한다 (내부 ID·시리얼·취득가·담당자 없음).
        return res.json({
            success: true,
            data: { assetNumber: asset.assetNumber, name: asset.name, roomName: room ? room.name : null },
        });
    });

    router.use(requireAuth);

    const isAdmin = (req) => req.auth && req.auth.role === 'admin';
    const isManager = (req) => req.auth && req.auth.role === 'manager';

    /** admin 또는 manager만 통과 (그 외 403). requireAuth는 이미 통과한 상태다. */
    const requireAssetWrite = (req, res, next) => {
        if (isAdmin(req) || isManager(req)) return next();
        return res.status(403).json({ success: false, error: '자산 생성·수정 권한이 없습니다.' });
    };

    /** 팀 스코프: admin은 전체, 그 외는 team이 비어 있거나 본인 팀인 자산만. */
    const inTeamScope = (req, asset) => {
        if (isAdmin(req)) return true;
        if (!asset.team) return true;
        return asset.team === req.auth.team;
    };

    const load = (file) => copyRows(getData(file, []));

    async function appendAudit({ action, entityType, entityId, req, detail }) {
        try {
            const logs = load(AUDIT_FILE);
            logs.push({
                id: crypto.randomUUID(),
                action,
                entityType,
                entityId: entityId || null,
                actorId: req.auth ? req.auth.id : null,
                actorName: req.auth ? req.auth.name : null,
                actorRole: req.auth ? req.auth.role : null,
                detail: detail || null,
                createdAt: nowIso(),
            });
            await persistData(AUDIT_FILE, logs);
        } catch (err) {
            // 감사로그 기록 실패가 본 동작을 되돌리지는 않는다 (기존 AuditEntries와 동일한 취지).
            // 단, 실패를 숨기지 않고 서버 로그에 남긴다.
            console.error('[ASSET_AUDIT_ERROR]:', err.message);
        }
    }

    function findActiveAsset(assetNumber, excludeId) {
        const needle = asString(assetNumber).toLowerCase();
        if (!needle) return null;
        return load(ASSETS_FILE).find(
            (a) => a.isActive && asString(a.assetNumber).toLowerCase() === needle && a.id !== excludeId
        ) || null;
    }

    function serializeAsset(asset, req) {
        const locations = load(LOCATIONS_FILE);
        const location = locations.find((l) => l.assetId === asset.id) || null;
        const categories = load(CATEGORIES_FILE);
        const category = asset.categoryId
            ? categories.find((c) => c.id === asset.categoryId) || null
            : null;
        const spaces = load(SPACES_FILE);
        const room = location && location.roomId
            ? spaces.find((s) => s.id === location.roomId && s.kind === 'room') || null
            : null;
        return {
            ...asset,
            categoryName: category ? category.name : null,
            location,
            roomName: room ? room.name : null,
            // 취득가는 민감 필드이므로 admin·manager에게만 노출하고 일반 조회에서는 제외한다.
            acquisitionCost: (isAdmin(req) || isManager(req)) ? asset.acquisitionCost ?? null : null,
        };
    }

    function validateLocationInput(location, spaces) {
        if (location === undefined || location === null) return { ok: true, value: null };
        if (typeof location !== 'object' || Array.isArray(location)) {
            return { ok: false, error: 'location은 객체여야 합니다.' };
        }
        const roomId = asString(location.roomId);
        if (roomId) {
            const room = spaces.find((s) => s.id === roomId && s.kind === 'room' && s.isActive);
            if (!room) return { ok: false, error: '존재하지 않는 사무실(roomId)입니다.' };
        }
        const zoneId = asString(location.zoneId);
        if (zoneId) {
            const zone = spaces.find((s) => s.id === zoneId && s.kind === 'zone' && s.isActive);
            if (!zone) return { ok: false, error: '존재하지 않는 구역(zoneId)입니다.' };
            if (roomId && zone.parentId !== roomId) {
                return { ok: false, error: '구역이 해당 사무실에 속하지 않습니다.' };
            }
        }
        const furnitureId = asString(location.furnitureId);
        if (furnitureId) {
            const furniture = spaces.find((s) => s.id === furnitureId && s.kind === 'furniture' && s.isActive);
            if (!furniture) return { ok: false, error: '존재하지 않는 가구(furnitureId)입니다.' };
            if (roomId && furniture.parentId !== roomId) {
                return { ok: false, error: '가구가 해당 사무실에 속하지 않습니다.' };
            }
        }
        return {
            ok: true,
            value: {
                roomId: roomId || null,
                zoneId: zoneId || null,
                furnitureId: furnitureId || null,
                shelfSlot: asString(location.shelfSlot) || null,
                note: asString(location.note) || null,
            },
        };
    }

    async function applyLocation(assetId, locationValue, req, reason) {
        // 자산당 현재 위치 1건(Asset_Locations) + 변경 이력 append(Asset_LocationHistory).
        // persist 전에 모든 검증을 마친 뒤에만 호출한다.
        const locations = load(LOCATIONS_FILE);
        const existing = locations.find((l) => l.assetId === assetId);
        const next = {
            id: existing ? existing.id : crypto.randomUUID(),
            assetId,
            roomId: locationValue.roomId,
            zoneId: locationValue.zoneId,
            furnitureId: locationValue.furnitureId,
            shelfSlot: locationValue.shelfSlot,
            note: locationValue.note,
            // Stage 3: 확인 시각은 조사 승인 시에만 갱신한다. 위치 이동만으로는 바뀌지 않는다.
            // 신규 위치 행은 null로 시작해 원본 규칙대로 "미확인"으로 센다.
            lastVerifiedAt: existing ? (existing.lastVerifiedAt || null) : null,
            updatedAt: nowIso(),
            updatedBy: req.auth ? req.auth.id : null,
        };
        const nextLocations = existing
            ? locations.map((l) => (l.assetId === assetId ? next : l))
            : [...locations, next];
        await persistData(LOCATIONS_FILE, nextLocations);
        const history = load(LOCATION_HISTORY_FILE);
        history.push({
            id: crypto.randomUUID(),
            assetId,
            roomId: next.roomId,
            zoneId: next.zoneId,
            furnitureId: next.furnitureId,
            reason: reason || 'LOCATION_SET',
            changedBy: req.auth ? req.auth.id : null,
            createdAt: nowIso(),
        });
        await persistData(LOCATION_HISTORY_FILE, history);
        return next;
    }

    // ================= 자산 목록·검색 =================

    router.get('/assets', (req, res) => {
        const assets = load(ASSETS_FILE).filter((a) => a.isActive);
        const scoped = assets.filter((a) => inTeamScope(req, a));
        const status = asString(req.query.status);
        const team = asString(req.query.team);
        const filtered = scoped.filter((a) => {
            if (status && a.operationalStatus !== status) return false;
            if (team && a.team !== team) return false;
            return true;
        });
        return res.json({ success: true, data: filtered.map((a) => serializeAsset(a, req)), total: filtered.length });
    });

    // 주의: /assets/search는 /assets/:id보다 먼저 등록해야 한다.
    router.get('/assets/search', (req, res) => {
        const q = asString(req.query.q);
        if (!q) return res.json({ success: true, data: [], total: 0, query: q });
        const needle = normalizeSearchText(q);
        const assets = load(ASSETS_FILE).filter((a) => a.isActive && inTeamScope(req, a));
        const matched = assets.filter((a) => {
            const haystacks = [
                a.assetNumber, a.name, a.manufacturer, a.modelName, a.serialNumber, a.team,
            ].map(normalizeSearchText);
            return haystacks.some((h) => h && h.includes(needle));
        });
        return res.json({ success: true, data: matched.map((a) => serializeAsset(a, req)), total: matched.length, query: q });
    });

    router.get('/assets/:id', (req, res) => {
        const asset = load(ASSETS_FILE).find((a) => a.id === req.params.id && a.isActive);
        if (!asset) return res.status(404).json({ success: false, error: '자산을 찾을 수 없습니다.' });
        if (!inTeamScope(req, asset)) return res.status(403).json({ success: false, error: '해당 팀 자산이 아닙니다.' });
        return res.json({ success: true, data: serializeAsset(asset, req) });
    });

    router.post('/assets', requireAssetWrite, async (req, res) => {
        try {
            const body = req.body || {};
            const assetNumber = asString(body.assetNumber);
            const name = asString(body.name);
            if (!assetNumber) return res.status(400).json({ success: false, error: '자산번호(assetNumber)는 필수입니다.' });
            if (!name) return res.status(400).json({ success: false, error: '품명(name)은 필수입니다.' });
            const operationalStatus = asString(body.operationalStatus) || 'IN_USE';
            if (!OPERATIONAL_STATUSES.includes(operationalStatus)) {
                return res.status(400).json({ success: false, error: '유효하지 않은 운영 상태입니다.' });
            }
            // 저장 전 코드 검사: 활성 자산번호 중복 (부분 고유 인덱스 대체).
            if (findActiveAsset(assetNumber, null)) {
                return res.status(409).json({ success: false, error: '이미 등록된 자산번호입니다.', code: 'ASSET_NUMBER_DUPLICATE' });
            }
            const spaces = load(SPACES_FILE);
            const locationCheck = validateLocationInput(body.location, spaces);
            if (!locationCheck.ok) return res.status(400).json({ success: false, error: locationCheck.error });
            let categoryId = asString(body.categoryId) || null;
            if (categoryId) {
                const category = load(CATEGORIES_FILE).find((c) => c.id === categoryId && c.isActive);
                if (!category) return res.status(400).json({ success: false, error: '존재하지 않는 분류(categoryId)입니다.' });
            }
            // manager는 본인 팀으로 강제, admin은 body.team 허용.
            const team = isAdmin(req) ? (asString(body.team) || null) : (req.auth.team || null);
            const asset = {
                id: crypto.randomUUID(),
                assetNumber,
                name,
                categoryId,
                manufacturer: asString(body.manufacturer) || null,
                modelName: asString(body.modelName) || null,
                serialNumber: asString(body.serialNumber) || null,
                acquisitionDate: asString(body.acquisitionDate) || null,
                acquisitionCost: body.acquisitionCost === undefined || body.acquisitionCost === null || body.acquisitionCost === ''
                    ? null : Number(body.acquisitionCost),
                acquisitionMethod: asString(body.acquisitionMethod) || null,
                usefulLifeYears: body.usefulLifeYears === undefined || body.usefulLifeYears === null || body.usefulLifeYears === ''
                    ? null : Number(body.usefulLifeYears),
                team,
                custodianUserId: asString(body.custodianUserId) || null,
                operationalStatus,
                usageType: asString(body.usageType) || 'DEDICATED',
                notes: asString(body.notes) || null,
                isActive: true,
                deactivatedAt: null,
                deactivationReason: null,
                createdBy: req.auth ? req.auth.id : null,
                createdAt: nowIso(),
                updatedAt: nowIso(),
            };
            if (asset.acquisitionCost !== null && Number.isNaN(asset.acquisitionCost)) {
                return res.status(400).json({ success: false, error: '취득가(acquisitionCost)는 숫자여야 합니다.' });
            }
            const assets = load(ASSETS_FILE);
            assets.push(asset);
            await persistData(ASSETS_FILE, assets);
            if (locationCheck.value) {
                await applyLocation(asset.id, locationCheck.value, req, 'ASSET_CREATED');
            }
            await appendAudit({ action: 'ASSET_CREATED', entityType: 'Asset', entityId: asset.id, req, detail: { assetNumber } });
            return res.status(201).json({ success: true, data: serializeAsset(asset, req) });
        } catch (err) {
            console.error('[ASSET_CREATE_ERROR]:', err.message);
            return res.status(500).json({ success: false, error: '자산 생성 중 오류가 발생했습니다.' });
        }
    });

    router.patch('/assets/:id', requireAssetWrite, async (req, res) => {
        try {
            const assets = load(ASSETS_FILE);
            const asset = assets.find((a) => a.id === req.params.id && a.isActive);
            if (!asset) return res.status(404).json({ success: false, error: '자산을 찾을 수 없습니다.' });
            // manager 범위: 본인 팀 자산(또는 팀 미지정 자산)만 수정, team 변경 불가.
            if (!isAdmin(req) && asset.team && asset.team !== req.auth.team) {
                return res.status(403).json({ success: false, error: '해당 팀 자산이 아닙니다.' });
            }
            const body = req.body || {};
            if (body.assetNumber !== undefined) {
                const nextNumber = asString(body.assetNumber);
                if (!nextNumber) return res.status(400).json({ success: false, error: '자산번호는 비울 수 없습니다.' });
                if (findActiveAsset(nextNumber, asset.id)) {
                    return res.status(409).json({ success: false, error: '이미 등록된 자산번호입니다.', code: 'ASSET_NUMBER_DUPLICATE' });
                }
                asset.assetNumber = nextNumber;
            }
            if (body.operationalStatus !== undefined) {
                const nextStatus = asString(body.operationalStatus);
                if (!OPERATIONAL_STATUSES.includes(nextStatus)) {
                    return res.status(400).json({ success: false, error: '유효하지 않은 운영 상태입니다.' });
                }
                if (!canTransitionOperationalStatus(asset.operationalStatus, nextStatus)) {
                    return res.status(400).json({ success: false, error: `운영 상태 전이가 허용되지 않습니다: ${asset.operationalStatus} -> ${nextStatus}` });
                }
                asset.operationalStatus = nextStatus;
            }
            const spaces = load(SPACES_FILE);
            let nextLocation = null;
            if (body.location !== undefined) {
                const locationCheck = validateLocationInput(body.location, spaces);
                if (!locationCheck.ok) return res.status(400).json({ success: false, error: locationCheck.error });
                nextLocation = locationCheck.value;
            }
            for (const field of ['name', 'manufacturer', 'modelName', 'serialNumber', 'acquisitionMethod', 'usageType', 'notes']) {
                if (body[field] !== undefined) asset[field] = asString(body[field]) || null;
            }
            if (body.categoryId !== undefined) {
                const categoryId = asString(body.categoryId) || null;
                if (categoryId) {
                    const category = load(CATEGORIES_FILE).find((c) => c.id === categoryId && c.isActive);
                    if (!category) return res.status(400).json({ success: false, error: '존재하지 않는 분류(categoryId)입니다.' });
                }
                asset.categoryId = categoryId;
            }
            if (body.team !== undefined && isAdmin(req)) asset.team = asString(body.team) || null;
            if (body.custodianUserId !== undefined) asset.custodianUserId = asString(body.custodianUserId) || null;
            if (body.acquisitionDate !== undefined) asset.acquisitionDate = asString(body.acquisitionDate) || null;
            if (body.acquisitionCost !== undefined) {
                asset.acquisitionCost = (body.acquisitionCost === null || body.acquisitionCost === '')
                    ? null : Number(body.acquisitionCost);
                if (asset.acquisitionCost !== null && Number.isNaN(asset.acquisitionCost)) {
                    return res.status(400).json({ success: false, error: '취득가(acquisitionCost)는 숫자여야 합니다.' });
                }
            }
            asset.updatedAt = nowIso();
            await persistData(ASSETS_FILE, assets);
            if (nextLocation) {
                await applyLocation(asset.id, nextLocation, req, 'ASSET_UPDATED');
            }
            await appendAudit({ action: 'ASSET_UPDATED', entityType: 'Asset', entityId: asset.id, req, detail: { assetNumber: asset.assetNumber } });
            return res.json({ success: true, data: serializeAsset(asset, req) });
        } catch (err) {
            console.error('[ASSET_UPDATE_ERROR]:', err.message);
            return res.status(500).json({ success: false, error: '자산 수정 중 오류가 발생했습니다.' });
        }
    });

    // 소프트 삭제만 한다 (물리 삭제 없음). admin 전용.
    router.delete('/assets/:id', requireAdmin, async (req, res) => {
        try {
            const assets = load(ASSETS_FILE);
            const asset = assets.find((a) => a.id === req.params.id && a.isActive);
            if (!asset) return res.status(404).json({ success: false, error: '자산을 찾을 수 없습니다.' });
            asset.isActive = false;
            asset.deactivatedAt = nowIso();
            asset.deactivationReason = asString((req.body || {}).reason) || '관리자 삭제';
            asset.updatedAt = nowIso();
            await persistData(ASSETS_FILE, assets);
            await appendAudit({ action: 'ASSET_DELETED', entityType: 'Asset', entityId: asset.id, req, detail: { assetNumber: asset.assetNumber, reason: asset.deactivationReason } });
            return res.json({ success: true, data: { id: asset.id, isActive: false } });
        } catch (err) {
            console.error('[ASSET_DELETE_ERROR]:', err.message);
            return res.status(500).json({ success: false, error: '자산 삭제 중 오류가 발생했습니다.' });
        }
    });

    // ================= 분류 =================

    router.get('/categories', (req, res) => {
        const categories = load(CATEGORIES_FILE).filter((c) => c.isActive);
        return res.json({ success: true, data: categories, total: categories.length });
    });

    router.post('/categories', requireAdmin, async (req, res) => {
        try {
            const body = req.body || {};
            const code = asString(body.code);
            const name = asString(body.name);
            if (!code) return res.status(400).json({ success: false, error: '분류 코드(code)는 필수입니다.' });
            if (!name) return res.status(400).json({ success: false, error: '분류명(name)은 필수입니다.' });
            const categories = load(CATEGORIES_FILE);
            if (categories.some((c) => c.isActive && asString(c.code).toLowerCase() === code.toLowerCase())) {
                return res.status(409).json({ success: false, error: '이미 등록된 분류 코드입니다.', code: 'CATEGORY_CODE_DUPLICATE' });
            }
            const category = {
                id: crypto.randomUUID(),
                parentId: asString(body.parentId) || null,
                code,
                name,
                managementType: asString(body.managementType) || 'CAPITAL_ASSET',
                defaultUsefulLifeYears: body.defaultUsefulLifeYears === undefined || body.defaultUsefulLifeYears === null || body.defaultUsefulLifeYears === ''
                    ? null : Number(body.defaultUsefulLifeYears),
                isActive: true,
                createdAt: nowIso(),
                updatedAt: nowIso(),
            };
            categories.push(category);
            await persistData(CATEGORIES_FILE, categories);
            await appendAudit({ action: 'ASSET_CATEGORY_CREATED', entityType: 'AssetCategory', entityId: category.id, req, detail: { code } });
            return res.status(201).json({ success: true, data: category });
        } catch (err) {
            console.error('[ASSET_CATEGORY_CREATE_ERROR]:', err.message);
            return res.status(500).json({ success: false, error: '분류 생성 중 오류가 발생했습니다.' });
        }
    });

    // ================= 공간 (계층 통합 파일) =================

    router.get('/spaces', (req, res) => {
        const kind = asString(req.query.kind);
        const parentId = asString(req.query.parentId);
        const includeInactive = req.query.includeInactive === 'true';
        let spaces = load(SPACES_FILE);
        if (!includeInactive) spaces = spaces.filter((s) => s.isActive);
        if (kind) {
            if (!SPACE_KINDS.includes(kind)) return res.status(400).json({ success: false, error: '유효하지 않은 공간 종류(kind)입니다.' });
            spaces = spaces.filter((s) => s.kind === kind);
        }
        if (parentId) spaces = spaces.filter((s) => s.parentId === parentId);
        spaces.sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0) || String(a.name).localeCompare(String(b.name)));
        return res.json({ success: true, data: spaces, total: spaces.length });
    });

    router.get('/spaces/:id', (req, res) => {
        const space = load(SPACES_FILE).find((s) => s.id === req.params.id && s.isActive);
        if (!space) return res.status(404).json({ success: false, error: '공간을 찾을 수 없습니다.' });
        return res.json({ success: true, data: space });
    });

    router.post('/spaces', requireAdmin, async (req, res) => {
        try {
            const body = req.body || {};
            const kind = asString(body.kind);
            const name = asString(body.name);
            const code = asString(body.code);
            if (!SPACE_KINDS.includes(kind)) return res.status(400).json({ success: false, error: '유효하지 않은 공간 종류(kind)입니다.' });
            if (!name) return res.status(400).json({ success: false, error: '공간명(name)은 필수입니다.' });
            if (!code) return res.status(400).json({ success: false, error: '공간 코드(code)는 필수입니다.' });
            const parentId = asString(body.parentId) || null;
            const spaces = load(SPACES_FILE);
            const expectedParentKind = SPACE_PARENT_KIND[kind];
            if (expectedParentKind === null) {
                if (parentId) return res.status(400).json({ success: false, error: '사업장(site)은 상위 공간을 가질 수 없습니다.' });
            } else {
                const parent = spaces.find((s) => s.id === parentId && s.kind === expectedParentKind && s.isActive);
                if (!parent) return res.status(400).json({ success: false, error: `상위 공간(${expectedParentKind})이 존재하지 않습니다.` });
            }
            if (spaces.some((s) => s.isActive && s.kind === kind && (s.parentId || null) === parentId && asString(s.code).toLowerCase() === code.toLowerCase())) {
                return res.status(409).json({ success: false, error: '동일 상위 공간에 이미 등록된 코드입니다.', code: 'SPACE_CODE_DUPLICATE' });
            }
            if (kind === 'floor') {
                const floorNumber = Number(body.floorNumber);
                if (!Number.isInteger(floorNumber)) return res.status(400).json({ success: false, error: '층(floorNumber)은 정수여야 합니다.' });
                if (spaces.some((s) => s.isActive && s.kind === 'floor' && s.parentId === parentId && s.floorNumber === floorNumber)) {
                    return res.status(409).json({ success: false, error: '동일 건물에 이미 등록된 층 번호입니다.', code: 'SPACE_FLOOR_DUPLICATE' });
                }
            }
            const space = {
                id: crypto.randomUUID(),
                kind,
                parentId,
                code,
                name,
                address: kind === 'site' ? (asString(body.address) || null) : null,
                floorNumber: kind === 'floor' ? Number(body.floorNumber) : null,
                roomNumber: kind === 'room' ? (asString(body.roomNumber) || code) : null,
                gridWidth: kind === 'room' ? (Number(body.gridWidth) || 60) : null,
                gridDepth: kind === 'room' ? (Number(body.gridDepth) || 40) : null,
                colorHex: kind === 'zone' ? (asString(body.colorHex) || '#3B82F6') : null,
                furnitureType: kind === 'furniture' ? (asString(body.furnitureType) || null) : null,
                zoneId: kind === 'furniture' ? (asString(body.zoneId) || null) : null,
                sortOrder: Number(body.sortOrder) || 0,
                isActive: true,
                createdAt: nowIso(),
                updatedAt: nowIso(),
            };
            if (space.zoneId) {
                const zone = spaces.find((s) => s.id === space.zoneId && s.kind === 'zone' && s.isActive);
                if (!zone || zone.parentId !== parentId) {
                    return res.status(400).json({ success: false, error: '가구의 구역(zoneId)이 해당 사무실에 속하지 않습니다.' });
                }
            }
            spaces.push(space);
            await persistData(SPACES_FILE, spaces);
            await appendAudit({ action: 'ASSET_SPACE_CREATED', entityType: 'AssetSpace', entityId: space.id, req, detail: { kind, code } });
            return res.status(201).json({ success: true, data: space });
        } catch (err) {
            console.error('[ASSET_SPACE_CREATE_ERROR]:', err.message);
            return res.status(500).json({ success: false, error: '공간 생성 중 오류가 발생했습니다.' });
        }
    });

    router.patch('/spaces/:id', requireAdmin, async (req, res) => {
        try {
            const spaces = load(SPACES_FILE);
            const space = spaces.find((s) => s.id === req.params.id && s.isActive);
            if (!space) return res.status(404).json({ success: false, error: '공간을 찾을 수 없습니다.' });
            const body = req.body || {};
            if (body.name !== undefined) space.name = asString(body.name) || space.name;
            if (body.sortOrder !== undefined) space.sortOrder = Number(body.sortOrder) || 0;
            if (body.address !== undefined && space.kind === 'site') space.address = asString(body.address) || null;
            if (body.colorHex !== undefined && space.kind === 'zone') space.colorHex = asString(body.colorHex) || space.colorHex;
            space.updatedAt = nowIso();
            await persistData(SPACES_FILE, spaces);
            await appendAudit({ action: 'ASSET_SPACE_UPDATED', entityType: 'AssetSpace', entityId: space.id, req, detail: { kind: space.kind, code: space.code } });
            return res.json({ success: true, data: space });
        } catch (err) {
            console.error('[ASSET_SPACE_UPDATE_ERROR]:', err.message);
            return res.status(500).json({ success: false, error: '공간 수정 중 오류가 발생했습니다.' });
        }
    });

    // 공간 소프트 삭제: 활성 하위 공간이 있으면 차단한다.
    router.delete('/spaces/:id', requireAdmin, async (req, res) => {
        try {
            const spaces = load(SPACES_FILE);
            const space = spaces.find((s) => s.id === req.params.id && s.isActive);
            if (!space) return res.status(404).json({ success: false, error: '공간을 찾을 수 없습니다.' });
            const hasActiveChild = spaces.some((s) => s.isActive && s.parentId === space.id);
            if (hasActiveChild) return res.status(409).json({ success: false, error: '활성 하위 공간이 있어 삭제할 수 없습니다.', code: 'SPACE_HAS_ACTIVE_CHILD' });
            space.isActive = false;
            space.updatedAt = nowIso();
            await persistData(SPACES_FILE, spaces);
            await appendAudit({ action: 'ASSET_SPACE_DELETED', entityType: 'AssetSpace', entityId: space.id, req, detail: { kind: space.kind, code: space.code } });
            return res.json({ success: true, data: { id: space.id, isActive: false } });
        } catch (err) {
            console.error('[ASSET_SPACE_DELETE_ERROR]:', err.message);
            return res.status(500).json({ success: false, error: '공간 삭제 중 오류가 발생했습니다.' });
        }
    });

    // ================= 감사로그 (읽기 전용 — 쓰기 라우트 없음) =================

    router.get('/audit-logs', requireAdmin, (req, res) => {
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
        const entityId = asString(req.query.entityId);
        // Stage 3 필터: category는 JSON 이식의 감사 행에 별도 카테고리 컬럼이 없어
        // entityType과 동일 값으로 매핑한다 (예: Asset / InventoryCheck / DataImport).
        const action = asString(req.query.action);
        const entityType = asString(req.query.entityType) || asString(req.query.category);
        const actorId = asString(req.query.actorId);
        let logs = load(AUDIT_FILE);
        if (entityId) logs = logs.filter((l) => l.entityId === entityId);
        if (action) logs = logs.filter((l) => l.action === action);
        if (entityType) logs = logs.filter((l) => l.entityType === entityType);
        if (actorId) logs = logs.filter((l) => l.actorId === actorId);
        logs.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
        const sliced = logs.slice(0, limit);
        // 감사로그에는 개인정보 성격의 값이 없으나, 응답은 관리자 전용으로 제한한다.
        return res.json({ success: true, data: sliced, total: logs.length });
    });

    // ================= Stage 2: 배치도 (FloorPlans / Versions / Objects — 분리 확정, M-8) =================
    // 분리 근거: 게시본 1개·아카이브·복원(복사본 초안 생성)을 버전 단위로 추적해야 하고,
    // 객체는 버전별로 고정되어야 복원 시 과거 배치를 그대로 재현할 수 있다.
    // 겹침·이탈 검사는 utils/assetIsometric.ts의 AABB 로직을 서버 JS 미러로 수행한다.
    // 초안 저장 시에는 검사를 차단하지 않고, 게시 시에만 400으로 차단한다.

    function serializeFloorPlan(plan) {
        const versions = load(FLOOR_PLAN_VERSIONS_FILE).filter((v) => v.floorPlanId === plan.id)
            .sort((a, b) => a.versionNumber - b.versionNumber);
        const objects = load(FLOOR_PLAN_OBJECTS_FILE);
        const spaces = load(SPACES_FILE);
        const room = spaces.find((s) => s.id === plan.roomId) || null;
        return {
            ...plan,
            roomName: room ? room.name : null,
            versions: versions.map((v) => ({
                ...v,
                objects: objects.filter((o) => o.versionId === v.id),
            })),
        };
    }

    function getDraftVersion(plan) {
        return load(FLOOR_PLAN_VERSIONS_FILE)
            .filter((v) => v.floorPlanId === plan.id && v.status === 'DRAFT')
            .sort((a, b) => b.versionNumber - a.versionNumber)[0] || null;
    }

    function validateDraftObjects(rawObjects, roomId) {
        if (rawObjects === undefined || rawObjects === null) return { ok: true, value: null };
        if (!Array.isArray(rawObjects)) return { ok: false, error: 'objects는 배열이어야 합니다.' };
        const spaces = load(SPACES_FILE);
        const assets = load(ASSETS_FILE);
        const seenIds = new Set();
        const normalized = [];
        for (const raw of rawObjects) {
            if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
                return { ok: false, error: '배치 객체는 객체여야 합니다.' };
            }
            const objectType = asString(raw.objectType) || 'FURNITURE';
            if (!FLOOR_PLAN_OBJECT_TYPES.includes(objectType)) {
                return { ok: false, error: `유효하지 않은 배치 객체 종류(objectType)입니다: ${objectType}` };
            }
            const coordX = Number(raw.coordX);
            const coordY = Number(raw.coordY);
            const widthCells = Number(raw.widthCells);
            const depthCells = Number(raw.depthCells);
            const zLayer = raw.zLayer === undefined || raw.zLayer === null || raw.zLayer === '' ? 0 : Number(raw.zLayer);
            const rotationDeg = raw.rotationDeg === undefined || raw.rotationDeg === null || raw.rotationDeg === '' ? 0 : Number(raw.rotationDeg);
            if (!Number.isInteger(coordX) || coordX < 0 || !Number.isInteger(coordY) || coordY < 0) {
                return { ok: false, error: '배치 좌표(coordX·coordY)는 0 이상의 정수여야 합니다.' };
            }
            if (!Number.isInteger(widthCells) || widthCells < 1 || !Number.isInteger(depthCells) || depthCells < 1) {
                return { ok: false, error: '배치 크기(widthCells·depthCells)는 1 이상의 정수여야 합니다.' };
            }
            if (!Number.isInteger(zLayer) || zLayer < 0) {
                return { ok: false, error: '층(zLayer)은 0 이상의 정수여야 합니다.' };
            }
            if (!FLOOR_PLAN_ROTATIONS.includes(rotationDeg)) {
                return { ok: false, error: '회전(rotationDeg)은 0·90·180·270 중 하나여야 합니다.' };
            }
            const furnitureId = asString(raw.furnitureId) || null;
            if (furnitureId) {
                const furniture = spaces.find((s) => s.id === furnitureId && s.kind === 'furniture' && s.isActive);
                if (!furniture) return { ok: false, error: '존재하지 않는 가구(furnitureId)입니다.' };
                if (roomId && furniture.parentId !== roomId) {
                    return { ok: false, error: '가구가 해당 사무실에 속하지 않습니다.' };
                }
            }
            const assetId = asString(raw.assetId) || null;
            if (assetId) {
                const asset = assets.find((a) => a.id === assetId && a.isActive);
                if (!asset) return { ok: false, error: '존재하지 않는 자산(assetId)입니다.' };
            }
            const id = asString(raw.id) || crypto.randomUUID();
            if (seenIds.has(id)) return { ok: false, error: '배치 객체 ID가 중복되었습니다.' };
            seenIds.add(id);
            normalized.push({
                id,
                objectType,
                furnitureId,
                assetId,
                zoneId: asString(raw.zoneId) || null,
                label: asString(raw.label) || null,
                coordX, coordY, widthCells, depthCells, zLayer, rotationDeg,
                colorHex: asString(raw.colorHex) || null,
            });
        }
        return { ok: true, value: normalized };
    }

    async function replaceVersionObjects(versionId, normalizedObjects) {
        const all = load(FLOOR_PLAN_OBJECTS_FILE).filter((o) => o.versionId !== versionId);
        for (const o of normalizedObjects) all.push({ ...o, versionId, createdAt: nowIso() });
        await persistData(FLOOR_PLAN_OBJECTS_FILE, all);
    }

    async function publishVersion(plan, version, req) {
        // persist 전에 모든 검증을 마친다. 실패 시 어떤 파일도 바뀌지 않는다.
        if (version.status !== 'DRAFT') {
            return { error: { status: 409, body: { success: false, error: '초안(DRAFT) 상태인 버전만 게시할 수 있습니다.', code: 'VERSION_NOT_DRAFT' } } };
        }
        const objects = load(FLOOR_PLAN_OBJECTS_FILE).filter((o) => o.versionId === version.id);
        const boxes = objects.map((o) => ({
            id: o.id, coordX: o.coordX, coordY: o.coordY,
            widthCells: o.widthCells, depthCells: o.depthCells,
            zLayer: o.zLayer, rotationDeg: o.rotationDeg,
        }));
        const check = validateFloorPlanLayout(version.gridWidth, version.gridDepth, boxes);
        const duplicates = findDuplicateFurnitureIds(objects);
        const spaces = load(SPACES_FILE);
        const room = spaces.find((s) => s.id === plan.roomId && s.isActive) || null;
        const gridMismatch = room && room.gridWidth !== null && room.gridDepth !== null
            && (version.gridWidth > room.gridWidth || version.gridDepth > room.gridDepth);
        if (!check.valid || duplicates.length > 0 || gridMismatch) {
            return { error: { status: 400, body: {
                success: false, error: '배치도 검증에 실패해 게시할 수 없습니다.', code: 'LAYOUT_INVALID',
                detail: { outOfBoundsIds: check.outOfBoundsIds, collisionPairs: check.collisionPairs, duplicateFurnitureIds: duplicates, gridMismatch: Boolean(gridMismatch) },
            } } };
        }
        const versions = load(FLOOR_PLAN_VERSIONS_FILE);
        const previous = versions.find((v) => v.floorPlanId === plan.id && v.status === 'PUBLISHED' && v.id !== version.id) || null;
        const nextVersions = versions.map((v) => {
            if (previous && v.id === previous.id) return { ...v, status: 'ARCHIVED' };
            if (v.id === version.id) return { ...v, status: 'PUBLISHED', publishedBy: req.auth ? req.auth.id : null, publishedAt: nowIso() };
            return v;
        });
        await persistData(FLOOR_PLAN_VERSIONS_FILE, nextVersions);
        const plans = load(FLOOR_PLANS_FILE);
        const updatedPlan = plans.map((p) => (p.id === plan.id
            ? { ...p, publishedVersionId: version.id, latestDraftVersionId: null, updatedAt: nowIso() } : p));
        await persistData(FLOOR_PLANS_FILE, updatedPlan);
        await appendAudit({ action: 'FLOOR_PLAN_PUBLISHED', entityType: 'FloorPlan', entityId: plan.id, req, detail: { versionId: version.id, versionNumber: version.versionNumber, previousArchivedId: previous ? previous.id : null, objectCount: objects.length } });
        return { published: { ...version, status: 'PUBLISHED' }, previousArchivedId: previous ? previous.id : null };
    }

    router.get('/floor-plans', (req, res) => {
        const roomId = asString(req.query.roomId);
        let plans = load(FLOOR_PLANS_FILE).filter((p) => p.isActive);
        if (roomId) plans = plans.filter((p) => p.roomId === roomId);
        return res.json({ success: true, data: plans.map(serializeFloorPlan), total: plans.length });
    });

    router.post('/floor-plans', requireAdmin, async (req, res) => {
        try {
            const body = req.body || {};
            const roomId = asString(body.roomId);
            if (!roomId) return res.status(400).json({ success: false, error: '사무실(roomId)은 필수입니다.' });
            const room = load(SPACES_FILE).find((s) => s.id === roomId && s.kind === 'room' && s.isActive);
            if (!room) return res.status(400).json({ success: false, error: '존재하지 않는 사무실(roomId)입니다.' });
            if (load(FLOOR_PLANS_FILE).some((p) => p.isActive && p.roomId === roomId)) {
                return res.status(409).json({ success: false, error: '해당 사무실에 이미 배치도가 있습니다.', code: 'FLOOR_PLAN_EXISTS' });
            }
            const plan = {
                id: crypto.randomUUID(),
                roomId,
                name: asString(body.name) || `${room.name} 배치도`,
                publishedVersionId: null,
                latestDraftVersionId: null,
                isActive: true,
                createdBy: req.auth ? req.auth.id : null,
                createdAt: nowIso(),
                updatedAt: nowIso(),
            };
            // 객체 검증은 persist 전에 마친다 (무효 객체로 계획이 남지 않게 한다).
            const objectCheck = validateDraftObjects(body.objects, roomId);
            if (!objectCheck.ok) return res.status(400).json({ success: false, error: objectCheck.error });
            const version = {
                id: crypto.randomUUID(),
                floorPlanId: plan.id,
                versionNumber: 1,
                status: 'DRAFT',
                gridWidth: room.gridWidth || 60,
                gridDepth: room.gridDepth || 40,
                changeSummary: asString(body.changeSummary) || null,
                createdBy: req.auth ? req.auth.id : null,
                publishedBy: null,
                publishedAt: null,
                createdAt: nowIso(),
            };
            plan.latestDraftVersionId = version.id;
            const plans = load(FLOOR_PLANS_FILE);
            plans.push(plan);
            await persistData(FLOOR_PLANS_FILE, plans);
            const versions = load(FLOOR_PLAN_VERSIONS_FILE);
            versions.push(version);
            await persistData(FLOOR_PLAN_VERSIONS_FILE, versions);
            if (objectCheck.value) await replaceVersionObjects(version.id, objectCheck.value);
            await appendAudit({ action: 'FLOOR_PLAN_CREATED', entityType: 'FloorPlan', entityId: plan.id, req, detail: { roomId } });
            return res.status(201).json({ success: true, data: serializeFloorPlan(plan) });
        } catch (err) {
            console.error('[FLOOR_PLAN_CREATE_ERROR]:', err.message);
            return res.status(500).json({ success: false, error: '배치도 생성 중 오류가 발생했습니다.' });
        }
    });

    router.get('/floor-plans/:id/published', (req, res) => {
        const plan = load(FLOOR_PLANS_FILE).find((p) => p.id === req.params.id && p.isActive);
        if (!plan) return res.status(404).json({ success: false, error: '배치도를 찾을 수 없습니다.' });
        if (!plan.publishedVersionId) return res.status(404).json({ success: false, error: '게시된 배치도 버전이 없습니다.' });
        const version = load(FLOOR_PLAN_VERSIONS_FILE).find((v) => v.id === plan.publishedVersionId) || null;
        if (!version) return res.status(404).json({ success: false, error: '게시된 배치도 버전을 찾을 수 없습니다.' });
        return res.json({ success: true, data: { ...version, objects: load(FLOOR_PLAN_OBJECTS_FILE).filter((o) => o.versionId === version.id) } });
    });

    router.get('/floor-plans/:id', (req, res) => {
        const plan = load(FLOOR_PLANS_FILE).find((p) => p.id === req.params.id && p.isActive);
        if (!plan) return res.status(404).json({ success: false, error: '배치도를 찾을 수 없습니다.' });
        return res.json({ success: true, data: serializeFloorPlan(plan) });
    });

    router.put('/floor-plans/:id/draft', requireAdmin, async (req, res) => {
        try {
            const plan = load(FLOOR_PLANS_FILE).find((p) => p.id === req.params.id && p.isActive);
            if (!plan) return res.status(404).json({ success: false, error: '배치도를 찾을 수 없습니다.' });
            const body = req.body || {};
            const objectCheck = validateDraftObjects(body.objects, plan.roomId);
            if (!objectCheck.ok) return res.status(400).json({ success: false, error: objectCheck.error });
            let version = getDraftVersion(plan);
            const versions = load(FLOOR_PLAN_VERSIONS_FILE);
            if (!version) {
                const maxNumber = versions.filter((v) => v.floorPlanId === plan.id)
                    .reduce((m, v) => Math.max(m, v.versionNumber || 0), 0);
                version = {
                    id: crypto.randomUUID(),
                    floorPlanId: plan.id,
                    versionNumber: maxNumber + 1,
                    status: 'DRAFT',
                    gridWidth: Number(body.gridWidth) || null,
                    gridDepth: Number(body.gridDepth) || null,
                    changeSummary: asString(body.changeSummary) || null,
                    createdBy: req.auth ? req.auth.id : null,
                    publishedBy: null,
                    publishedAt: null,
                    createdAt: nowIso(),
                };
                const room = load(SPACES_FILE).find((s) => s.id === plan.roomId) || null;
                if (!version.gridWidth) version.gridWidth = room ? (room.gridWidth || 60) : 60;
                if (!version.gridDepth) version.gridDepth = room ? (room.gridDepth || 40) : 40;
                versions.push(version);
                await persistData(FLOOR_PLAN_VERSIONS_FILE, versions);
            } else {
                // 기존 초안의 격자·요약만 갱신한다 (버전 번호는 유지).
                const nextVersions = versions.map((v) => (v.id === version.id ? {
                    ...v,
                    gridWidth: body.gridWidth !== undefined ? Number(body.gridWidth) : v.gridWidth,
                    gridDepth: body.gridDepth !== undefined ? Number(body.gridDepth) : v.gridDepth,
                    changeSummary: body.changeSummary !== undefined ? (asString(body.changeSummary) || null) : v.changeSummary,
                } : v));
                await persistData(FLOOR_PLAN_VERSIONS_FILE, nextVersions);
                version = nextVersions.find((v) => v.id === version.id);
            }
            if (objectCheck.value) await replaceVersionObjects(version.id, objectCheck.value);
            const plans = load(FLOOR_PLANS_FILE).map((p) => (p.id === plan.id
                ? { ...p, latestDraftVersionId: version.id, updatedAt: nowIso() } : p));
            await persistData(FLOOR_PLANS_FILE, plans);
            await appendAudit({ action: 'FLOOR_PLAN_DRAFT_SAVED', entityType: 'FloorPlan', entityId: plan.id, req, detail: { versionId: version.id, versionNumber: version.versionNumber } });
            return res.json({ success: true, data: serializeFloorPlan({ ...plan, latestDraftVersionId: version.id }) });
        } catch (err) {
            console.error('[FLOOR_PLAN_DRAFT_ERROR]:', err.message);
            return res.status(500).json({ success: false, error: '배치도 초안 저장 중 오류가 발생했습니다.' });
        }
    });

    router.post('/floor-plans/:id/publish', requireAdmin, async (req, res) => {
        try {
            const plan = load(FLOOR_PLANS_FILE).find((p) => p.id === req.params.id && p.isActive);
            if (!plan) return res.status(404).json({ success: false, error: '배치도를 찾을 수 없습니다.' });
            const versionId = asString((req.body || {}).versionId) || null;
            const version = versionId
                ? load(FLOOR_PLAN_VERSIONS_FILE).find((v) => v.id === versionId && v.floorPlanId === plan.id)
                : getDraftVersion(plan);
            if (!version) return res.status(404).json({ success: false, error: '게시할 초안 버전을 찾을 수 없습니다.' });
            const result = await publishVersion(plan, version, req);
            if (result.error) return res.status(result.error.status).json(result.error.body);
            return res.json({ success: true, data: { planId: plan.id, publishedVersionId: version.id, previousArchivedId: result.previousArchivedId } });
        } catch (err) {
            console.error('[FLOOR_PLAN_PUBLISH_ERROR]:', err.message);
            return res.status(500).json({ success: false, error: '배치도 게시 중 오류가 발생했습니다.' });
        }
    });

    router.post('/floor-plans/:id/versions/:versionId/publish', requireAdmin, async (req, res) => {
        try {
            const plan = load(FLOOR_PLANS_FILE).find((p) => p.id === req.params.id && p.isActive);
            if (!plan) return res.status(404).json({ success: false, error: '배치도를 찾을 수 없습니다.' });
            const version = load(FLOOR_PLAN_VERSIONS_FILE).find((v) => v.id === req.params.versionId && v.floorPlanId === plan.id);
            if (!version) return res.status(404).json({ success: false, error: '배치도 버전을 찾을 수 없습니다.' });
            const result = await publishVersion(plan, version, req);
            if (result.error) return res.status(result.error.status).json(result.error.body);
            return res.json({ success: true, data: { planId: plan.id, publishedVersionId: version.id, previousArchivedId: result.previousArchivedId } });
        } catch (err) {
            console.error('[FLOOR_PLAN_VERSION_PUBLISH_ERROR]:', err.message);
            return res.status(500).json({ success: false, error: '배치도 버전 게시 중 오류가 발생했습니다.' });
        }
    });

    // 복원: 아카이브(ARCHIVED) 버전을 그대로 다시 게시하지 않고, 그 배치·격자를 복사한
    // 새 초안(DRAFT)으로 되돌린다. 복원본은 편집·검증 후 게시 절차를 다시 밟는다.
    router.post('/floor-plans/:id/restore', requireAdmin, async (req, res) => {
        try {
            const plan = load(FLOOR_PLANS_FILE).find((p) => p.id === req.params.id && p.isActive);
            if (!plan) return res.status(404).json({ success: false, error: '배치도를 찾을 수 없습니다.' });
            const versionId = asString((req.body || {}).versionId) || null;
            const archived = load(FLOOR_PLAN_VERSIONS_FILE)
                .filter((v) => v.floorPlanId === plan.id && v.status === 'ARCHIVED')
                .sort((a, b) => b.versionNumber - a.versionNumber);
            const source = versionId ? archived.find((v) => v.id === versionId) : archived[0];
            if (!source) return res.status(404).json({ success: false, error: '복원할 아카이브 버전을 찾을 수 없습니다.' });
            const versions = load(FLOOR_PLAN_VERSIONS_FILE);
            const maxNumber = versions.filter((v) => v.floorPlanId === plan.id)
                .reduce((m, v) => Math.max(m, v.versionNumber || 0), 0);
            const draft = {
                id: crypto.randomUUID(),
                floorPlanId: plan.id,
                versionNumber: maxNumber + 1,
                status: 'DRAFT',
                gridWidth: source.gridWidth,
                gridDepth: source.gridDepth,
                changeSummary: `복원: v${source.versionNumber} 복사본`,
                createdBy: req.auth ? req.auth.id : null,
                publishedBy: null,
                publishedAt: null,
                createdAt: nowIso(),
            };
            versions.push(draft);
            await persistData(FLOOR_PLAN_VERSIONS_FILE, versions);
            const sourceObjects = load(FLOOR_PLAN_OBJECTS_FILE).filter((o) => o.versionId === source.id);
            await replaceVersionObjects(draft.id, sourceObjects.map((o) => ({ ...o, id: crypto.randomUUID() })));
            const plans = load(FLOOR_PLANS_FILE).map((p) => (p.id === plan.id
                ? { ...p, latestDraftVersionId: draft.id, updatedAt: nowIso() } : p));
            await persistData(FLOOR_PLANS_FILE, plans);
            await appendAudit({ action: 'FLOOR_PLAN_RESTORED', entityType: 'FloorPlan', entityId: plan.id, req, detail: { sourceVersionId: source.id, sourceVersionNumber: source.versionNumber, draftVersionId: draft.id, draftVersionNumber: draft.versionNumber } });
            return res.json({ success: true, data: serializeFloorPlan({ ...plan, latestDraftVersionId: draft.id }) });
        } catch (err) {
            console.error('[FLOOR_PLAN_RESTORE_ERROR]:', err.message);
            return res.status(500).json({ success: false, error: '배치도 복원 중 오류가 발생했습니다.' });
        }
    });

    router.delete('/floor-plans/:id', requireAdmin, async (req, res) => {
        try {
            const plans = load(FLOOR_PLANS_FILE);
            const plan = plans.find((p) => p.id === req.params.id && p.isActive);
            if (!plan) return res.status(404).json({ success: false, error: '배치도를 찾을 수 없습니다.' });
            plan.isActive = false;
            plan.updatedAt = nowIso();
            await persistData(FLOOR_PLANS_FILE, plans);
            await appendAudit({ action: 'FLOOR_PLAN_DELETED', entityType: 'FloorPlan', entityId: plan.id, req, detail: {} });
            return res.json({ success: true, data: { id: plan.id, isActive: false } });
        } catch (err) {
            console.error('[FLOOR_PLAN_DELETE_ERROR]:', err.message);
            return res.status(500).json({ success: false, error: '배치도 삭제 중 오류가 발생했습니다.' });
        }
    });

    // ================= Stage 2: QR (Asset_QrCodes) =================
    // 자산당 유효 QR 1개 (ACTIVE·DAMAGED_REPORTED)를 저장 전 코드 검사로 유지한다.
    // 재발급 시 기존 유효 QR은 전부 REVOKED로 남기고(replacedByQrId 연결), 새 QR을 만든다.
    // 공개 토큰은 내부 ID와 무관한 base64url 난수 24자이며, 자산 정보를 포함하지 않는다.

    function generateQrToken() {
        return crypto.randomBytes(18).toString('base64url');
    }

    function serializeQr(q) {
        // 인증 호출자에게도 토큰 자체는 공개 식별자이므로 포함한다 (시리얼·취득가는 이 파일에 없음).
        return { ...q };
    }

    async function issueQrForAsset(asset, req, reason) {
        const qrs = load(QR_CODES_FILE);
        const newId = crypto.randomUUID();
        let token = generateQrToken();
        for (let i = 0; i < 5; i++) {
            if (!qrs.some((q) => q.publicToken === token)) break;
            token = generateQrToken();
        }
        const maxVersion = qrs.filter((q) => q.assetId === asset.id)
            .reduce((m, q) => Math.max(m, q.tokenVersion || 0), 0);
        const revokedIds = [];
        const nextQrs = qrs.map((q) => {
            if (q.assetId === asset.id && (q.status === 'ACTIVE' || q.status === 'DAMAGED_REPORTED')) {
                revokedIds.push(q.id);
                return { ...q, status: 'REVOKED', revokedBy: req.auth ? req.auth.id : null, revokedAt: nowIso(), revokeReason: reason || 'REISSUE', replacedByQrId: newId };
            }
            return q;
        });
        const created = {
            id: newId,
            assetId: asset.id,
            publicToken: token,
            tokenVersion: maxVersion + 1,
            status: 'ACTIVE',
            issuedBy: req.auth ? req.auth.id : null,
            issuedAt: nowIso(),
            revokedBy: null,
            revokedAt: null,
            revokeReason: null,
            replacedByQrId: null,
        };
        nextQrs.push(created);
        await persistData(QR_CODES_FILE, nextQrs);
        await appendAudit({ action: reason === 'REISSUE' ? 'QR_REISSUED' : 'QR_ISSUED', entityType: 'QrCode', entityId: created.id, req, detail: { assetId: asset.id, assetNumber: asset.assetNumber, tokenVersion: created.tokenVersion, revokedCount: revokedIds.length } });
        return { created, revokedCount: revokedIds.length, revokedIds };
    }

    router.get('/assets/:id/qr-codes', (req, res) => {
        const asset = load(ASSETS_FILE).find((a) => a.id === req.params.id && a.isActive);
        if (!asset) return res.status(404).json({ success: false, error: '자산을 찾을 수 없습니다.' });
        if (!inTeamScope(req, asset)) return res.status(403).json({ success: false, error: '해당 팀 자산이 아닙니다.' });
        const qrs = load(QR_CODES_FILE).filter((q) => q.assetId === asset.id)
            .sort((a, b) => (b.tokenVersion || 0) - (a.tokenVersion || 0));
        return res.json({ success: true, data: qrs.map(serializeQr), total: qrs.length });
    });

    async function handleIssueQr(req, res, reason) {
        try {
            const asset = load(ASSETS_FILE).find((a) => a.id === req.params.id && a.isActive);
            if (!asset) return res.status(404).json({ success: false, error: '자산을 찾을 수 없습니다.' });
            const result = await issueQrForAsset(asset, req, reason);
            return res.status(201).json({ success: true, data: serializeQr(result.created), revokedCount: result.revokedCount });
        } catch (err) {
            console.error('[QR_ISSUE_ERROR]:', err.message);
            return res.status(500).json({ success: false, error: 'QR 발급 중 오류가 발생했습니다.' });
        }
    }

    router.post('/assets/:id/qr-codes', requireAdmin, (req, res) => handleIssueQr(req, res, 'ISSUE'));
    router.post('/assets/:id/qr-codes/reissue', requireAdmin, (req, res) => handleIssueQr(req, res, 'REISSUE'));

    // ================= Stage 2: 재물조사 (Plans / Targets / Checks) =================
    // 핵심 불변: 조사 제출은 Asset_Locations를 직접 바꾸지 않는다.
    // 관리자 승인 + followUpAction=UPDATE_OFFICIAL_LOCATION일 때만
    // Asset_Locations 갱신 + Asset_LocationHistory + Asset_AuditLogs를 기록한다.

    function hasAuditFlag(req) {
        const perms = req.auth ? req.auth.permissions : null;
        if (!perms) return false;
        if (Array.isArray(perms)) return perms.includes('ASSET_AUDIT_ACCESS');
        if (typeof perms === 'object') {
            const v = perms.ASSET_AUDIT_ACCESS;
            return v === true || v === 1 || v === 'true' || v === 'TRUE' || v === '1';
        }
        return false;
    }

    // M-4 전용 가드: 조사 제출만 허용한다. 이 가드를 통과했다고 해서
    // 자산·배치도·QR·승인 쓰기가 허용되는 것은 아니다 (그 라우트들은 requireAdmin/requireAssetWrite가 별도로 막는다).
    const requireInventorySubmit = (req, res, next) => {
        if (isAdmin(req) || isManager(req) || hasAuditFlag(req)) return next();
        return res.status(403).json({ success: false, error: '재물조사 제출 권한이 없습니다.' });
    };

    function serializeInventoryPlan(plan) {
        const targets = load(INVENTORY_TARGETS_FILE).filter((t) => t.planId === plan.id);
        const checks = load(INVENTORY_CHECKS_FILE).filter((c) => c.planId === plan.id);
        const assets = load(ASSETS_FILE);
        return {
            ...plan,
            progress: computeInventoryProgress(targets),
            targetCount: targets.length,
            targets: targets.map((t) => ({
                ...t,
                asset: assets.find((a) => a.id === t.assetId) || null,
                check: checks.find((c) => c.targetId === t.id) || null,
            })),
            checks,
        };
    }

    router.get('/inventory-plans', (req, res) => {
        let plans = load(INVENTORY_PLANS_FILE).filter((p) => p.isActive);
        if (!isAdmin(req) && req.auth.team) plans = plans.filter((p) => !p.team || p.team === req.auth.team);
        plans.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
        return res.json({ success: true, data: plans.map((p) => {
            const targets = load(INVENTORY_TARGETS_FILE).filter((t) => t.planId === p.id);
            return { ...p, progress: computeInventoryProgress(targets), targetCount: targets.length };
        }), total: plans.length });
    });

    router.post('/inventory-plans', requireAdmin, async (req, res) => {
        try {
            const body = req.body || {};
            const name = asString(body.name);
            if (!name) return res.status(400).json({ success: false, error: '조사 계획명(name)은 필수입니다.' });
            const roomId = asString(body.roomId) || null;
            if (roomId) {
                const room = load(SPACES_FILE).find((s) => s.id === roomId && s.kind === 'room' && s.isActive);
                if (!room) return res.status(400).json({ success: false, error: '존재하지 않는 사무실(roomId)입니다.' });
            }
            const assetIds = Array.isArray(body.assetIds) ? body.assetIds.map((v) => String(v)).filter(Boolean) : [];
            if (assetIds.length) {
                const assets = load(ASSETS_FILE);
                for (const id of assetIds) {
                    if (!assets.some((a) => a.id === id && a.isActive)) {
                        return res.status(400).json({ success: false, error: '존재하지 않는 자산(assetIds)이 포함되어 있습니다.' });
                    }
                }
            }
            const plan = {
                id: crypto.randomUUID(),
                name,
                roomId,
                team: asString(body.team) || null,
                assetIds,
                status: 'DRAFT',
                createdBy: req.auth ? req.auth.id : null,
                startedAt: null,
                completedAt: null,
                isActive: true,
                createdAt: nowIso(),
                updatedAt: nowIso(),
            };
            const plans = load(INVENTORY_PLANS_FILE);
            plans.push(plan);
            await persistData(INVENTORY_PLANS_FILE, plans);
            await appendAudit({ action: 'INVENTORY_PLAN_CREATED', entityType: 'InventoryPlan', entityId: plan.id, req, detail: { name } });
            return res.status(201).json({ success: true, data: plan });
        } catch (err) {
            console.error('[INVENTORY_PLAN_CREATE_ERROR]:', err.message);
            return res.status(500).json({ success: false, error: '조사 계획 생성 중 오류가 발생했습니다.' });
        }
    });

    router.get('/inventory-plans/:id/progress', (req, res) => {
        const plan = load(INVENTORY_PLANS_FILE).find((p) => p.id === req.params.id && p.isActive);
        if (!plan) return res.status(404).json({ success: false, error: '조사 계획을 찾을 수 없습니다.' });
        const targets = load(INVENTORY_TARGETS_FILE).filter((t) => t.planId === plan.id);
        const checks = load(INVENTORY_CHECKS_FILE).filter((c) => c.planId === plan.id);
        const counts = {};
        for (const t of targets) counts[t.status] = (counts[t.status] || 0) + 1;
        return res.json({ success: true, data: { planId: plan.id, status: plan.status, total: targets.length, progress: computeInventoryProgress(targets), counts, checkCount: checks.length } });
    });

    router.get('/inventory-plans/:id', (req, res) => {
        const plan = load(INVENTORY_PLANS_FILE).find((p) => p.id === req.params.id && p.isActive);
        if (!plan) return res.status(404).json({ success: false, error: '조사 계획을 찾을 수 없습니다.' });
        return res.json({ success: true, data: serializeInventoryPlan(plan) });
    });

    // 시작 시점에 대상 스냅샷을 고정한다. 시작 이후 공식 위치가 바뀌어도
    // 대상의 registeredLocation은 시작 시점 값 그대로 남는다.
    router.post('/inventory-plans/:id/start', requireAdmin, async (req, res) => {
        try {
            const plans = load(INVENTORY_PLANS_FILE);
            const plan = plans.find((p) => p.id === req.params.id && p.isActive);
            if (!plan) return res.status(404).json({ success: false, error: '조사 계획을 찾을 수 없습니다.' });
            if (plan.status !== 'DRAFT') {
                return res.status(409).json({ success: false, error: '초안(DRAFT) 상태인 계획만 시작할 수 있습니다.', code: 'PLAN_NOT_DRAFT' });
            }
            const assets = load(ASSETS_FILE).filter((a) => a.isActive);
            const locations = load(LOCATIONS_FILE);
            let selected = [];
            if (plan.assetIds && plan.assetIds.length) {
                selected = assets.filter((a) => plan.assetIds.includes(a.id));
            } else if (plan.roomId) {
                selected = assets.filter((a) => {
                    const loc = locations.find((l) => l.assetId === a.id);
                    return loc && loc.roomId === plan.roomId;
                });
            } else if (plan.team) {
                selected = assets.filter((a) => a.team === plan.team);
            } else {
                selected = assets;
            }
            if (!selected.length) {
                return res.status(400).json({ success: false, error: '조사 대상 자산이 없습니다.', code: 'PLAN_HAS_NO_TARGETS' });
            }
            const targets = load(INVENTORY_TARGETS_FILE);
            for (const asset of selected) {
                const loc = locations.find((l) => l.assetId === asset.id) || null;
                targets.push({
                    id: crypto.randomUUID(),
                    planId: plan.id,
                    assetId: asset.id,
                    registeredLocation: loc ? {
                        roomId: loc.roomId, zoneId: loc.zoneId, furnitureId: loc.furnitureId, shelfSlot: loc.shelfSlot,
                    } : { roomId: null, zoneId: null, furnitureId: null, shelfSlot: null },
                    status: 'UNCHECKED',
                    createdAt: nowIso(),
                });
            }
            await persistData(INVENTORY_TARGETS_FILE, targets);
            plan.status = 'IN_PROGRESS';
            plan.startedAt = nowIso();
            plan.updatedAt = nowIso();
            await persistData(INVENTORY_PLANS_FILE, plans);
            await appendAudit({ action: 'INVENTORY_PLAN_STARTED', entityType: 'InventoryPlan', entityId: plan.id, req, detail: { targetCount: selected.length } });
            return res.json({ success: true, data: serializeInventoryPlan(plan) });
        } catch (err) {
            console.error('[INVENTORY_PLAN_START_ERROR]:', err.message);
            return res.status(500).json({ success: false, error: '조사 계획 시작 중 오류가 발생했습니다.' });
        }
    });

    router.post('/inventory-plans/:id/complete', requireAdmin, async (req, res) => {
        try {
            const plans = load(INVENTORY_PLANS_FILE);
            const plan = plans.find((p) => p.id === req.params.id && p.isActive);
            if (!plan) return res.status(404).json({ success: false, error: '조사 계획을 찾을 수 없습니다.' });
            if (plan.status !== 'IN_PROGRESS') {
                return res.status(409).json({ success: false, error: '진행 중(IN_PROGRESS)인 계획만 완료할 수 있습니다.', code: 'PLAN_NOT_IN_PROGRESS' });
            }
            const unchecked = load(INVENTORY_TARGETS_FILE).filter((t) => t.planId === plan.id && t.status === 'UNCHECKED');
            if (unchecked.length) {
                return res.status(409).json({ success: false, error: '미조사 대상이 남아 있어 완료할 수 없습니다.', code: 'PLAN_HAS_UNCHECKED_TARGETS' });
            }
            plan.status = 'COMPLETED';
            plan.completedAt = nowIso();
            plan.updatedAt = nowIso();
            await persistData(INVENTORY_PLANS_FILE, plans);
            await appendAudit({ action: 'INVENTORY_PLAN_COMPLETED', entityType: 'InventoryPlan', entityId: plan.id, req, detail: {} });
            return res.json({ success: true, data: plan });
        } catch (err) {
            console.error('[INVENTORY_PLAN_COMPLETE_ERROR]:', err.message);
            return res.status(500).json({ success: false, error: '조사 계획 완료 중 오류가 발생했습니다.' });
        }
    });

    router.post('/inventory-plans/:id/cancel', requireAdmin, async (req, res) => {
        try {
            const plans = load(INVENTORY_PLANS_FILE);
            const plan = plans.find((p) => p.id === req.params.id && p.isActive);
            if (!plan) return res.status(404).json({ success: false, error: '조사 계획을 찾을 수 없습니다.' });
            if (plan.status !== 'DRAFT' && plan.status !== 'IN_PROGRESS') {
                return res.status(409).json({ success: false, error: '초안·진행 중인 계획만 취소할 수 있습니다.', code: 'PLAN_NOT_CANCELLABLE' });
            }
            plan.status = 'CANCELLED';
            plan.updatedAt = nowIso();
            await persistData(INVENTORY_PLANS_FILE, plans);
            await appendAudit({ action: 'INVENTORY_PLAN_CANCELLED', entityType: 'InventoryPlan', entityId: plan.id, req, detail: {} });
            return res.json({ success: true, data: plan });
        } catch (err) {
            console.error('[INVENTORY_PLAN_CANCEL_ERROR]:', err.message);
            return res.status(500).json({ success: false, error: '조사 계획 취소 중 오류가 발생했습니다.' });
        }
    });

    // 위치불일치 목록: 등록 위치와 다르게 보고된 체크만 모은다.
    router.get('/inventory/discrepancies', (req, res) => {
        const planId = asString(req.query.planId);
        let checks = load(INVENTORY_CHECKS_FILE);
        if (planId) checks = checks.filter((c) => c.planId === planId);
        const discrepancies = checks.filter((c) => !c.isLocationMatched
            || ['INFO_MISMATCH', 'DAMAGED', 'LOST_SUSPECTED', 'QR_DAMAGED', 'QR_MISATTACHED', 'DUPLICATE_SUSPECTED'].includes(c.resultStatus));
        return res.json({ success: true, data: discrepancies, total: discrepancies.length });
    });

    router.get('/inventory-checks', (req, res) => {
        const planId = asString(req.query.planId);
        const assetId = asString(req.query.assetId);
        let checks = load(INVENTORY_CHECKS_FILE);
        if (planId) checks = checks.filter((c) => c.planId === planId);
        if (assetId) checks = checks.filter((c) => c.assetId === assetId);
        return res.json({ success: true, data: checks, total: checks.length });
    });

    router.get('/inventory-checks/:id', (req, res) => {
        const check = load(INVENTORY_CHECKS_FILE).find((c) => c.id === req.params.id);
        if (!check) return res.status(404).json({ success: false, error: '조사 기록을 찾을 수 없습니다.' });
        return res.json({ success: true, data: check });
    });

    // 조사 제출 — 공식 위치를 바꾸지 않는다. 이 라우트에서는 Asset_Locations를
    // 읽지도 쓰지도 않으며, 실제 위치는 체크 행의 actual* 필드에만 저장한다.
    router.post('/inventory-checks', requireInventorySubmit, async (req, res) => {
        try {
            const body = req.body || {};
            const planId = asString(body.planId);
            const assetId = asString(body.assetId);
            if (!planId) return res.status(400).json({ success: false, error: '조사 계획(planId)은 필수입니다.' });
            if (!assetId) return res.status(400).json({ success: false, error: '자산(assetId)은 필수입니다.' });
            const plan = load(INVENTORY_PLANS_FILE).find((p) => p.id === planId && p.isActive);
            if (!plan) return res.status(404).json({ success: false, error: '조사 계획을 찾을 수 없습니다.' });
            if (plan.status !== 'IN_PROGRESS') {
                return res.status(409).json({ success: false, error: '진행 중(IN_PROGRESS)인 계획에만 조사할 수 있습니다.', code: 'PLAN_NOT_IN_PROGRESS' });
            }
            const target = load(INVENTORY_TARGETS_FILE).find((t) => t.planId === planId && t.assetId === assetId);
            if (!target) return res.status(404).json({ success: false, error: '해당 계획의 조사 대상이 아닙니다.' });
            const asset = load(ASSETS_FILE).find((a) => a.id === assetId && a.isActive);
            if (!asset) return res.status(404).json({ success: false, error: '자산을 찾을 수 없습니다.' });
            if (!isAdmin(req) && asset.team && asset.team !== req.auth.team) {
                return res.status(403).json({ success: false, error: '해당 팀 자산이 아닙니다.' });
            }
            const isLocationMatched = body.isLocationMatched === undefined ? true : Boolean(body.isLocationMatched);
            const resultStatus = asString(body.resultStatus) || 'NORMAL';
            if (!INVENTORY_RESULT_STATUSES.includes(resultStatus)) {
                return res.status(400).json({ success: false, error: '유효하지 않은 조사 결과(resultStatus)입니다.' });
            }
            const isQrScanned = Boolean(body.isQrScanned);
            const actualRoomId = asString(body.actualRoomId) || null;
            const actualZoneId = asString(body.actualZoneId) || null;
            const actualFurnitureId = asString(body.actualFurnitureId) || null;
            const memo = asString(body.memo) || null;
            const ruleCheck = validateInventorySubmissionRules({ isLocationMatched, resultStatus, isQrScanned, actualRoomId, memo });
            if (!ruleCheck.valid) return res.status(400).json({ success: false, error: ruleCheck.errors.join(' ') });
            const spaces = load(SPACES_FILE);
            if (actualRoomId && !spaces.some((s) => s.id === actualRoomId && s.kind === 'room' && s.isActive)) {
                return res.status(400).json({ success: false, error: '존재하지 않는 실제 사무실(actualRoomId)입니다.' });
            }
            if (actualZoneId) {
                const zone = spaces.find((s) => s.id === actualZoneId && s.kind === 'zone' && s.isActive);
                if (!zone) return res.status(400).json({ success: false, error: '존재하지 않는 실제 구역(actualZoneId)입니다.' });
                if (actualRoomId && zone.parentId !== actualRoomId) {
                    return res.status(400).json({ success: false, error: '실제 구역이 해당 사무실에 속하지 않습니다.' });
                }
            }
            if (actualFurnitureId) {
                const furniture = spaces.find((s) => s.id === actualFurnitureId && s.kind === 'furniture' && s.isActive);
                if (!furniture) return res.status(400).json({ success: false, error: '존재하지 않는 실제 가구(actualFurnitureId)입니다.' });
                if (actualRoomId && furniture.parentId !== actualRoomId) {
                    return res.status(400).json({ success: false, error: '실제 가구가 해당 사무실에 속하지 않습니다.' });
                }
            }
            const checks = load(INVENTORY_CHECKS_FILE);
            const existing = checks.find((c) => c.targetId === target.id);
            if (existing && existing.processStatus !== 'RECHECK_REQUESTED') {
                return res.status(409).json({ success: false, error: '이미 제출된 조사 기록입니다. 재조사 요청(RECHECK_REQUESTED) 상태일 때만 다시 제출할 수 있습니다.', code: 'CHECK_ALREADY_SUBMITTED' });
            }
            const now = nowIso();
            if (existing) {
                Object.assign(existing, {
                    isLocationMatched, resultStatus, isQrScanned, actualRoomId, actualZoneId, actualFurnitureId, memo,
                    approvalStatus: 'PENDING', followUpAction: null, processStatus: 'SUBMITTED',
                    submittedBy: req.auth ? req.auth.id : null, submittedAt: now,
                    reviewedBy: null, reviewedAt: null, reviewMemo: null,
                });
                await persistData(INVENTORY_CHECKS_FILE, checks);
                const targets = load(INVENTORY_TARGETS_FILE).map((t) => (t.id === target.id ? { ...t, status: 'SUBMITTED' } : t));
                await persistData(INVENTORY_TARGETS_FILE, targets);
                await appendAudit({ action: 'INVENTORY_CHECK_RESUBMITTED', entityType: 'InventoryCheck', entityId: existing.id, req, detail: { planId, assetId, resultStatus } });
                return res.json({ success: true, data: existing });
            }
            const check = {
                id: crypto.randomUUID(),
                planId,
                targetId: target.id,
                assetId,
                isLocationMatched,
                resultStatus,
                isQrScanned,
                actualRoomId,
                actualZoneId,
                actualFurnitureId,
                memo,
                approvalStatus: 'PENDING',
                followUpAction: null,
                processStatus: 'SUBMITTED',
                submittedBy: req.auth ? req.auth.id : null,
                submittedAt: now,
                reviewedBy: null,
                reviewedAt: null,
                reviewMemo: null,
            };
            checks.push(check);
            await persistData(INVENTORY_CHECKS_FILE, checks);
            const targets = load(INVENTORY_TARGETS_FILE).map((t) => (t.id === target.id ? { ...t, status: 'SUBMITTED' } : t));
            await persistData(INVENTORY_TARGETS_FILE, targets);
            await appendAudit({ action: 'INVENTORY_CHECK_SUBMITTED', entityType: 'InventoryCheck', entityId: check.id, req, detail: { planId, assetId, resultStatus, isLocationMatched } });
            return res.status(201).json({ success: true, data: check });
        } catch (err) {
            console.error('[INVENTORY_CHECK_SUBMIT_ERROR]:', err.message);
            return res.status(500).json({ success: false, error: '조사 제출 중 오류가 발생했습니다.' });
        }
    });

    // 검토·승인 — admin 전용. 공식 위치 변경은 APPROVE + UPDATE_OFFICIAL_LOCATION일 때만,
    // persist 전에 모든 검증을 마친 뒤 applyLocation(위치+이력) → 체크·대상 갱신 → 감사로그 순으로 수행한다.
    router.post('/inventory-checks/:id/review', requireAdmin, async (req, res) => {
        try {
            const checks = load(INVENTORY_CHECKS_FILE);
            const check = checks.find((c) => c.id === req.params.id);
            if (!check) return res.status(404).json({ success: false, error: '조사 기록을 찾을 수 없습니다.' });
            if (check.approvalStatus !== 'PENDING') {
                return res.status(409).json({ success: false, error: '이미 검토된 조사 기록입니다.', code: 'CHECK_ALREADY_REVIEWED' });
            }
            const decision = normalizeReviewDecision(asString((req.body || {}).decision));
            if (!decision) return res.status(400).json({ success: false, error: '검토 결정(decision)은 APPROVE·REJECT·RECHECK_REQUESTED 중 하나여야 합니다.' });
            const followUpAction = asString((req.body || {}).followUpAction) || 'NONE';
            if (!FOLLOW_UP_ACTIONS.includes(followUpAction)) {
                return res.status(400).json({ success: false, error: '유효하지 않은 후속 조치(followUpAction)입니다.' });
            }
            const reviewMemo = asString((req.body || {}).reviewMemo) || null;
            const applyLocationUpdate = canApplyOfficialLocationUpdate(decision, followUpAction);
            let locationValue = null;
            if (applyLocationUpdate) {
                if (!check.actualRoomId) {
                    return res.status(400).json({ success: false, error: '공식 위치 갱신에는 실제 사무실(actualRoomId)이 필요합니다.' });
                }
                const spaces = load(SPACES_FILE);
                if (!spaces.some((s) => s.id === check.actualRoomId && s.kind === 'room' && s.isActive)) {
                    return res.status(400).json({ success: false, error: '존재하지 않는 실제 사무실(actualRoomId)입니다.' });
                }
                if (check.actualZoneId) {
                    const zone = spaces.find((s) => s.id === check.actualZoneId && s.kind === 'zone' && s.isActive);
                    if (!zone || (check.actualRoomId && zone.parentId !== check.actualRoomId)) {
                        return res.status(400).json({ success: false, error: '실제 구역이 해당 사무실에 속하지 않습니다.' });
                    }
                }
                if (check.actualFurnitureId) {
                    const furniture = spaces.find((s) => s.id === check.actualFurnitureId && s.kind === 'furniture' && s.isActive);
                    if (!furniture || (check.actualRoomId && furniture.parentId !== check.actualRoomId)) {
                        return res.status(400).json({ success: false, error: '실제 가구가 해당 사무실에 속하지 않습니다.' });
                    }
                }
                const currentLocation = load(LOCATIONS_FILE).find((l) => l.assetId === check.assetId) || null;
                locationValue = {
                    roomId: check.actualRoomId,
                    zoneId: check.actualZoneId,
                    furnitureId: check.actualFurnitureId,
                    shelfSlot: currentLocation ? currentLocation.shelfSlot : null,
                    note: currentLocation ? currentLocation.note : null,
                };
            }
            // 검증 완료 후에만 쓰기를 시작한다.
            if (applyLocationUpdate) {
                await applyLocation(check.assetId, locationValue, req, 'INVENTORY_APPROVED');
            }
            const processStatus = decision === 'APPROVE'
                ? (applyLocationUpdate ? 'ACTION_COMPLETED' : 'APPROVED')
                : (decision === 'REJECT' ? 'REJECTED' : 'RECHECK_REQUESTED');
            const approvalStatus = decision === 'APPROVE' ? 'APPROVED' : (decision === 'REJECT' ? 'REJECTED' : 'RECHECK_REQUESTED');
            Object.assign(check, {
                approvalStatus, followUpAction, processStatus,
                reviewedBy: req.auth ? req.auth.id : null, reviewedAt: nowIso(), reviewMemo,
            });
            await persistData(INVENTORY_CHECKS_FILE, checks);
            const targets = load(INVENTORY_TARGETS_FILE).map((t) => (t.id === check.targetId ? { ...t, status: processStatus } : t));
            await persistData(INVENTORY_TARGETS_FILE, targets);
            // Stage 3: 승인(APPROVE)은 위치 확인 시각을 갱신한다. 대시보드 365일 미확인
            // 지표의 기준이 되며, 원본 lastVerifiedAt 규칙의 JSON 대응이다.
            // 위치 행이 없을 때(위치 미지정 자산)는 행을 새로 만들지 않고 미확인으로 둔다.
            if (decision === 'APPROVE') {
                const locations = load(LOCATIONS_FILE);
                const loc = locations.find((l) => l.assetId === check.assetId);
                if (loc) {
                    loc.lastVerifiedAt = nowIso();
                    await persistData(LOCATIONS_FILE, locations);
                }
            }
            await appendAudit({ action: 'INVENTORY_CHECK_REVIEWED', entityType: 'InventoryCheck', entityId: check.id, req, detail: { planId: check.planId, assetId: check.assetId, decision, followUpAction, locationUpdated: applyLocationUpdate } });
            if (applyLocationUpdate) {
                await appendAudit({ action: 'INVENTORY_LOCATION_UPDATED', entityType: 'AssetLocation', entityId: check.assetId, req, detail: { planId: check.planId, roomId: locationValue.roomId } });
            }
            return res.json({ success: true, data: check });
        } catch (err) {
            console.error('[INVENTORY_CHECK_REVIEW_ERROR]:', err.message);
            return res.status(500).json({ success: false, error: '조사 검토 중 오류가 발생했습니다.' });
        }
    });

    // ================= Stage 3: 엑셀/JSON 가져오기·롤백·내보내기·대시보드·관리자 플래그 =================
    // 원본(fullstack Stage 3) 규칙을 JSON 저장에 맞게 옮긴 것이다. 의도적 차이점은
    // STAGE3_CHECK.md에 명시한다. 핵심만 적으면:
    // - 가져오기: 검증·미리보기 → 커밋 → 롤백. 커밋 가능 행은 VALID·WARNING만, ERROR 행은 SKIPPED.
    // - 롤백: 신규 삽입은 물리 삭제 없이 소프트 삭제(+QR 폐기), 수정은 반영 전 스냅샷 복원, 재롤백 409.
    // - 수식 주입 방어: utils/assetExcelSanitizer.ts의 서버 미러(server/assets/assetExcelSanitizer.js)를
    //   가져오기 검증(경고+중화)과 내보내기(텍스트 셀 중화, 숫자 셀은 숫자 유지)에 연결한다.
    // - XLSX 업로드는 multipart가 아니라 JSON 본문의 base64로 받는다. 신규 multipart 의존성
    //   (multer 등)을 추가하지 않기 위함이며, xlsx 파싱·생성은 이미 의존성에 있는 xlsx를 쓴다.
    // - 감사로그에 대한 쓰기·수정·삭제 API는 만들지 않는다. 아래는 조회·필터 확장(기존 라우트)과
    //   IMPORT_*/DATA_EXPORTED 감사 기록뿐이다.
    const MAX_IMPORT_ROWS = 1000;
    const MAX_XLSX_BYTES = 10 * 1024 * 1024;
    const STALE_DAYS = 365;
    const DISCREPANCY_RESULT_STATUSES = ['INFO_MISMATCH', 'DAMAGED', 'LOST_SUSPECTED', 'QR_DAMAGED', 'QR_MISATTACHED', 'DUPLICATE_SUSPECTED'];

    function normalizeSerial(value) {
        const text = asString(value);
        if (!text) return null;
        return text.replace(/[\s-]+/g, '').toUpperCase();
    }

    /** 원본 import-validate.ts의 JSON 미러. 부서 코드 검증은 제외한다: JSON 이식에는
     *  부서 마스터가 없고 departmentCode를 팀 문자열 그대로 저장하기 때문이다 (Stage 1 팀 문자열 결정). */
    function validateImportRows(rawRows, opts) {
        // 원본 import-validate.ts의 asText와 동일: 숫자를 포함한 모든 값을 문자열로 받는다.
        // (라우터 공용 asString은 문자열 외 값을 빈 값으로 버리므로 가져오기 검증에는 쓰지 않는다.)
        const importText = (v) => (v === null || v === undefined ? '' : String(v).trim());
        const seenNumbers = new Map();
        const seenSerials = new Map();
        return rawRows.map((row, idx) => {
            const rowNumber = idx + 1;
            const codes = [];
            const messages = [];
            const err = (code, msg) => { codes.push(code); messages.push(msg); };
            const assetNumber = importText(row.assetNumber);
            const name = importText(row.name);
            const categoryCode = importText(row.categoryCode);
            const manufacturer = importText(row.manufacturer) || null;
            const modelName = importText(row.modelName) || null;
            const serialNumber = (() => { const t = importText(row.serialNumber); return t ? t.replace(/[\s-]+/g, '').toUpperCase() : null; })();
            const departmentCode = importText(row.departmentCode) || null;
            const operationalStatus = importText(row.operationalStatus) || 'IN_USE';
            if (!assetNumber) err('MISSING_ASSET_NUMBER', '자산번호가 비어 있습니다.');
            if (!name) err('MISSING_NAME', '품명이 비어 있습니다.');
            if (!categoryCode) err('MISSING_CATEGORY_CODE', '분류코드가 비어 있습니다.');
            else if (!opts.categoryByCode.has(categoryCode)) err('UNKNOWN_CATEGORY', `존재하지 않는 분류코드입니다: ${categoryCode}`);
            if (!OPERATIONAL_STATUSES.includes(operationalStatus)) err('INVALID_OPERATIONAL_STATUS', `잘못된 운영 상태입니다: ${operationalStatus}`);
            if (assetNumber) {
                const prev = seenNumbers.get(assetNumber);
                if (prev !== undefined) err('DUPLICATE_IN_FILE', `파일 내 ${prev}행과 자산번호가 중복됩니다.`);
                else seenNumbers.set(assetNumber, rowNumber);
                const dbAsset = opts.dbAssetNumbers.get(assetNumber);
                if (dbAsset && opts.mode === 'INSERT_ONLY') err('DUPLICATE_IN_DB', '이미 등록된 자산번호입니다 (INSERT_ONLY 모드).');
            }
            if (serialNumber) {
                const prev = seenSerials.get(serialNumber);
                if (prev !== undefined) err('DUPLICATE_SERIAL_IN_FILE', `파일 내 ${prev}행과 시리얼(정규화 후)이 중복됩니다.`);
                else seenSerials.set(serialNumber, rowNumber);
                const dbOwnerId = opts.dbSerials.get(serialNumber);
                const sameAsset = dbOwnerId && assetNumber && opts.dbAssetNumbers.get(assetNumber) && opts.dbAssetNumbers.get(assetNumber).id === dbOwnerId;
                if (dbOwnerId && !sameAsset) err('DUPLICATE_SERIAL_IN_DB', '이미 다른 자산에 등록된 시리얼입니다 (정규화 후 비교).');
            }
            let warned = false;
            for (const v of [row.assetNumber, row.name, row.categoryCode, row.manufacturer, row.modelName, row.serialNumber, row.departmentCode]) {
                if (containsFormulaInjectionRisk(v)) { warned = true; break; }
            }
            if (warned) {
                codes.push('FORMULA_CELL_DETECTED');
                messages.push('수식 주입 위험 셀을 감지해 중화 처리했습니다 (앞에 작은따옴표 추가).');
            }
            const hasError = codes.some((c) => c !== 'FORMULA_CELL_DETECTED');
            const validationStatus = hasError ? 'ERROR' : (warned ? 'WARNING' : 'VALID');
            const normalized = hasError ? null : {
                assetNumber: sanitizeExcelCell(assetNumber),
                name: sanitizeExcelCell(name),
                categoryCode: sanitizeExcelCell(categoryCode),
                manufacturer: manufacturer === null ? null : sanitizeExcelCell(manufacturer),
                modelName: modelName === null ? null : sanitizeExcelCell(modelName),
                serialNumber,
                departmentCode: departmentCode === null ? null : sanitizeExcelCell(departmentCode),
                operationalStatus,
            };
            return {
                rowNumber,
                raw: (row && typeof row === 'object' && !Array.isArray(row)) ? row : {},
                normalized,
                validationStatus,
                errorCodes: codes,
                errorMessages: messages,
                isUpdate: Boolean(assetNumber && opts.dbAssetNumbers.get(assetNumber) && opts.mode === 'UPSERT'),
            };
        });
    }

    function buildValidatedRows(rawRows, mode) {
        const categories = load(CATEGORIES_FILE).filter((c) => c.isActive);
        const categoryByCode = new Map(categories.map((c) => [c.code, c]));
        const assets = load(ASSETS_FILE).filter((a) => a.isActive);
        const dbAssetNumbers = new Map(assets.map((a) => [a.assetNumber, a]));
        const dbSerials = new Map();
        for (const a of assets) {
            const s = normalizeSerial(a.serialNumber);
            if (s && !dbSerials.has(s)) dbSerials.set(s, a.id);
        }
        return { validated: validateImportRows(rawRows, { mode, categoryByCode, dbAssetNumbers, dbSerials }), categoryByCode };
    }

    async function createImportJob(req, { filename, fileSha256, importMode, autoIssueQr, rawRows, validated }) {
        const job = {
            id: crypto.randomUUID(),
            filename,
            fileSha256,
            importMode,
            autoIssueQr,
            status: 'VALIDATED',
            totalRows: validated.length,
            validRows: validated.filter((r) => r.validationStatus === 'VALID' || r.validationStatus === 'WARNING').length,
            errorRows: validated.filter((r) => r.validationStatus === 'ERROR').length,
            committedRows: 0,
            createdBy: req.auth ? req.auth.id : null,
            createdAt: nowIso(),
            committedAt: null,
            rolledBackAt: null,
        };
        const jobs = load(IMPORTS_FILE);
        jobs.push(job);
        await persistData(IMPORTS_FILE, jobs);
        const rows = validated.map((r) => ({
            id: crypto.randomUUID(),
            jobId: job.id,
            rowNumber: r.rowNumber,
            rawDataJson: r.raw,
            normalizedDataJson: r.normalized,
            validationStatus: r.validationStatus,
            errorCodes: r.errorCodes,
            errorMessages: r.errorMessages,
            actionTaken: null,
            targetAssetId: null,
            beforeAssetSnapshot: null,
        }));
        const allRows = load(IMPORT_ROWS_FILE);
        allRows.push(...rows);
        await persistData(IMPORT_ROWS_FILE, allRows);
        return { job, rows };
    }

    function serializeImportJob(job) { return { ...job }; }
    function serializeImportRow(row) {
        const { beforeAssetSnapshot, ...rest } = row;
        return { ...rest, hasBeforeSnapshot: beforeAssetSnapshot !== null && beforeAssetSnapshot !== undefined };
    }

    // JSON 행 배열 가져오기 검증 (관리자 전용). 커밋 전에는 원장에 아무것도 쓰지 않는다.
    router.post('/imports', requireAdmin, async (req, res) => {
        try {
            const body = req.body || {};
            const rawRows = body.rows;
            if (!Array.isArray(rawRows) || rawRows.length === 0) {
                return res.status(400).json({ success: false, error: '가져올 행(rows 배열)이 필요합니다.' });
            }
            if (rawRows.length > MAX_IMPORT_ROWS) {
                return res.status(400).json({ success: false, error: `가져오기는 최대 ${MAX_IMPORT_ROWS}행까지 가능합니다.`, code: 'IMPORT_TOO_MANY_ROWS' });
            }
            const importMode = asString(body.importMode) || 'INSERT_ONLY';
            if (importMode !== 'INSERT_ONLY' && importMode !== 'UPSERT') {
                return res.status(400).json({ success: false, error: 'importMode는 INSERT_ONLY 또는 UPSERT여야 합니다.' });
            }
            const autoIssueQr = body.autoIssueQr === undefined ? true : Boolean(body.autoIssueQr);
            const { validated } = buildValidatedRows(rawRows, importMode);
            const fileSha256 = crypto.createHash('sha256').update(JSON.stringify(rawRows)).digest('hex');
            const { job } = await createImportJob(req, {
                filename: asString(body.filename) || 'import.json',
                fileSha256, importMode, autoIssueQr, rawRows, validated,
            });
            await appendAudit({ action: 'IMPORT_UPLOADED', entityType: 'DataImport', entityId: job.id, req, detail: { filename: job.filename, importMode, totalRows: job.totalRows, validRows: job.validRows, errorRows: job.errorRows } });
            return res.status(201).json({ success: true, data: serializeImportJob(job) });
        } catch (err) {
            console.error('[ASSET_IMPORT_UPLOAD_ERROR]:', err.message);
            return res.status(500).json({ success: false, error: '가져오기 검증 중 오류가 발생했습니다.' });
        }
    });

    // XLSX 가져오기 검증 (관리자 전용). multipart 대신 JSON 본문의 base64를 받는다.
    // 첫 워크시트만 읽고, 영문·한글 헤더를 매핑한다. 수식 셀은 계산 결과값만 쓰고
    // FORMULA_CELL_DETECTED 경고를 남긴다.
    router.post('/imports/xlsx', requireAdmin, async (req, res) => {
        try {
            const body = req.body || {};
            const fileBase64 = asString(body.fileBase64);
            if (!fileBase64) return res.status(400).json({ success: false, error: 'fileBase64(XLSX 파일의 base64)가 필요합니다.' });
            const buffer = Buffer.from(fileBase64, 'base64');
            if (buffer.length === 0) return res.status(400).json({ success: false, error: '빈 파일입니다.' });
            if (buffer.length > MAX_XLSX_BYTES) {
                return res.status(400).json({ success: false, error: 'XLSX 파일은 최대 10MB까지 가능합니다.', code: 'XLSX_TOO_LARGE' });
            }
            const importMode = asString(body.importMode) || 'INSERT_ONLY';
            if (importMode !== 'INSERT_ONLY' && importMode !== 'UPSERT') {
                return res.status(400).json({ success: false, error: 'importMode는 INSERT_ONLY 또는 UPSERT여야 합니다.' });
            }
            const autoIssueQr = body.autoIssueQr === undefined ? true : Boolean(body.autoIssueQr);
            let workbook;
            try {
                workbook = XLSX.read(buffer, { type: 'buffer' });
            } catch (e) {
                return res.status(400).json({ success: false, error: 'XLSX 파일을 읽을 수 없습니다.' });
            }
            const sheetName = workbook.SheetNames && workbook.SheetNames[0];
            if (!sheetName) return res.status(400).json({ success: false, error: '워크시트가 없습니다.' });
            const ws = workbook.Sheets[sheetName];
            const grid = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: true });
            if (!grid.length) return res.status(400).json({ success: false, error: '빈 워크시트입니다.' });
            const HEADER_MAP = {
                assetNumber: 'assetNumber', '자산번호': 'assetNumber',
                name: 'name', '품명': 'name',
                categoryCode: 'categoryCode', '분류코드': 'categoryCode',
                manufacturer: 'manufacturer', '제조사': 'manufacturer',
                modelName: 'modelName', '모델명': 'modelName',
                serialNumber: 'serialNumber', '시리얼': 'serialNumber', '시리얼번호': 'serialNumber',
                departmentCode: 'departmentCode', '부서코드': 'departmentCode', '팀': 'departmentCode',
                operationalStatus: 'operationalStatus', '운영상태': 'operationalStatus',
            };
            const headers = grid[0].map((h) => HEADER_MAP[String(h).trim()] || null);
            // 수식 셀(.f)이 있는 시트 행 번호(1-based)를 수집한다.
            const formulaRows = new Set();
            for (const ref of Object.keys(ws)) {
                if (ref.startsWith('!')) continue;
                const cell = ws[ref];
                if (cell && cell.f) {
                    try { formulaRows.add(XLSX.utils.decode_cell(ref).r + 1); } catch (ignore) {}
                }
            }
            const rawRows = [];
            const rawRowNumbers = [];
            for (let i = 1; i < grid.length; i++) {
                const values = grid[i];
                if (values.every((v) => v === '' || v === null || v === undefined)) continue;
                const row = {};
                headers.forEach((key, col) => {
                    if (key) {
                        const v = values[col];
                        // 셀 값이 숫자(수식 계산 결과 등)여도 문자열로 받아 검증한다.
                        row[key] = (v === '' || v === null || v === undefined) ? '' : String(v);
                    }
                });
                rawRows.push(row);
                rawRowNumbers.push(i + 1);
            }
            if (!rawRows.length) return res.status(400).json({ success: false, error: '가져올 데이터 행이 없습니다.' });
            if (rawRows.length > MAX_IMPORT_ROWS) {
                return res.status(400).json({ success: false, error: `가져오기는 최대 ${MAX_IMPORT_ROWS}행까지 가능합니다.`, code: 'IMPORT_TOO_MANY_ROWS' });
            }
            const { validated } = buildValidatedRows(rawRows, importMode);
            validated.forEach((r, idx) => {
                if (formulaRows.has(rawRowNumbers[idx])) {
                    if (!r.errorCodes.includes('FORMULA_CELL_DETECTED')) {
                        r.errorCodes.push('FORMULA_CELL_DETECTED');
                        r.errorMessages.push('수식 셀을 감지했습니다. 계산 결과값을 사용했습니다.');
                    }
                    if (r.validationStatus === 'VALID') r.validationStatus = 'WARNING';
                }
            });
            const fileSha256 = crypto.createHash('sha256').update(buffer).digest('hex');
            const { job } = await createImportJob(req, {
                filename: asString(body.filename) || 'import.xlsx',
                fileSha256, importMode, autoIssueQr, rawRows, validated,
            });
            await appendAudit({ action: 'IMPORT_UPLOADED', entityType: 'DataImport', entityId: job.id, req, detail: { filename: job.filename, importMode, sheetName, totalRows: job.totalRows, validRows: job.validRows, errorRows: job.errorRows } });
            return res.status(201).json({ success: true, data: serializeImportJob(job) });
        } catch (err) {
            console.error('[ASSET_IMPORT_XLSX_ERROR]:', err.message);
            return res.status(500).json({ success: false, error: 'XLSX 가져오기 검증 중 오류가 발생했습니다.' });
        }
    });

    router.get('/imports', requireAdmin, (req, res) => {
        const jobs = load(IMPORTS_FILE);
        jobs.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
        const sliced = jobs.slice(0, 100);
        return res.json({ success: true, data: sliced.map(serializeImportJob), total: jobs.length });
    });

    router.get('/imports/:id', requireAdmin, (req, res) => {
        const job = load(IMPORTS_FILE).find((j) => j.id === req.params.id);
        if (!job) return res.status(404).json({ success: false, error: '가져오기 작업을 찾을 수 없습니다.' });
        const statusFilter = asString(req.query.validationStatus);
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
        const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
        let rows = load(IMPORT_ROWS_FILE).filter((r) => r.jobId === job.id);
        if (statusFilter) rows = rows.filter((r) => r.validationStatus === statusFilter);
        rows.sort((a, b) => a.rowNumber - b.rowNumber);
        const total = rows.length;
        return res.json({ success: true, data: { job: serializeImportJob(job), rows: rows.slice(offset, offset + limit).map(serializeImportRow), total } });
    });

    // 커밋: VALID·WARNING 행만 원장 반영, ERROR 행은 SKIPPED. 재커밋 409.
    // 커밋 직전 중복을 재검사해 충돌이 있으면 아무것도 쓰지 않고 409로 남긴다
    // (업로드 이후 원장이 바뀐 경우, 미리보기가 동결된다는 원본 규칙과 같은 취지).
    router.post('/imports/:id/commit', requireAdmin, async (req, res) => {
        try {
            const jobs = load(IMPORTS_FILE);
            const job = jobs.find((j) => j.id === req.params.id);
            if (!job) return res.status(404).json({ success: false, error: '가져오기 작업을 찾을 수 없습니다.' });
            if (job.status === 'COMMITTED') return res.status(409).json({ success: false, error: '이미 커밋된 작업입니다.', code: 'IMPORT_ALREADY_COMMITTED' });
            if (job.status === 'ROLLED_BACK') return res.status(409).json({ success: false, error: '이미 롤백된 작업입니다.', code: 'IMPORT_ALREADY_ROLLED_BACK' });
            if (job.status !== 'VALIDATED') return res.status(409).json({ success: false, error: '커밋할 수 없는 작업 상태입니다.', code: 'IMPORT_NOT_VALIDATED' });
            const rows = load(IMPORT_ROWS_FILE).filter((r) => r.jobId === job.id).sort((a, b) => a.rowNumber - b.rowNumber);
            const committable = rows.filter((r) => r.validationStatus === 'VALID' || r.validationStatus === 'WARNING');
            // 커밋 직전 재검사
            const currentAssets = load(ASSETS_FILE).filter((a) => a.isActive);
            const currentByNumber = new Map(currentAssets.map((a) => [a.assetNumber, a]));
            const currentSerials = new Map();
            for (const a of currentAssets) {
                const s = normalizeSerial(a.serialNumber);
                if (s && !currentSerials.has(s)) currentSerials.set(s, a.id);
            }
            const categories = load(CATEGORIES_FILE).filter((c) => c.isActive);
            const categoryByCode = new Map(categories.map((c) => [c.code, c]));
            const conflicts = [];
            for (const row of committable) {
                const n = row.normalizedDataJson;
                if (!n) { conflicts.push({ rowNumber: row.rowNumber, codes: ['MISSING_NORMALIZED'] }); continue; }
                if (!categoryByCode.has(n.categoryCode)) conflicts.push({ rowNumber: row.rowNumber, codes: ['UNKNOWN_CATEGORY'] });
                const existing = currentByNumber.get(n.assetNumber);
                if (job.importMode === 'INSERT_ONLY' && existing) conflicts.push({ rowNumber: row.rowNumber, codes: ['DUPLICATE_IN_DB'] });
                if (n.serialNumber) {
                    const ownerId = currentSerials.get(n.serialNumber);
                    const sameAsset = ownerId && existing && ownerId === existing.id;
                    if (ownerId && !sameAsset) conflicts.push({ rowNumber: row.rowNumber, codes: ['DUPLICATE_SERIAL_IN_DB'] });
                }
            }
            // UPSERT 수정 대상 소실은 별도 충돌로 삼지 않는다: 커밋 시점에 대상이 없으면
            // 위 분기대로 신규 삽입으로 처리한다. 대상이 사라진 뒤 다시 생긴 자산과
            // 시리얼이 겹치는 경우는 위 시리얼 재검사에서 충돌로 잡힌다.
            if (conflicts.length) {
                return res.status(409).json({ success: false, error: '커밋 직전 재검사에서 충돌이 발견되어 커밋하지 않았습니다. 다시 업로드해 주세요.', code: 'IMPORT_COMMIT_CONFLICT', conflicts });
            }
            const assets = load(ASSETS_FILE);
            const locations = load(LOCATIONS_FILE);
            let insertedCount = 0;
            let updatedCount = 0;
            let qrIssuedCount = 0;
            const insertedAssets = [];
            for (const row of committable) {
                const n = row.normalizedDataJson;
                const existing = assets.find((a) => a.isActive && a.assetNumber === n.assetNumber);
                if (job.importMode === 'UPSERT' && existing) {
                    const loc = locations.find((l) => l.assetId === existing.id) || null;
                    row.beforeAssetSnapshot = {
                        asset: {
                            name: existing.name, categoryId: existing.categoryId, manufacturer: existing.manufacturer,
                            modelName: existing.modelName, serialNumber: existing.serialNumber, team: existing.team,
                            operationalStatus: existing.operationalStatus,
                        },
                        location: loc ? { ...loc } : null,
                    };
                    existing.name = n.name;
                    existing.categoryId = categoryByCode.get(n.categoryCode).id;
                    existing.manufacturer = n.manufacturer;
                    existing.modelName = n.modelName;
                    existing.serialNumber = n.serialNumber;
                    existing.team = n.departmentCode;
                    existing.operationalStatus = n.operationalStatus;
                    existing.updatedAt = nowIso();
                    row.actionTaken = 'UPDATED';
                    row.targetAssetId = existing.id;
                    updatedCount++;
                } else {
                    const asset = {
                        id: crypto.randomUUID(),
                        assetNumber: n.assetNumber,
                        name: n.name,
                        categoryId: categoryByCode.get(n.categoryCode).id,
                        manufacturer: n.manufacturer,
                        modelName: n.modelName,
                        serialNumber: n.serialNumber,
                        acquisitionDate: null,
                        acquisitionCost: null,
                        acquisitionMethod: null,
                        usefulLifeYears: null,
                        team: n.departmentCode,
                        custodianUserId: null,
                        operationalStatus: n.operationalStatus,
                        usageType: 'DEDICATED',
                        notes: null,
                        isActive: true,
                        deactivatedAt: null,
                        deactivationReason: null,
                        createdBy: req.auth ? req.auth.id : null,
                        createdAt: nowIso(),
                        updatedAt: nowIso(),
                    };
                    assets.push(asset);
                    insertedAssets.push(asset);
                    row.actionTaken = 'INSERTED';
                    row.targetAssetId = asset.id;
                    insertedCount++;
                }
            }
            for (const row of rows) {
                if (row.validationStatus === 'ERROR') row.actionTaken = 'SKIPPED';
            }
            await persistData(ASSETS_FILE, assets);
            for (const asset of insertedAssets) {
                await applyLocation(asset.id, { roomId: null, zoneId: null, furnitureId: null, shelfSlot: null, note: null }, req, 'INITIAL_PLACEMENT');
                if (job.autoIssueQr) {
                    await issueQrForAsset(asset, req, 'IMPORT');
                    qrIssuedCount++;
                }
            }
            job.status = 'COMMITTED';
            job.committedRows = insertedCount + updatedCount;
            job.committedAt = nowIso();
            await persistData(IMPORT_ROWS_FILE, load(IMPORT_ROWS_FILE).map((r) => {
                const updated = rows.find((x) => x.id === r.id);
                return updated || r;
            }));
            await persistData(IMPORTS_FILE, jobs);
            await appendAudit({ action: 'IMPORT_COMMITTED', entityType: 'DataImport', entityId: job.id, req, detail: { filename: job.filename, importMode: job.importMode, insertedCount, updatedCount, skippedErrorCount: rows.filter((r) => r.actionTaken === 'SKIPPED').length, qrIssuedCount } });
            return res.json({ success: true, data: { job: serializeImportJob(job), insertedCount, updatedCount, skippedErrorCount: rows.filter((r) => r.actionTaken === 'SKIPPED').length, qrIssuedCount } });
        } catch (err) {
            console.error('[ASSET_IMPORT_COMMIT_ERROR]:', err.message);
            return res.status(500).json({ success: false, error: '가져오기 커밋 중 오류가 발생했습니다.' });
        }
    });

    // 롤백: 커밋된 작업만 되돌린다. 신규 삽입은 소프트 삭제(+QR 폐기), 수정은 스냅샷 복원, 재롤백 409.
    router.post('/imports/:id/rollback', requireAdmin, async (req, res) => {
        try {
            const jobs = load(IMPORTS_FILE);
            const job = jobs.find((j) => j.id === req.params.id);
            if (!job) return res.status(404).json({ success: false, error: '가져오기 작업을 찾을 수 없습니다.' });
            if (job.status === 'ROLLED_BACK') return res.status(409).json({ success: false, error: '이미 롤백된 작업입니다.', code: 'IMPORT_ALREADY_ROLLED_BACK' });
            if (job.status !== 'COMMITTED') return res.status(409).json({ success: false, error: '커밋된 작업만 롤백할 수 있습니다.', code: 'IMPORT_NOT_COMMITTED' });
            const rows = load(IMPORT_ROWS_FILE).filter((r) => r.jobId === job.id).sort((a, b) => a.rowNumber - b.rowNumber);
            const assets = load(ASSETS_FILE);
            const qrs = load(QR_CODES_FILE);
            const locations = load(LOCATIONS_FILE);
            let insertedRolledBack = 0;
            let updatedRestored = 0;
            let qrRevoked = false;
            let locationChanged = false;
            for (const row of rows) {
                if (row.actionTaken === 'INSERTED') {
                    const asset = assets.find((a) => a.id === row.targetAssetId);
                    if (asset && asset.isActive) {
                        asset.isActive = false;
                        asset.deactivatedAt = nowIso();
                        asset.deactivationReason = 'IMPORT_ROLLBACK';
                        asset.updatedAt = nowIso();
                        insertedRolledBack++;
                    }
                    for (const q of qrs) {
                        if (q.assetId === row.targetAssetId && (q.status === 'ACTIVE' || q.status === 'DAMAGED_REPORTED')) {
                            q.status = 'REVOKED';
                            q.revokedBy = req.auth ? req.auth.id : null;
                            q.revokedAt = nowIso();
                            q.revokeReason = 'IMPORT_ROLLBACK';
                            qrRevoked = true;
                        }
                    }
                    row.actionTaken = 'ROLLED_BACK';
                } else if (row.actionTaken === 'UPDATED') {
                    const asset = assets.find((a) => a.id === row.targetAssetId);
                    const snap = row.beforeAssetSnapshot;
                    if (asset && snap && snap.asset) {
                        Object.assign(asset, {
                            name: snap.asset.name, categoryId: snap.asset.categoryId, manufacturer: snap.asset.manufacturer,
                            modelName: snap.asset.modelName, serialNumber: snap.asset.serialNumber, team: snap.asset.team,
                            operationalStatus: snap.asset.operationalStatus, updatedAt: nowIso(),
                        });
                        updatedRestored++;
                    }
                    if (snap && snap.location) {
                        const loc = locations.find((l) => l.assetId === row.targetAssetId);
                        if (loc) Object.assign(loc, { ...snap.location });
                        else locations.push({ ...snap.location });
                        locationChanged = true;
                    }
                    // 스냅샷 위치가 null이었던 경우(가져오기가 위치를 바꾸지 않으므로) 커밋 이후
                    // 별도 경로로 생긴 위치 행은 지우지 않는다. 가져오기 롤백 범위를 넘기 때문이다.
                    row.actionTaken = 'ROLLED_BACK';
                }
            }
            await persistData(ASSETS_FILE, assets);
            if (qrRevoked) await persistData(QR_CODES_FILE, qrs);
            if (locationChanged) await persistData(LOCATIONS_FILE, locations);
            job.status = 'ROLLED_BACK';
            job.rolledBackAt = nowIso();
            await persistData(IMPORT_ROWS_FILE, load(IMPORT_ROWS_FILE).map((r) => {
                const updated = rows.find((x) => x.id === r.id);
                return updated || r;
            }));
            await persistData(IMPORTS_FILE, jobs);
            await appendAudit({ action: 'IMPORT_ROLLED_BACK', entityType: 'DataImport', entityId: job.id, req, detail: { filename: job.filename, insertedRolledBack, updatedRestored } });
            return res.json({ success: true, data: { job: serializeImportJob(job), insertedRolledBack, updatedRestored } });
        } catch (err) {
            console.error('[ASSET_IMPORT_ROLLBACK_ERROR]:', err.message);
            return res.status(500).json({ success: false, error: '가져오기 롤백 중 오류가 발생했습니다.' });
        }
    });

    // 내보내기: 프리셋 ALL_ASSETS·DISCREPANCY_ASSETS·UNCHECKED_ASSETS·AUDIT_LOGS.
    // XLSX는 ALL_ASSETS 1종만 지원한다 (원본 규칙). AUDIT_LOGS는 관리자 전용·최대 5000행.
    // 모든 텍스트 셀은 수식 주입 방어, 숫자 셀은 숫자 타입을 유지한다.
    router.get('/exports', async (req, res) => {
        try {
            const preset = asString(req.query.preset) || 'ALL_ASSETS';
            const format = asString(req.query.format) || 'csv';
            const PRESETS = ['ALL_ASSETS', 'DISCREPANCY_ASSETS', 'UNCHECKED_ASSETS', 'AUDIT_LOGS'];
            if (!PRESETS.includes(preset)) return res.status(400).json({ success: false, error: '유효하지 않은 내보내기 프리셋(preset)입니다.' });
            if (format !== 'csv' && format !== 'xlsx') return res.status(400).json({ success: false, error: 'format은 csv 또는 xlsx여야 합니다.' });
            if (format === 'xlsx' && preset !== 'ALL_ASSETS') {
                return res.status(400).json({ success: false, error: 'XLSX 내보내기는 전체 자산(ALL_ASSETS)만 지원합니다.', code: 'EXPORT_FORMAT_NOT_SUPPORTED' });
            }
            if (preset === 'AUDIT_LOGS' && !isAdmin(req)) {
                return res.status(403).json({ success: false, error: '관리자 권한이 필요합니다.' });
            }
            const dateStamp = new Date().toISOString().split('T')[0].replace(/-/g, '');
            const scopedAssets = load(ASSETS_FILE).filter((a) => a.isActive && inTeamScope(req, a));
            const categories = load(CATEGORIES_FILE);
            const spaces = load(SPACES_FILE);
            const locations = load(LOCATIONS_FILE);
            const assetRow = (a) => {
                const category = a.categoryId ? categories.find((c) => c.id === a.categoryId) || null : null;
                const loc = locations.find((l) => l.assetId === a.id) || null;
                const room = loc && loc.roomId ? spaces.find((s) => s.id === loc.roomId && s.kind === 'room') || null : null;
                return [
                    a.assetNumber, a.name, category ? category.name : '', a.manufacturer || '', a.modelName || '',
                    a.serialNumber || '', a.operationalStatus, a.team || '', room ? room.name : '',
                    a.acquisitionDate || '', (isAdmin(req) || isManager(req)) ? (a.acquisitionCost ?? '') : '',
                ];
            };
            let headers;
            let aoa;
            if (preset === 'AUDIT_LOGS') {
                headers = ['일시', '액션', '카테고리(대상 종류)', '대상ID', '행위자', '행위자 역할', '상세'];
                const logs = load(AUDIT_FILE);
                logs.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
                const sliced = logs.slice(0, 5000);
                aoa = [headers, ...sliced.map((l) => [
                    l.createdAt, l.action, l.entityType, l.entityId || '', l.actorName || '', l.actorRole || '',
                    l.detail ? JSON.stringify(l.detail) : '',
                ])];
            } else {
                headers = ['자산번호', '품명', '분류', '제조사', '모델명', '시리얼', '운영상태', '팀', '사무실', '취득일', '취득가'];
                let list = scopedAssets;
                if (preset === 'DISCREPANCY_ASSETS') {
                    const badIds = new Set(load(INVENTORY_CHECKS_FILE)
                        .filter((c) => !c.isLocationMatched || DISCREPANCY_RESULT_STATUSES.includes(c.resultStatus))
                        .map((c) => c.assetId));
                    list = scopedAssets.filter((a) => badIds.has(a.id));
                } else if (preset === 'UNCHECKED_ASSETS') {
                    const activePlans = load(INVENTORY_PLANS_FILE).filter((p) => p.isActive && p.status !== 'CANCELLED');
                    const activePlanIds = new Set(activePlans.map((p) => p.id));
                    const checkedTargetIds = new Set(load(INVENTORY_CHECKS_FILE).filter((c) => activePlanIds.has(c.planId)).map((c) => c.targetId));
                    const uncheckedAssetIds = new Set(load(INVENTORY_TARGETS_FILE)
                        .filter((t) => activePlanIds.has(t.planId) && !checkedTargetIds.has(t.id))
                        .map((t) => t.assetId));
                    list = scopedAssets.filter((a) => uncheckedAssetIds.has(a.id));
                }
                aoa = [headers, ...list.map(assetRow)];
            }
            const rowCount = aoa.length - 1;
            await appendAudit({ action: 'DATA_EXPORTED', entityType: 'Export', entityId: null, req, detail: { preset, format, rowCount } });
            if (format === 'xlsx') {
                const sanitized = aoa.map((row, ri) => row.map((cell) => (ri === 0 ? String(cell) : formatExportCell(cell))));
                const ws = XLSX.utils.aoa_to_sheet(sanitized);
                const wb = XLSX.utils.book_new();
                XLSX.utils.book_append_sheet(wb, ws, 'assets');
                const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
                res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
                res.setHeader('Content-Disposition', `attachment; filename="assets_${dateStamp}.xlsx"`);
                return res.send(buffer);
            }
            const lines = aoa.map((row, ri) => row.map((cell) => {
                const value = ri === 0 ? String(cell) : formatExportCell(cell);
                return csvEscape(value);
            }).join(','));
            res.setHeader('Content-Type', 'text/csv; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename="asset-export_${preset}_${dateStamp}.csv"`);
            return res.send(`\uFEFF${lines.join('\n')}`);
        } catch (err) {
            console.error('[ASSET_EXPORT_ERROR]:', err.message);
            return res.status(500).json({ success: false, error: '내보내기 중 오류가 발생했습니다.' });
        }
    });

    // 대시보드 지표 (로그인 전체, 비관리자는 팀 스코프 적용).
    // 미확인(365일): 현재 위치 행이 없거나 lastVerifiedAt이 없거나 365일보다 오래된 활성 자산.
    // 신규 자산은 lastVerifiedAt이 null이므로 승인으로 확인되기 전까지 미확인으로 센다 (원본 의도 동일).
    router.get('/dashboard/metrics', (req, res) => {
        const scopedAssets = load(ASSETS_FILE).filter((a) => a.isActive && inTeamScope(req, a));
        const scopedIds = new Set(scopedAssets.map((a) => a.id));
        const byOperationalStatus = {};
        for (const s of OPERATIONAL_STATUSES) byOperationalStatus[s] = 0;
        for (const a of scopedAssets) {
            if (byOperationalStatus[a.operationalStatus] === undefined) byOperationalStatus[a.operationalStatus] = 0;
            byOperationalStatus[a.operationalStatus]++;
        }
        const checks = load(INVENTORY_CHECKS_FILE).filter((c) => scopedIds.has(c.assetId));
        const discrepancyCount = checks.filter((c) => !c.isLocationMatched).length;
        const unapprovedCount = checks.filter((c) => c.approvalStatus === 'PENDING').length;
        const locations = load(LOCATIONS_FILE);
        const locByAsset = new Map(locations.map((l) => [l.assetId, l]));
        const cutoff = Date.now() - STALE_DAYS * 24 * 60 * 60 * 1000;
        let staleOver365Days = 0;
        for (const a of scopedAssets) {
            const loc = locByAsset.get(a.id);
            if (!loc || !loc.lastVerifiedAt || Date.parse(loc.lastVerifiedAt) < cutoff) staleOver365Days++;
        }
        let plans = load(INVENTORY_PLANS_FILE).filter((p) => p.isActive);
        if (!isAdmin(req) && req.auth.team) plans = plans.filter((p) => !p.team || p.team === req.auth.team);
        plans.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
        const latest = plans[0] || null;
        let latestPlan = null;
        if (latest) {
            const targets = load(INVENTORY_TARGETS_FILE).filter((t) => t.planId === latest.id);
            const processedCount = targets.filter((t) => t.status !== 'UNCHECKED' && t.status !== 'DRAFT').length;
            latestPlan = {
                id: latest.id, name: latest.name, status: latest.status,
                targetCount: targets.length, processedCount, progress: computeInventoryProgress(targets),
            };
        }
        return res.json({
            success: true,
            data: {
                totalAssets: scopedAssets.length,
                byOperationalStatus,
                byVerificationStatus: { VERIFIED: scopedAssets.length - staleOver365Days, UNVERIFIED: staleOver365Days },
                discrepancyCount,
                unapprovedCount,
                staleOver365Days,
                latestPlan,
                generatedAt: nowIso(),
            },
        });
    });

    // 관리자: ASSET_AUDIT_ACCESS 플래그 부여·회수 (admin 전용).
    // AccountsPage 토글 UI는 이번 단계에서 붙이지 않는다 (아래 사유, STAGE3_CHECK.md 참조).
    // 부여 방식은 기존 voice-access/online-survey-access 엔드포인트와 동일하며,
    // 세션에 권한이 스냅샷으로 들어 있으므로 부여 후에는 재로그인이 필요하다.
    router.post('/admin/asset-audit-access/:userId', requireAdmin, async (req, res) => {
        try {
            if (!req.body || typeof req.body.granted !== 'boolean') {
                return res.status(400).json({ success: false, error: 'granted 값은 true 또는 false여야 합니다.' });
            }
            const granted = req.body.granted;
            const users = getData('Users', []);
            const targetIndex = users.findIndex((u) => u && String(u.id) === String(req.params.userId));
            if (targetIndex === -1) return res.status(404).json({ success: false, error: '대상 사용자를 찾을 수 없습니다.' });
            const targetUser = users[targetIndex];
            if (targetUser.status !== 'active') {
                return res.status(400).json({ success: false, error: '비활성 또는 정지된 사용자에게는 권한을 부여할 수 없습니다.' });
            }
            let updatedPermissions;
            if (Array.isArray(targetUser.permissions)) {
                updatedPermissions = granted
                    ? (targetUser.permissions.includes('ASSET_AUDIT_ACCESS') ? [...targetUser.permissions] : [...targetUser.permissions, 'ASSET_AUDIT_ACCESS'])
                    : targetUser.permissions.filter((p) => p !== 'ASSET_AUDIT_ACCESS');
            } else if (typeof targetUser.permissions === 'object' && targetUser.permissions !== null) {
                updatedPermissions = { ...targetUser.permissions, ASSET_AUDIT_ACCESS: granted };
            } else {
                updatedPermissions = { ASSET_AUDIT_ACCESS: granted };
            }
            const updatedUser = { ...targetUser, permissions: updatedPermissions };
            const updatedUsers = [...users.slice(0, targetIndex), updatedUser, ...users.slice(targetIndex + 1)];
            await persistData('Users', updatedUsers);
            await appendAudit({ action: granted ? 'ASSET_AUDIT_ACCESS_GRANTED' : 'ASSET_AUDIT_ACCESS_REVOKED', entityType: 'User', entityId: updatedUser.id, req, detail: {} });
            const { password, ...safeUser } = updatedUser;
            return res.json({ success: true, user: safeUser, note: '권한 변경 후 대상 사용자는 재로그인해야 적용됩니다.' });
        } catch (err) {
            console.error('[ASSET_AUDIT_ACCESS_ERROR]:', err.message);
            return res.status(500).json({ success: false, error: '감사자 권한 변경 중 오류가 발생했습니다.' });
        }
    });

    return router;
}
