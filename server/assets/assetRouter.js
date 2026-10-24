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
 * 감사로그: Asset_AuditLogs에는 append만 한다. 이 라우터에는
 *   Asset_AuditLogs에 대한 POST/PUT/PATCH/DELETE 라우트를 만들지 않는다.
 */

import express from 'express';
import crypto from 'crypto';
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
        let logs = load(AUDIT_FILE);
        if (entityId) logs = logs.filter((l) => l.entityId === entityId);
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

    return router;
}
