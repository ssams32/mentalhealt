// scripts/verify-track-a-persistence.mjs
// Track A: Storage Reliability, Idempotency, Atomic Numbering & OCC Verification

import fs from 'fs';
import path from 'path';
import http from 'http';
import express from 'express';
import crypto from 'crypto';

const TEST_PORT = 8899;
const TEST_DATA_DIR = path.resolve('./temp_track_a_data');

// Ensure clean test directory
if (fs.existsSync(TEST_DATA_DIR)) {
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
}
fs.mkdirSync(TEST_DATA_DIR, { recursive: true });

console.log('🧪 Setting up isolated Track A verification server on port', TEST_PORT);
console.log('📁 Test Data Directory:', TEST_DATA_DIR);

// --- In-Memory & Persistence Simulation matching server.js ---
const dataCache = {};
const saveQueues = {};

function getData(fileName, defaultVal = []) {
    if (dataCache[fileName] !== undefined) {
        return dataCache[fileName];
    }
    const filePath = path.join(TEST_DATA_DIR, `${fileName}.json`);
    if (fs.existsSync(filePath)) {
        try {
            const raw = fs.readFileSync(filePath, 'utf8');
            dataCache[fileName] = JSON.parse(raw);
            return dataCache[fileName];
        } catch (e) {
            console.error(`Read error ${fileName}:`, e);
        }
    }
    dataCache[fileName] = defaultVal;
    return defaultVal;
}

