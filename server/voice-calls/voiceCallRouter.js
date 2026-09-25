/**
 * server/voice-calls/voiceCallRouter.js
 * Express REST API Router for Voice Call Management & Classification.
 */

import express from 'express';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import {
    CALL_CATEGORY,
    ASSIGNMENT_STATUS,
    REVIEW_STATUS,
    INTAKE_VALIDATION_STATUS
} from './voiceCallConstants.js';
import {
    JOYCALL_CANONICAL_RECORD_TYPES,
    JOYCALL_CANONICAL_CLASSIFICATION_METHODS,
    JOYCALL_CLASSIFICATION_STATUS
} from '../joycall-intake/joyCallIntakeConstants.js';
import { requireVoiceAiAccess } from '../permissions/permissionMiddleware.js';

/**
 * Factory to create VoiceCall API Router with injected dependencies.
 * 
 * @param {Object} deps
 * @param {Function} deps.requireAuth
 * @param {import('./voiceCallRepository.js').VoiceCallRepository} deps.voiceCallRepository
 * @param {import('../joycall-intake/joyCallIntakeRepository.js').JoyCallIntakeRepository} [deps.joyCallIntakeRepository]
 * @param {import('../joycall-intake/joyCallIntakeCoordinator.js').JoyCallIntakeCoordinator} [deps.joyCallIntakeCoordinator]
 * @param {string} [deps.privateAudioDir]
 * @param {string} [deps.joyCallIncomingDir]
 * @param {Function} [deps.getData]
 * @param {Function} [deps.persistData]
 * @param {Function} [deps.auditLogger]
 * @returns {express.Router}
 */
