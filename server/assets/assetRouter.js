/**
 * server/assets/assetRouter.js — Stage 1 (JSON 저장 자산관리 코어)
 * Express 라우터 팩토리. survey/voice-calls 패턴을 따른다:
 *   createAssetRouter({ requireAuth, requireAdmin, getData, persistData })
 * 필수 deps 누락 시 생성 시점에 throw한다.
 * 저장소는 주입받은 getData/persistData만 쓰며, DATA_DIR 아래 Asset_* 파일에 저장한다.
 * 기존 PC_Assets 파일·/api/pcassets 엔드포인트는 읽지도 쓰지도 않는다.
 *
 * Stage 1 파일 집합 (최소):
 *   Asset_Assets, Asset_Categories, Asset_Locations, Asset_LocationHistory,
 *   Asset_Spaces(사업장/건물/층/사무실/구역/가구 계층 통합), Asset_AuditLogs(append-only)
 * Stage 1에서 만들지 않는 파일: Asset_Assignments(배정 이력은 Stage 2 이후),
 *   Asset_FloorPlans/Asset_QrCodes/Asset_Inventory*(Stage 2), Asset_Imports*(Stage 3).
 *
 * 권한 (Stage 1 최종, STAGE1_CHECK.md 참조):
 *   - 모든 라우트 requireAuth (비로그인 401).
 *   - 자산/공간/분류 쓰기: admin은 전부, manager는 자산 생성·수정만(삭제 불가).
 *   - 자산 삭제·공간 쓰기·분류 쓰기·감사로그 조회: admin 전용 (비관리자 403).
 *   - 일반 사용자(user): 조회만. 목록·검색은 팀 스코프 필터 적용
 *     (asset.team이 없거나 본인 팀과 같을 때만 노출, admin은 전체).
 *   - ASSET_ADMIN은 Stage 1에서 admin으로 통합한다 (별도 플래그 없음, Stage 3에서 분리 검토).
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
} from './assetStateMachine.js';

const ASSETS_FILE = 'Asset_Assets';
const CATEGORIES_FILE = 'Asset_Categories';
const LOCATIONS_FILE = 'Asset_Locations';
const LOCATION_HISTORY_FILE = 'Asset_LocationHistory';
const SPACES_FILE = 'Asset_Spaces';
const AUDIT_FILE = 'Asset_AuditLogs';

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

    return router;
}