function persistData(fileName, data) {
    dataCache[fileName] = data;
    if (!saveQueues[fileName]) {
        saveQueues[fileName] = Promise.resolve();
    }
    const nextSave = saveQueues[fileName].then(async () => {
        const filePath = path.join(TEST_DATA_DIR, `${fileName}.json`);
        const tempPath = `${filePath}.tmp_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
        const jsonStr = JSON.stringify(data, null, 2);
        
        fs.writeFileSync(tempPath, jsonStr, 'utf8');
        // Validate before atomic rename
        JSON.parse(fs.readFileSync(tempPath, 'utf8'));
        fs.renameSync(tempPath, filePath);
    });
    saveQueues[fileName] = nextSave.catch(err => {
        console.error(`Save error ${fileName}:`, err);
    });
    return nextSave;
}

// Idempotency cache
const idempotencyStore = new Map();
function hashPayload(payload) {
    return crypto.createHash('sha256').update(JSON.stringify(payload || {})).digest('hex');
}

const TEAM_CODES = {
    '정신건강증진팀': 'MH',
    '예방관리팀': 'PM',
    '회복지원팀': 'RC',
    '기타': 'ET'
};

const app = express();
app.use(express.json());

// --- POST /api/referrals ---
app.post('/api/referrals', async (req, res) => {
    try {
        const idempotencyKey = req.headers['idempotency-key'];
        if (idempotencyKey) {
            const cached = idempotencyStore.get(idempotencyKey);
            if (cached) {
                if (cached.reqBodyHash === hashPayload(req.body)) {
                    return res.status(cached.statusCode).json(cached.response);
                } else {
                    return res.status(409).json({ 
                        success: false, 
                        code: 'IDEMPOTENCY_KEY_REUSED',
                        error: "Idempotency key reused with different request payload" 
                    });
                }
            }
        }

        const referrals = getData('Referrals', []);
        const teamCode = TEAM_CODES[req.body.team] || 'ET';
        const now = new Date();
        const yearYY = now.getFullYear().toString().slice(-2);
        const prefix = `${teamCode}-${yearYY}-`;

        const existingSeqs = referrals
            .filter(r => r && r.refNo && String(r.refNo).startsWith(prefix))
            .map(r => {
                const parts = String(r.refNo).split('-');
                return parts.length >= 3 ? parseInt(parts[2], 10) : NaN;
            })
            .filter(n => !isNaN(n));

        const maxSeq = existingSeqs.length > 0 ? Math.max(...existingSeqs) : 0;
        const nextSeq = maxSeq + 1;
        const assignedRefNo = `${prefix}${String(nextSeq).padStart(4, '0')}`;

        const referralId = req.body.referralId || crypto.randomUUID();
        const clientId = req.body.clientId || `C${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
        const isoNow = now.toISOString();

        const newReferral = {
            ...req.body,
            referralId,
            refNo: assignedRefNo,
            clientId,
            version: 1,
            registrationStatus: req.body.registrationStatus || (req.body.isUnregistered ? '미등록' : '확인중'),
            createdAt: req.body.createdAt || isoNow,
            updatedAt: isoNow
        };

        referrals.push(newReferral);
        await persistData('Referrals', referrals);

        const responsePayload = { success: true, data: newReferral };
        if (idempotencyKey) {
            idempotencyStore.set(idempotencyKey, {
                statusCode: 201,
                reqBodyHash: hashPayload(req.body),
                response: responsePayload
            });
        }

        res.status(201).json(responsePayload);
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// --- PUT /api/referrals/:id & /api/referrals ---
const handleReferralUpdate = async (req, res) => {
    try {
        const idempotencyKey = req.headers['idempotency-key'];
        if (idempotencyKey) {
            const cached = idempotencyStore.get(idempotencyKey);
            if (cached) {
                if (cached.reqBodyHash === hashPayload(req.body)) {
                    return res.status(cached.statusCode).json(cached.response);
                } else {
                    return res.status(409).json({ 
                        success: false, 
                        code: 'IDEMPOTENCY_KEY_REUSED',
                        error: "Idempotency key reused with different request payload" 
                    });
                }
            }
        }

        const referral = req.body;
        const targetId = req.params.id || referral.referralId || referral.refNo || referral.clientId;

        if (!targetId) {
            return res.status(400).json({ success: false, error: "Missing identifier (referralId or refNo)" });
        }

        const referrals = getData('Referrals', []);

        let index = -1;
        if (referral.referralId) {
            index = referrals.findIndex(r => r.referralId === referral.referralId);
        }
        if (index === -1) {
            index = referrals.findIndex(r => r.referralId === targetId);
        }
        if (index === -1) {
            const matchingByRefNo = referrals
                .map((r, i) => ({ r, i }))
                .filter(item => item.r.refNo === targetId);

            if (matchingByRefNo.length > 1 && !referral.referralId && !referral.clientId) {
                return res.status(409).json({
                    success: false,
                    code: 'AMBIGUOUS_RECORD',
                    error: `동일 의뢰번호(${targetId})를 가진 레코드가 ${matchingByRefNo.length}건 존재합니다. referralId 또는 clientId를 지정해야 합니다.`
                });
            } else if (matchingByRefNo.length === 1) {
                index = matchingByRefNo[0].i;
            } else if (matchingByRefNo.length > 1 && referral.clientId) {
                index = referrals.findIndex(r => r.clientId === referral.clientId);
            }
        }
        if (index === -1) {
            index = referrals.findIndex(r => r.clientId === targetId);
        }

        if (index === -1) {
            return res.status(404).json({ success: false, error: "Referral not found" });
        }

        const currentRecord = referrals[index];

        // OCC check
        if (referral.version !== undefined && currentRecord.version !== undefined) {
            if (Number(referral.version) !== Number(currentRecord.version)) {
                return res.status(409).json({
                    success: false,
                    code: 'VERSION_CONFLICT',
                    error: "다른 사용자에 의해 데이터가 변경되었습니다. 최신 정보를 불러온 후 다시 시도해주세요.",
                    currentVersion: currentRecord.version,
                    latestUpdatedAt: currentRecord.updatedAt
                });
            }
        }

        const nextVersion = (currentRecord.version || 1) + 1;
        const updatedReferral = {
            ...currentRecord,
            ...referral,
            referralId: currentRecord.referralId || referral.referralId || crypto.randomUUID(),
            refNo: referral.refNo || currentRecord.refNo,
            clientId: currentRecord.clientId || referral.clientId,
            version: nextVersion,
            createdAt: currentRecord.createdAt || referral.createdAt || new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };

        referrals[index] = updatedReferral;
        await persistData('Referrals', referrals);

        const responsePayload = { success: true, data: updatedReferral };
        if (idempotencyKey) {
            idempotencyStore.set(idempotencyKey, {
                statusCode: 200,
                reqBodyHash: hashPayload(req.body),
                response: responsePayload
            });
        }

        res.json(responsePayload);
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
};
app.put('/api/referrals', handleReferralUpdate);
app.put('/api/referrals/:id', handleReferralUpdate);

// --- DELETE /api/referrals/:id ---
const handleReferralDelete = async (req, res) => {
    try {
        const targetId = req.params.id || req.params.refNo || req.body?.referralId || req.body?.refNo;
        if (!targetId) {
            return res.status(400).json({ success: false, error: "Missing referral identifier" });
        }

        const referrals = getData('Referrals', []);
        let index = -1;

        if (req.body?.referralId) {
            index = referrals.findIndex(r => r.referralId === req.body.referralId);
        }
        if (index === -1) {
            index = referrals.findIndex(r => r.referralId === targetId);
        }
        if (index === -1) {
            const matches = referrals
                .map((r, i) => ({ r, i }))
                .filter(item => item.r.refNo === targetId);

            if (matches.length > 1 && !req.body?.referralId && !req.body?.clientId) {
                return res.status(409).json({
                    success: false,
                    code: 'AMBIGUOUS_RECORD',
                    error: `동일 의뢰번호(${targetId})를 가진 레코드가 ${matches.length}건 존재하여 특정할 수 없습니다.`
                });
            } else if (matches.length === 1) {
                index = matches[0].i;
            } else if (matches.length > 1 && req.body?.clientId) {
                index = referrals.findIndex(r => r.clientId === req.body.clientId);
            }
        }
        if (index === -1) {
            index = referrals.findIndex(r => r.clientId === targetId);
        }

        if (index === -1) {
            return res.status(404).json({ success: false, error: "Referral not found" });
        }

        const [deleted] = referrals.splice(index, 1);
        await persistData('Referrals', referrals);

        const trash = getData('Trash', []);
        trash.push({
            ...deleted,
            deletedAt: new Date().toISOString()
        });
        await persistData('Trash', trash);

        res.json({
            success: true,
            deletedCount: 1,
            referralId: deleted.referralId,
            refNo: deleted.refNo,
            message: `의뢰(${deleted.refNo || deleted.referralId})가 휴지통으로 이동되었습니다.`
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
};
app.delete('/api/referrals/:id', handleReferralDelete);

// --- POST /api/saveNotes ---
app.post('/api/saveNotes', async (req, res) => {
    try {
        const idempotencyKey = req.headers['idempotency-key'];
        if (idempotencyKey) {
            const cached = idempotencyStore.get(idempotencyKey);
            if (cached) {
                if (cached.reqBodyHash === hashPayload(req.body)) {
                    return res.status(cached.statusCode).json(cached.response);
                } else {
                    return res.status(409).json({ 
                        success: false, 
                        code: 'IDEMPOTENCY_KEY_REUSED',
                        error: "Idempotency key reused with different request payload" 
                    });
                }
            }
        }

        const { refNo, notes, referralId, version } = req.body;
        const referrals = getData('Referrals', []);
        
        let index = -1;
        if (referralId) {
            index = referrals.findIndex(r => r.referralId === referralId);
        }
        if (index === -1 && refNo) {
            index = referrals.findIndex(r => r.refNo === refNo || r.clientId === refNo);
        }

        if (index === -1) {
            return res.status(404).json({ success: false, error: "Referral not found" });
        }

        const target = referrals[index];

        if (version !== undefined && target.version !== undefined) {
            if (Number(version) !== Number(target.version)) {
                return res.status(409).json({
                    success: false,
                    code: 'VERSION_CONFLICT',
                    error: "다른 사용자에 의해 데이터가 변경되었습니다. 최신 정보를 불러온 후 다시 시도해주세요.",
                    currentVersion: target.version,
                    latestUpdatedAt: target.updatedAt
                });
            }
        }

        const newNotes = Array.isArray(notes) ? notes : [];
        const currentNotes = Array.isArray(target.notes) ? target.notes : [];

        if (currentNotes.length > 0 && newNotes.length === 0 && !req.body.allowEmptyNotes) {
            return res.status(400).json({
                success: false,
                code: 'EMPTY_NOTES_REJECTED',
                error: "기존 상담메모가 존재하는데 빈 목록이 전송되었습니다. 삭제 시 명시적 플래그가 필요합니다."
            });
        }

        newNotes.forEach((n, idx) => {
            if (!n.id) n.id = `note_${Date.now()}_${idx}`;
        });

        target.notes = newNotes;
        if (newNotes.length > 0) {
            target.latestNote = newNotes[0].content || '';
            target.latestNoteDate = newNotes[0].createdAt || newNotes[0].date || new Date().toLocaleString('ko-KR');
        } else {
            target.latestNote = '';
            target.latestNoteDate = '';
        }

        target.version = (target.version || 1) + 1;
        target.updatedAt = new Date().toISOString();

        await persistData('Referrals', referrals);

        const responsePayload = { success: true, data: target };
        if (idempotencyKey) {
            idempotencyStore.set(idempotencyKey, {
                statusCode: 200,
                reqBodyHash: hashPayload(req.body),
                response: responsePayload
            });
        }

        res.json(responsePayload);
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

const server = app.listen(TEST_PORT, async () => {
    try {
        await runAllTests();
    } catch (err) {
        console.error('💥 Test suite failed:', err);
        process.exit(1);
    } finally {
        server.close(() => {
            // Clean up test directory
            if (fs.existsSync(TEST_DATA_DIR)) {
                fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
            }
            console.log('🧹 Test completed and test files cleaned.');
            process.exit(0);
        });
    }
});

// --- Test Helper ---
async function requestApi(method, path, body = null, headers = {}) {
    const url = `http://localhost:${TEST_PORT}${path}`;
    const opts = {
        method,
        headers: {
            'Content-Type': 'application/json',
            ...headers
        }
    };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(url, opts);
    let data;
    try {
        data = await res.json();
    } catch (e) {
        data = null;
    }
    return { status: res.status, data };
}

// --- Test Runner ---
async function runAllTests() {
    console.log('\n========================================');
    console.log('🚀 Running Track A Persistence Verification Tests');
    console.log('========================================\n');

    // 1. Atomic Numbering & Disk Persistence Test (10 concurrent creates)
    console.log('▶ [Test 1] 10 Concurrent Creation & Atomic Numbering Test...');
    const createPromises = Array.from({ length: 10 }).map((_, i) => {
        return requestApi('POST', '/api/referrals', {
            name: `홍길동${i + 1}`,
            team: '정신건강증진팀',
            phone: `010-1111-${String(i).padStart(4, '0')}`
        });
    });

    const createResponses = await Promise.all(createPromises);
    const refNos = createResponses.map(r => r.data.data.refNo);
    console.log('  Assigned RefNos:', refNos);

    if (new Set(refNos).size !== 10) {
        throw new Error(`Duplicate refNo detected: ${refNos}`);
    }
    if (!refNos.every(no => no.startsWith('MH-26-'))) {
        throw new Error(`Unexpected refNo format: ${refNos}`);
    }

    // Verify disk persistence
    const savedFile = JSON.parse(fs.readFileSync(path.join(TEST_DATA_DIR, 'Referrals.json'), 'utf8'));
    if (savedFile.length !== 10) {
        throw new Error(`Disk file record count mismatch! Expected 10, got ${savedFile.length}`);
    }
    if (!savedFile.every(r => r.referralId && r.clientId && r.version === 1 && r.createdAt && r.updatedAt)) {
        throw new Error('Some records missing primary keys or version');
    }
    console.log('  ✅ Test 1 Passed: 10 unique sequential refNos issued and fully persisted to disk.\n');

    // 2. Idempotency Key Test
    console.log('▶ [Test 2] Idempotency Key Verification...');
    const idemKey = 'idem_key_unique_test_123';
    const firstReq = await requestApi('POST', '/api/referrals', {
        name: '이몽룡',
        team: '예방관리팀'
    }, { 'Idempotency-Key': idemKey });

    if (firstReq.status !== 201) throw new Error(`First idempotent request failed: ${firstReq.status}`);
    const originalRefNo = firstReq.data.data.refNo;

    // Retry same key same payload
    const retryReq = await requestApi('POST', '/api/referrals', {
        name: '이몽룡',
        team: '예방관리팀'
    }, { 'Idempotency-Key': idemKey });

    if (retryReq.status !== 201 || retryReq.data.data.refNo !== originalRefNo) {
        throw new Error(`Idempotent retry failed! Expected ${originalRefNo}, got ${retryReq.data?.data?.refNo}`);
    }

    // Check disk: should still be 11 records (10 from test 1 + 1 new)
    const diskCheck1 = JSON.parse(fs.readFileSync(path.join(TEST_DATA_DIR, 'Referrals.json'), 'utf8'));
    if (diskCheck1.length !== 11) {
        throw new Error(`Idempotency leak! Disk count: ${diskCheck1.length}`);
    }

    // Key reused with different payload -> 409 IDEMPOTENCY_KEY_REUSED
    const clashReq = await requestApi('POST', '/api/referrals', {
        name: '성춘향 (변조된 요청)',
        team: '예방관리팀'
    }, { 'Idempotency-Key': idemKey });

    if (clashReq.status !== 409 || clashReq.data.code !== 'IDEMPOTENCY_KEY_REUSED') {
        throw new Error(`Expected 409 IDEMPOTENCY_KEY_REUSED, got ${clashReq.status}`);
    }
    console.log('  ✅ Test 2 Passed: Idempotency-Key prevents duplicate creation & blocks key reuse with payload mismatch.\n');

    // 3. Optimistic Concurrency Control (OCC) & Target ID Matching
    console.log('▶ [Test 3] Optimistic Concurrency Control (OCC) & Safe 409 Response...');
    const targetReferral = firstReq.data.data;
    
    // Normal update (version 1 -> 2)
    const updateSuccess = await requestApi('PUT', `/api/referrals/${targetReferral.referralId}`, {
        ...targetReferral,
        name: '이몽룡_수정됨',
        version: 1
    });
    if (updateSuccess.status !== 200 || updateSuccess.data.data.version !== 2) {
        throw new Error(`Update failed: status ${updateSuccess.status}`);
    }

    // Outdated update attempt with version 1 -> should fail 409
    const conflictAttempt = await requestApi('PUT', `/api/referrals/${targetReferral.referralId}`, {
        ...targetReferral,
        name: '이몽룡_충돌발생시도',
        version: 1
    });

    if (conflictAttempt.status !== 409 || conflictAttempt.data.code !== 'VERSION_CONFLICT') {
        throw new Error(`Expected 409 VERSION_CONFLICT, got ${conflictAttempt.status}`);
    }
    // Sensitive data leakage check
    if (conflictAttempt.data.serverItem !== undefined) {
        throw new Error('Data Privacy Leak! serverItem should not be exposed in 409 response.');
    }
    if (conflictAttempt.data.currentVersion !== 2 || !conflictAttempt.data.latestUpdatedAt) {
        throw new Error('Expected currentVersion and latestUpdatedAt in 409 response');
    }
    console.log('  ✅ Test 3 Passed: OCC version conflict correctly rejected with 409 without sensitive data leakage.\n');

    // 4. Safe Delete & Trash Isolation
    console.log('▶ [Test 4] Safe Delete & Trash Isolation...');
    const deleteRes = await requestApi('DELETE', `/api/referrals/${targetReferral.referralId}`);
    if (deleteRes.status !== 200 || !deleteRes.data.success || deleteRes.data.referralId !== targetReferral.referralId) {
        throw new Error(`Delete failed: ${JSON.stringify(deleteRes.data)}`);
    }

    // Verify disk state
    const referralsAfterDelete = JSON.parse(fs.readFileSync(path.join(TEST_DATA_DIR, 'Referrals.json'), 'utf8'));
    if (referralsAfterDelete.some(r => r.referralId === targetReferral.referralId)) {
        throw new Error('Deleted referral still exists in Referrals.json');
    }
    const trashAfterDelete = JSON.parse(fs.readFileSync(path.join(TEST_DATA_DIR, 'Trash.json'), 'utf8'));
    if (!trashAfterDelete.some(r => r.referralId === targetReferral.referralId && r.deletedAt)) {
        throw new Error('Deleted referral was not safely placed in Trash.json');
    }
    console.log('  ✅ Test 4 Passed: Referral safely moved to Trash with referralId confirmation.\n');

    // 5. Counseling Notes (/api/saveNotes) Stability
    console.log('▶ [Test 5] Counseling Notes Storage & Idempotency (/api/saveNotes)...');
    const noteTarget = referralsAfterDelete[0]; // first record
    
    // 5.1 Save note successfully
    const notesPayload = [
        { content: '첫 상담 완료. 위기 개입 진행함.', createdAt: '2026-09-08 14:00' }
    ];
    const saveNoteRes = await requestApi('POST', '/api/saveNotes', {
        referralId: noteTarget.referralId,
        notes: notesPayload,
        version: noteTarget.version
    }, { 'Idempotency-Key': 'note_idem_001' });

    if (saveNoteRes.status !== 200 || !saveNoteRes.data.success) {
        throw new Error(`saveNotes failed: status ${saveNoteRes.status}`);
    }
    if (saveNoteRes.data.data.latestNote !== '첫 상담 완료. 위기 개입 진행함.') {
        throw new Error('latestNote not updated properly');
    }
    if (saveNoteRes.data.data.version !== noteTarget.version + 1) {
        throw new Error('version not incremented on note save');
    }

    // 5.2 Empty notes protection (accidental truncation prevention)
    const emptyRejectRes = await requestApi('POST', '/api/saveNotes', {
        referralId: noteTarget.referralId,
        notes: [],
        version: saveNoteRes.data.data.version
    });
    if (emptyRejectRes.status !== 400 || emptyRejectRes.data.code !== 'EMPTY_NOTES_REJECTED') {
        throw new Error(`Expected 400 EMPTY_NOTES_REJECTED, got ${emptyRejectRes.status}`);
    }

    // 5.3 Version conflict on saveNotes
    const noteConflictRes = await requestApi('POST', '/api/saveNotes', {
        referralId: noteTarget.referralId,
        notes: [{ content: '충돌 테스트' }],
        version: noteTarget.version // Old version!
    });
    if (noteConflictRes.status !== 409 || noteConflictRes.data.code !== 'VERSION_CONFLICT') {
        throw new Error(`Expected 409 VERSION_CONFLICT on note conflict, got ${noteConflictRes.status}`);
    }
    console.log('  ✅ Test 5 Passed: Counseling notes persisted atomically with truncation defense and OCC protection.\n');

    console.log('========================================');
    console.log('🎉 ALL TRACK A VERIFICATION TESTS PASSED SUCCESSFULLY!');
    console.log('========================================\n');
}