export function createVoiceCallRouter(deps = {}) {
    const {
        requireAuth,
        voiceCallRepository,
        joyCallIntakeRepository,
        joyCallIntakeCoordinator,
        privateAudioDir,
        joyCallIncomingDir,
        getData,
        persistData,
        auditLogger
    } = deps;

    if (!voiceCallRepository) {
        throw new Error('createVoiceCallRouter requires voiceCallRepository dependency');
    }

    const router = express.Router();

    // Universal authentication requirement for voice calls
    router.use(requireAuth);
    const voiceAiGuard = requireVoiceAiAccess({ auditLogger });

    // 1. GET /api/voice-calls/stats - 통화 분류 및 처리 현황 통계 (일반 업무: requireAuth)
    router.get('/stats', (req, res) => {
        try {
            const records = voiceCallRepository.list({ includeDeleted: false });
            
            const stats = {
                total: records.length,
                pendingClassification: 0, // 분류 대기
                administrative: 0,        // 행정전화
                individualCounseling: 0,  // 개별상담
                intakeCounseling: 0,      // 접수상담
                totalCounseling: 0,       // 상담전화 합계
                unassigned: 0,            // 담당자 미배정
                assigned: 0,              // 담당자 배정 완료
                linkedToReferral: 0       // 의뢰대장 연동 완료
            };

            for (const r of records) {
                const recType = r.callRecordType || r.callCategory;
                const isPending = !r.callRecordType || r.classificationStatus === 'pending' || recType === 'unknown';

                if (isPending) {
                    stats.pendingClassification++;
                } else if (recType === 'administrative_call' || recType === 'administrative') {
                    stats.administrative++;
                } else if (recType === 'individual_counseling') {
                    stats.individualCounseling++;
                    stats.totalCounseling++;
                } else if (recType === 'intake_counseling') {
                    stats.intakeCounseling++;
                    stats.totalCounseling++;
                } else if (recType === 'clinical') {
                    stats.individualCounseling++;
                    stats.totalCounseling++;
                }

                if (r.assignmentStatus === ASSIGNMENT_STATUS.ASSIGNED || r.assignedUserId) {
                    stats.assigned++;
                } else {
                    stats.unassigned++;
                }

                if (r.referralId) {
                    stats.linkedToReferral++;
                }
            }

            res.json(stats);
        } catch (err) {
            console.error('Error fetching voice call stats:', err);
            res.status(500).json({ error: '통화 통계 조회 중 오류가 발생했습니다: ' + err.message });
        }
    });

    // 2. GET /api/voice-calls - 통화 목록 조회 (필터링 & 검색)
    router.get('/', requireAuth, (req, res) => {
        try {
            const {
                tab,            // 'all' | 'pending' | 'administrative' | 'individual' | 'intake' | 'completed'
                category,       // specific category filter
                assignment,     // 'all' | 'assigned' | 'unassigned'
                search,         // keyword search (filename, caller, notes, client)
                startDate,
                endDate,
                department
            } = req.query;

            let records = voiceCallRepository.list({ includeDeleted: false });

            // 탭 필터링
            if (tab && tab !== 'all') {
                if (tab === 'pending') {
                    records = records.filter(r => !r.callRecordType || r.classificationStatus === 'pending' || r.callCategory === 'unknown');
                } else if (tab === 'administrative') {
                    records = records.filter(r => r.callRecordType === 'administrative_call' || r.callCategory === 'administrative');
                } else if (tab === 'individual') {
                    records = records.filter(r => r.callRecordType === 'individual_counseling');
                } else if (tab === 'intake') {
                    records = records.filter(r => r.callRecordType === 'intake_counseling');
                } else if (tab === 'counseling') {
                    records = records.filter(r => r.callRecordType === 'individual_counseling' || r.callRecordType === 'intake_counseling' || r.callCategory === 'clinical');
                } else if (tab === 'completed') {
                    records = records.filter(r => r.classificationStatus === 'classified' && r.assignmentStatus === ASSIGNMENT_STATUS.ASSIGNED);
                }
            }

            // 개별 카테고리 필터
            if (category && category !== 'all') {
                records = records.filter(r => r.callRecordType === category || r.callCategory === category);
            }

            // 배정 여부 필터
            if (assignment === 'assigned') {
                records = records.filter(r => r.assignmentStatus === ASSIGNMENT_STATUS.ASSIGNED || r.assignedUserId);
            } else if (assignment === 'unassigned') {
                records = records.filter(r => r.assignmentStatus !== ASSIGNMENT_STATUS.ASSIGNED && !r.assignedUserId);
            }

            // 부서 필터
            if (department && department !== 'all') {
                records = records.filter(r => r.assignedDepartmentId === department || r.owningDepartmentId === department);
            }

            // 날짜 범위 필터
            if (startDate) {
                records = records.filter(r => (r.receivedAt || r.createdAt) >= startDate);
            }
            if (endDate) {
                const nextDay = new Date(new Date(endDate).getTime() + 86400000).toISOString().split('T')[0];
                records = records.filter(r => (r.receivedAt || r.createdAt) < nextDay);
            }

            // 검색어 필터
            if (search && String(search).trim()) {
                const q = String(search).trim().toLowerCase();
                records = records.filter(r => 
                    (r.originalFileName && r.originalFileName.toLowerCase().includes(q)) ||
                    (r.callerPhoneNumber && r.callerPhoneNumber.includes(q)) ||
                    (r.clientName && r.clientName.toLowerCase().includes(q)) ||
                    (r.notes && r.notes.toLowerCase().includes(q)) ||
                    (r.classifiedByUserName && r.classifiedByUserName.toLowerCase().includes(q)) ||
                    (r.id && r.id.toLowerCase().includes(q))
                );
            }

            // 최신 통화 일시 역순 정렬
            records.sort((a, b) => new Date(b.receivedAt || b.createdAt).getTime() - new Date(a.receivedAt || a.createdAt).getTime());

            res.json({
                total: records.length,
                calls: records
            });
        } catch (err) {
            console.error('Error listing voice calls:', err);
            res.status(500).json({ error: '통화 목록 조회 중 오류가 발생했습니다: ' + err.message });
        }
    });

    // 3. GET /api/voice-calls/:id - 단일 통화 상세 조회
    router.get('/:id', (req, res) => {
        try {
            const call = voiceCallRepository.findById(req.params.id);
            if (!call) {
                return res.status(404).json({ error: '통화 녹음 정보를 찾을 수 없습니다.' });
            }
            if (typeof auditLogger === 'function') {
                auditLogger({
                    actorUserId: req.auth?.id || 'unknown',
                    targetId: req.params.id,
                    action: 'VOICE_RECORDING_VIEWED',
                    result: 'SUCCESS'
                });
            }
            res.json(call);
        } catch (err) {
            res.status(500).json({ error: '통화 정보 조회 실패: ' + err.message });
        }
    });

    // 4. POST /api/voice-calls/:id/classify - 수동 분류 (행정전화 / 개별상담 / 접수상담)
    router.post('/:id/classify', requireAuth, async (req, res) => {
        try {
            const { id } = req.params;
            const {
                callRecordType, // 'administrative_call' | 'individual_counseling' | 'intake_counseling'
                notes,
                callerPhoneNumber,
                clientName
            } = req.body;

            const validTypes = [
                JOYCALL_CANONICAL_RECORD_TYPES.ADMINISTRATIVE_CALL,
                JOYCALL_CANONICAL_RECORD_TYPES.INDIVIDUAL_COUNSELING,
                JOYCALL_CANONICAL_RECORD_TYPES.INTAKE_COUNSELING
            ];

            if (!validTypes.includes(callRecordType)) {
                return res.status(400).json({
                    error: `유효하지 않은 통화 분류입니다. 다음 중 하나여야 합니다: ${validTypes.join(', ')}`
                });
            }

            const current = voiceCallRepository.findById(id);
            if (!current) {
                return res.status(404).json({ error: '해당 통화 기록을 찾을 수 없습니다.' });
            }

            const staffUserId = req.auth?.id || req.auth?.username || 'staff';
            const staffUserName = req.auth?.name || req.auth?.username || '담당자';
            const nowIso = new Date().toISOString();

            // Mapping to high-level callCategory
            let callCategory = CALL_CATEGORY.ADMINISTRATIVE;
            if (callRecordType === JOYCALL_CANONICAL_RECORD_TYPES.INDIVIDUAL_COUNSELING || 
                callRecordType === JOYCALL_CANONICAL_RECORD_TYPES.INTAKE_COUNSELING) {
                callCategory = CALL_CATEGORY.CLINICAL;
            }

            const updated = await voiceCallRepository.update(id, (existing) => {
                existing.callRecordType = callRecordType;
                existing.callCategory = callCategory;
                existing.classificationStatus = JOYCALL_CLASSIFICATION_STATUS.CLASSIFIED;
                existing.classificationMethod = JOYCALL_CANONICAL_CLASSIFICATION_METHODS.STAFF_SELECTED;
                existing.classifiedByUserId = staffUserId;
                existing.classifiedByUserName = staffUserName;
                existing.classifiedAt = nowIso;
                if (notes !== undefined) existing.notes = String(notes).trim();
                if (callerPhoneNumber) existing.callerPhoneNumber = String(callerPhoneNumber).trim();
                if (clientName) existing.clientName = String(clientName).trim();
                existing.updatedAt = nowIso;
            });

            res.json({
                success: true,
                message: '통화 분류가 성공적으로 완료되었습니다.',
                call: updated
            });
        } catch (err) {
            console.error('Error classifying voice call:', err);
            res.status(500).json({ error: '통화 분류 처리 중 오류 발생: ' + err.message });
        }
    });

    // 5. POST /api/voice-calls/:id/assign - 담당자 및 담당 부서 배정
    router.post('/:id/assign', requireAuth, async (req, res) => {
        try {
            const { id } = req.params;
            const {
                assignedDepartmentId, // e.g. '증진팀' | '회복팀' | '자살예방센터'
                assignedUserId,       // e.g. 'user_jin'
                assignedUserName      // e.g. '김화자'
            } = req.body;

            if (!assignedDepartmentId && !assignedUserId) {
                return res.status(400).json({ error: '배정할 부서 또는 담당자 정보가 필요합니다.' });
            }

            const current = voiceCallRepository.findById(id);
            if (!current) {
                return res.status(404).json({ error: '해당 통화 기록을 찾을 수 없습니다.' });
            }

            const nowIso = new Date().toISOString();
            const operatorId = req.auth?.id || req.auth?.username || 'operator';

            const updated = await voiceCallRepository.update(id, (existing) => {
                if (assignedDepartmentId) existing.assignedDepartmentId = assignedDepartmentId;
                if (assignedUserId) existing.assignedUserId = assignedUserId;
                if (assignedUserName) existing.assignedUserName = assignedUserName;
                existing.assignmentStatus = ASSIGNMENT_STATUS.ASSIGNED;
                existing.assignmentChangedAt = nowIso;
                existing.assignmentChangedBy = operatorId;
                existing.updatedAt = nowIso;
            });

            res.json({
                success: true,
                message: '담당자가 성공적으로 배정되었습니다.',
                call: updated
            });
        } catch (err) {
            console.error('Error assigning voice call:', err);
            res.status(500).json({ error: '담당자 배정 실패: ' + err.message });
        }
    });

    // 6. POST /api/voice-calls/:id/link - 의뢰대장 내담자 연동
    router.post('/:id/link', requireAuth, async (req, res) => {
        try {
            const { id } = req.params;
            const {
                referralId,
                refNo,
                clientId,
                clientName
            } = req.body;

            const current = voiceCallRepository.findById(id);
            if (!current) {
                return res.status(404).json({ error: '해당 통화 기록을 찾을 수 없습니다.' });
            }

            const nowIso = new Date().toISOString();
            const updated = await voiceCallRepository.update(id, (existing) => {
                if (referralId) existing.referralId = referralId;
                if (refNo) existing.refNo = refNo;
                if (clientId) existing.clientId = clientId;
                if (clientName) existing.clientName = clientName;
                existing.subjectLinkStatus = 'linked';
                existing.updatedAt = nowIso;
            });

            res.json({
                success: true,
                message: '의뢰대장 내담자와 성공적으로 연결되었습니다.',
                call: updated
            });
        } catch (err) {
            console.error('Error linking voice call to referral:', err);
            res.status(500).json({ error: '의뢰 연동 실패: ' + err.message });
        }
    });

    // 7. POST /api/voice-calls/sync - 조이콜 NAS incoming 녹음 동기화 실행
    router.post('/sync', requireAuth, async (req, res) => {
        try {
            const incomingDir = joyCallIncomingDir || (privateAudioDir ? path.resolve(privateAudioDir, '..', 'incoming-voice') : null);
            
            if (!incomingDir || !fs.existsSync(incomingDir)) {
                if (incomingDir) fs.mkdirSync(incomingDir, { recursive: true });
                return res.json({
                    success: true,
                    message: '수신 디렉터리가 초기화되었습니다. 현재 대기 중인 새 파일이 없습니다.',
                    scanned: 0,
                    imported: 0
                });
            }

            // Scan files in incoming directory
            const files = fs.readdirSync(incomingDir)
                .filter(f => !f.startsWith('.') && !f.endsWith('.uploading') && !f.endsWith('.tmp'))
                .filter(f => ['.wav', '.mp3', '.m4a'].includes(path.extname(f).toLowerCase()));

            let importedCount = 0;
            let skippedCount = 0;

            for (const file of files) {
                const fullPath = path.join(incomingDir, file);
                const stats = fs.statSync(fullPath);
                if (!stats.isFile() || stats.size === 0) continue;

                // Compute SHA-256
                const hash = crypto.createHash('sha256');
                const fileBuf = fs.readFileSync(fullPath);
                hash.update(fileBuf);
                const sha256 = hash.digest('hex');

                // Check duplicate
                const existing = voiceCallRepository.findByContentHash(sha256);
                if (existing) {
                    skippedCount++;
                    continue;
                }

                // Copy to private audio dir if target storage exists
                let storageKey = file;
                if (privateAudioDir) {
                    if (!fs.existsSync(privateAudioDir)) fs.mkdirSync(privateAudioDir, { recursive: true });
                    const targetFile = `joycall_${Date.now()}_${file}`;
                    const targetPath = path.join(privateAudioDir, targetFile);
                    fs.copyFileSync(fullPath, targetPath);
                    storageKey = targetFile;
                }

                // Create intake record
                await voiceCallRepository.create({
                    intakeSource: 'joycall_nas_sync',
                    originalFileName: file,
                    contentHash: sha256,
                    fileSize: stats.size,
                    mimeType: file.endsWith('.mp3') ? 'audio/mpeg' : 'audio/wav',
                    storageKey: storageKey,
                    validationStatus: INTAKE_VALIDATION_STATUS.VALID,
                    receivedAt: stats.mtime.toISOString(),
                    callCategory: CALL_CATEGORY.UNKNOWN,
                    reviewStatus: REVIEW_STATUS.NOT_STARTED,
                    assignmentStatus: ASSIGNMENT_STATUS.UNASSIGNED
                });

                importedCount++;
            }

            res.json({
                success: true,
                message: `동기화 완료: ${importedCount}건 신규 수집, ${skippedCount}건 기존 중복 건너뜀.`,
                scanned: files.length,
                imported: importedCount,
                skipped: skippedCount
            });
        } catch (err) {
            console.error('Error during JoyCall sync:', err);
            res.status(500).json({ error: '조이콜 동기화 중 오류 발생: ' + err.message });
        }
    });

    // 8. POST /api/voice-calls/seed-samples - 파일럿 테스트용 샘플 녹음 데이터 주입 (운영환경 차단, 개발/테스트 관리자 전용)
    router.post('/seed-samples', requireAuth, async (req, res) => {
        try {
            // 1. Production environment check (Fail-closed: defaults to production if unset or empty)
            const currentEnv = process.env.NODE_ENV || 'production';
            if (currentEnv === 'production') {
                if (typeof auditLogger === 'function') {
                    auditLogger({
                        actorUserId: req.auth?.id || 'unknown',
                        action: 'VOICE_SEED_SAMPLES_BLOCKED',
                        result: 'DENIED',
                        reasonCode: 'PRODUCTION_ENVIRONMENT'
                    });
                }
                return res.status(403).json({
                    error: {
                        code: 'FORBIDDEN',
                        message: '운영 환경에서는 샘플 데이터를 생성할 수 없습니다.'
                    }
                });
            }

            // 2. Administrator role check in non-production environments
            if (!req.auth || req.auth.role !== 'admin') {
                if (typeof auditLogger === 'function') {
                    auditLogger({
                        actorUserId: req.auth?.id || 'unknown',
                        action: 'VOICE_SEED_SAMPLES_BLOCKED',
                        result: 'DENIED',
                        reasonCode: 'ADMIN_REQUIRED'
                    });
                }
                return res.status(403).json({
                    error: {
                        code: 'FORBIDDEN',
                        message: '관리자만 샘플 데이터를 생성할 수 있습니다.'
                    }
                });
            }

            const records = voiceCallRepository.list({ includeDeleted: false });
            if (records.length >= 3) {
                return res.json({
                    success: true,
                    message: `이미 ${records.length}건의 통화 녹음 데이터가 존재합니다.`,
                    count: records.length
                });
            }

            const now = Date.now();
            const samples = [
                {
                    originalFileName: '20260916_101230_01087654321.mp3',
                    callerPhoneNumber: '010-8765-4321',
                    clientName: '이영희',
                    fileSize: 2451200,
                    durationSeconds: 142,
                    receivedAt: new Date(now - 1000 * 60 * 35).toISOString(),
                    notes: '불안 증상 지속 관련 상담 전화 문의',
                    callRecordType: null, // 미분류
                    callCategory: CALL_CATEGORY.UNKNOWN,
                    assignedDepartmentId: '증진팀'
                },
                {
                    originalFileName: '20260916_105012_0316301234.mp3',
                    callerPhoneNumber: '031-630-1234',
                    clientName: '이천시청 복지정책과',
                    fileSize: 1124500,
                    durationSeconds: 65,
                    receivedAt: new Date(now - 1000 * 60 * 20).toISOString(),
                    notes: '2026년 하반기 보건복지 연계 사업 공문 수신 확인',
                    callRecordType: 'administrative_call', // 행정전화 분류 완료
                    callCategory: CALL_CATEGORY.ADMINISTRATIVE,
                    classificationStatus: 'classified',
                    classifiedByUserName: '시스템관리자',
                    assignedDepartmentId: '회복팀'
                },
                {
                    originalFileName: '20260916_113000_01023456789.mp3',
                    callerPhoneNumber: '010-2345-6789',
                    clientName: '김철수',
                    fileSize: 3584100,
                    durationSeconds: 210,
                    receivedAt: new Date(now - 1000 * 60 * 5).toISOString(),
                    notes: '우울감 심화 및 외래병원 연계 상담',
                    callRecordType: 'individual_counseling', // 개별상담 분류 완료
                    callCategory: CALL_CATEGORY.CLINICAL,
                    classificationStatus: 'classified',
                    classifiedByUserName: '김화자',
                    assignedDepartmentId: '증진팀',
                    assignedUserId: 'user_jin',
                    assignedUserName: '김화자-증진팀',
                    assignmentStatus: ASSIGNMENT_STATUS.ASSIGNED
                },
                {
                    originalFileName: '20260916_114520_01099887766.mp3',
                    callerPhoneNumber: '010-9988-7766',
                    clientName: '박지민',
                    fileSize: 1890000,
                    durationSeconds: 118,
                    receivedAt: new Date(now - 1000 * 60 * 2).toISOString(),
                    notes: '홈페이지 의뢰 신청 후 첫 확인 통화 (초기 접수)',
                    callRecordType: null, // 미분류
                    callCategory: CALL_CATEGORY.UNKNOWN
                }
            ];

            let createdCount = 0;
            for (const s of samples) {
                const fakeHash = crypto.createHash('sha256').update(s.originalFileName + now).digest('hex');
                await voiceCallRepository.create({
                    intakeSource: 'browser_upload',
                    originalFileName: s.originalFileName,
                    callerPhoneNumber: s.callerPhoneNumber,
                    clientName: s.clientName,
                    notes: s.notes,
                    contentHash: fakeHash,
                    fileSize: s.fileSize,
                    durationSeconds: s.durationSeconds,
                    mimeType: 'audio/mpeg',
                    storageKey: s.originalFileName,
                    validationStatus: INTAKE_VALIDATION_STATUS.VALID,
                    receivedAt: s.receivedAt,
                    callCategory: s.callCategory,
                    callRecordType: s.callRecordType,
                    classificationStatus: s.classificationStatus || 'pending',
                    classifiedByUserName: s.classifiedByUserName,
                    assignedDepartmentId: s.assignedDepartmentId,
                    assignedUserId: s.assignedUserId,
                    assignedUserName: s.assignedUserName,
                    assignmentStatus: s.assignmentStatus || ASSIGNMENT_STATUS.UNASSIGNED,
                    reviewStatus: REVIEW_STATUS.NOT_STARTED
                });
                createdCount++;
            }

            res.json({
                success: true,
                message: `파일럿 테스트용 샘플 통화 데이터 ${createdCount}건이 성공적으로 생성되었습니다.`,
                count: createdCount
            });
        } catch (err) {
            console.error('Error seeding sample calls:', err);
            res.status(500).json({ error: '샘플 통화 생성 실패: ' + err.message });
        }
    });

    // 9. POST /api/voice-calls/:id/analyze - AI 분석 실행 (VOICE_RECORDING_AI_ACCESS 전용 보호)
    router.post('/:id/analyze', voiceAiGuard, (req, res) => {
        try {
            const call = voiceCallRepository.findById(req.params.id);
            if (!call) {
                return res.status(404).json({ error: '통화 녹음 정보를 찾을 수 없습니다.' });
            }
            if (typeof auditLogger === 'function') {
                auditLogger({
                    actorUserId: req.auth?.id || 'unknown',
                    targetId: req.params.id,
                    action: 'VOICE_AI_ANALYSIS_STARTED',
                    result: 'SUCCESS'
                });
            }
            res.json({
                success: true,
                message: 'AI 분석 요청이 성공적으로 접수되었습니다.',
                callId: req.params.id,
                status: 'queued'
            });
        } catch (err) {
            res.status(500).json({ error: 'AI 분석 실행 실패: ' + err.message });
        }
    });

    // 10. GET /api/voice-calls/:id/analysis - AI 분석 결과 조회 (VOICE_RECORDING_AI_ACCESS 전용 보호)
    router.get('/:id/analysis', voiceAiGuard, (req, res) => {
        try {
            const call = voiceCallRepository.findById(req.params.id);
            if (!call) {
                return res.status(404).json({ error: '통화 녹음 정보를 찾을 수 없습니다.' });
            }
            if (typeof auditLogger === 'function') {
                auditLogger({
                    actorUserId: req.auth?.id || 'unknown',
                    targetId: req.params.id,
                    action: 'VOICE_AI_RESULT_VIEWED',
                    result: 'SUCCESS'
                });
            }
            res.json({
                success: true,
                callId: req.params.id,
                classification: call.callRecordType || call.callCategory || 'unknown',
                summary: call.notes || null,
                analyzedAt: call.updatedAt || call.receivedAt
            });
        } catch (err) {
            res.status(500).json({ error: 'AI 분석 결과 조회 실패: ' + err.message });
        }
    });

    // 11. GET /api/voice-calls/:id/analysis/download - AI 분석 결과 다운로드 (VOICE_RECORDING_AI_ACCESS 전용 보호)
    router.get('/:id/analysis/download', voiceAiGuard, (req, res) => {
        try {
            const call = voiceCallRepository.findById(req.params.id);
            if (!call) {
                return res.status(404).json({ error: '통화 녹음 정보를 찾을 수 없습니다.' });
            }
            if (typeof auditLogger === 'function') {
                auditLogger({
                    actorUserId: req.auth?.id || 'unknown',
                    targetId: req.params.id,
                    action: 'VOICE_AI_RESULT_DOWNLOADED',
                    result: 'SUCCESS'
                });
            }
            res.setHeader('Content-Type', 'application/json');
            res.setHeader('Content-Disposition', `attachment; filename="analysis_${req.params.id}.json"`);
            res.json({
                callId: req.params.id,
                classification: call.callRecordType || call.callCategory || 'unknown',
                summary: call.notes || null,
                analyzedAt: call.updatedAt || call.receivedAt
            });
        } catch (err) {
            res.status(500).json({ error: 'AI 분석 결과 다운로드 실패: ' + err.message });
        }
    });

    return router;
}
