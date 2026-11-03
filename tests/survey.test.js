/**
 * Survey module tests for deriveAgeBand, deriveScaleSeverities, and aggregateUnifiedSeverity
 * Run with: node --test tests/survey.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import XLSX from 'xlsx';

// Import backend router functions
import {
    deriveAgeBand,
    deriveAgeBandFromAge,
    deriveAgeBandFromBirthDate,
    deriveScaleSeverities
} from '../server/survey/surveyImportRouter.js';
import {
    SurveyExportService,
    extractScaleScore
} from '../server/survey/surveyExportService.js';

// Load frontend SurveyCharts module dynamically via typescript transpile
function loadSurveyChartsModule() {
    const filePath = path.resolve('components/survey/SurveyCharts.tsx');
    const source = fs.readFileSync(filePath, 'utf8');
    const { outputText } = ts.transpileModule(source, {
        compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2022,
            jsx: ts.JsxEmit.React
        }
    });
    const moduleExports = {};
    const moduleObj = { exports: moduleExports };
    const mockRequire = (id) => {
        if (id === 'react') return { default: { memo: fn => fn }, memo: fn => fn };
        return {};
    };
    const runner = new Function('require', 'exports', 'module', outputText);
    runner(mockRequire, moduleExports, moduleObj);
    return moduleExports;
}

const { aggregateUnifiedSeverity } = loadSurveyChartsModule();

// ============================================================
// 1. 연령 파생 (deriveAgeBand) 단위 테스트
// ============================================================
describe('deriveAgeBand', () => {
    it('demographics.age 숫자 우선', () => {
        const contact = { demographics: { age: 25 } };
        const identity = { demographics: { age: 30 } };
        assert.equal(deriveAgeBand(contact, identity, null), '20대');
    });

    it('demographics.age 숫자 문자열', () => {
        const contact = { demographics: { age: '25' } };
        const identity = { demographics: { age: 30 } };
        assert.equal(deriveAgeBand(contact, identity, null), '20대');
    });

    it('contact demographics.age가 identity보다 우선', () => {
        const contact = { demographics: { age: 25 } };
        const identity = { demographics: { age: 45 } };
        assert.equal(deriveAgeBand(contact, identity, null), '20대');
    });

    it('demographics.age 없으면 birthDate 폴백', () => {
        const contact = { birthDate: '1995-05-15' };
        const identity = {};
        const result = deriveAgeBand(contact, identity, 2026);
        assert.equal(result, '30대');
    });

    it('identity demographics.age 폴백', () => {
        const contact = {};
        const identity = { demographics: { age: 52 } };
        assert.equal(deriveAgeBand(contact, identity, null), '50대');
    });

    it('identity birthDate 폴백', () => {
        const contact = {};
        const identity = { birthDate: '1985-03-20' };
        assert.equal(deriveAgeBand(contact, identity, 2026), '40대');
    });

    it('둘 다 없으면 미상', () => {
        const contact = {};
        const identity = {};
        assert.equal(deriveAgeBand(contact, identity, null), '미상');
    });

    it('범위 밖(0)은 미상', () => {
        const contact = { demographics: { age: 0 } };
        const identity = {};
        assert.equal(deriveAgeBand(contact, identity, null), '미상');
    });

    it('범위 밖(131)은 미상', () => {
        const contact = { demographics: { age: 131 } };
        const identity = {};
        assert.equal(deriveAgeBand(contact, identity, null), '미상');
    });

    it('음수 나이는 미상', () => {
        const contact = { demographics: { age: -5 } };
        const identity = {};
        assert.equal(deriveAgeBand(contact, identity, null), '미상');
    });

    it('생년월일 단독 인자 호출(하위 호환) 지원', () => {
        assert.equal(deriveAgeBand('1960-01-01', 2026), '65세 이상');
    });
});

describe('deriveAgeBandFromAge', () => {
    it('10세 미만', () => assert.equal(deriveAgeBandFromAge(5), '10대 미만'));
    it('10대', () => assert.equal(deriveAgeBandFromAge(15), '10대'));
    it('20대', () => assert.equal(deriveAgeBandFromAge(25), '20대'));
    it('30대', () => assert.equal(deriveAgeBandFromAge(35), '30대'));
    it('40대', () => assert.equal(deriveAgeBandFromAge(45), '40대'));
    it('50대', () => assert.equal(deriveAgeBandFromAge(55), '50대'));
    it('60대', () => assert.equal(deriveAgeBandFromAge(62), '60대'));
    it('65세 이상', () => assert.equal(deriveAgeBandFromAge(70), '65세 이상'));
    it('경계값 9 -> 10대 미만', () => assert.equal(deriveAgeBandFromAge(9), '10대 미만'));
    it('경계값 10 -> 10대', () => assert.equal(deriveAgeBandFromAge(10), '10대'));
    it('경계값 19 -> 10대', () => assert.equal(deriveAgeBandFromAge(19), '10대'));
    it('경계값 20 -> 20대', () => assert.equal(deriveAgeBandFromAge(20), '20대'));
    it('경계값 64 -> 60대', () => assert.equal(deriveAgeBandFromAge(64), '60대'));
    it('경계값 65 -> 65세 이상', () => assert.equal(deriveAgeBandFromAge(65), '65세 이상'));
    it('경계값 130 -> 65세 이상', () => assert.equal(deriveAgeBandFromAge(130), '65세 이상'));
    it('경계값 131 -> 미상', () => assert.equal(deriveAgeBandFromAge(131), '미상'));
});

describe('deriveAgeBandFromBirthDate', () => {
    it('유효한 생년월일', () => {
        assert.equal(deriveAgeBandFromBirthDate('1995-05-15', 2026), '30대');
    });
    it('잘못된 형식', () => {
        assert.equal(deriveAgeBandFromBirthDate('invalid', 2026), '미상');
    });
    it('범위 밖 연도 (1800년대)', () => {
        assert.equal(deriveAgeBandFromBirthDate('1800-01-01', 2026), '미상');
    });
    it('미래 연도', () => {
        assert.equal(deriveAgeBandFromBirthDate('2030-01-01', 2026), '미상');
    });
});

// ============================================================
// 2. 척도별 파생 (deriveScaleSeverities) 단위 테스트
// ============================================================
describe('deriveScaleSeverities', () => {
    it('풀 scaleScores에서 5개 척도 추출', () => {
        const assessment = {
            scaleScores: {
                'phq-9': { label: '중등도 우울' },
                'gad-7': { label: '경미한 불안' },
                'bepsi-k': { label: '고스트레스군' },
                'sbq-r': { label: '중위험군' },
                'isi-k': { label: '경도 불면' }
            }
        };
        const result = deriveScaleSeverities(assessment);
        assert.deepEqual(result, {
            'phq-9': '중등도 우울',
            'gad-7': '경미한 불안',
            'bepsi-k': '고스트레스군',
            'sbq-r': '중위험군',
            'isi-k': '경도 불면'
        });
    });

    it('scales 폴백에서 5개 척도 추출', () => {
        const assessment = {
            scales: {
                'phq-9': { severity: '경도 우울' },
                'gad-7': { severity: '정상' },
                'bepsi-k': { resultLabel: '저스트레스군' },
                'sbq-r': { severity: '저위험군' },
                'isi-k': { severity: '정상' }
            }
        };
        const result = deriveScaleSeverities(assessment);
        assert.deepEqual(result, {
            'phq-9': '경도 우울',
            'gad-7': '정상',
            'bepsi-k': '저스트레스군',
            'sbq-r': '저위험군',
            'isi-k': '정상'
        });
    });

    it('scores 원형 폴백에서 5개 척도 추출', () => {
        const assessment = {
            scores: {
                'phq-9': { resultLabel: '중증 우울' },
                'gad-7': { severity: '중등도 불안' },
                'bepsi-k': { resultLabel: '고스트레스군' },
                'sbq-r': { totalScore: 8 },
                'isi-k': { severity: '중증 불면' }
            }
        };
        const result = deriveScaleSeverities(assessment);
        assert.deepEqual(result, {
            'phq-9': '중증 우울',
            'gad-7': '중등도 불안',
            'bepsi-k': '고스트레스군',
            'sbq-r': '고위험군',
            'isi-k': '중증 불면'
        });
    });

    it('일부만 있는 경우 있는 것만 반환 (값 지어내기 금지)', () => {
        const assessment = {
            scaleScores: {
                'phq-9': { label: '정상' },
                'gad-7': { label: '경도 불안' }
            }
        };
        const result = deriveScaleSeverities(assessment);
        assert.deepEqual(result, {
            'phq-9': '정상',
            'gad-7': '경도 불안'
        });
        assert.equal(result['bepsi-k'], undefined);
        assert.equal(result['sbq-r'], undefined);
        assert.equal(result['isi-k'], undefined);
    });

    it('데이터 없으면 빈 객체', () => {
        assert.deepEqual(deriveScaleSeverities(null), {});
        assert.deepEqual(deriveScaleSeverities({}), {});
        assert.deepEqual(deriveScaleSeverities({ scaleScores: {} }), {});
    });

    it('SBQ-R cutoff 7 점수 폴백 검증 (7 이상 고위험군, 7 미만 저위험군)', () => {
        const highRisk = {
            scaleScores: {
                'sbq-r': { totalScore: 7 }
            }
        };
        assert.equal(deriveScaleSeverities(highRisk)['sbq-r'], '고위험군');

        const lowRisk = {
            scaleScores: {
                'sbq-r': { totalScore: 6 }
            }
        };
        assert.equal(deriveScaleSeverities(lowRisk)['sbq-r'], '저위험군');
    });
});

// ============================================================
// 3. 차트 집계 (aggregateUnifiedSeverity) 단위 테스트
// ============================================================
describe('aggregateUnifiedSeverity', () => {
    it('개별 척도(phq-9 등)의 동작은 unchanged 유지', () => {
        const items = [
            {
                submissionId: 'sub-single-01',
                assessmentId: 'phq-9',
                severity: '중등도 우울'
            }
        ];
        const res = aggregateUnifiedSeverity(items);
        const phqRow = res.find(r => r.testId === 'phq-9');
        assert.equal(phqRow.total, 1);
        const gradeObj = phqRow.grades.find(g => g.grade === '중등도 우울');
        assert.equal(gradeObj.count, 1);

        // 다른 4개 척도는 0건이어야 함
        const otherRows = res.filter(r => r.testId !== 'phq-9');
        otherRows.forEach(row => {
            assert.equal(row.total, 0);
        });
    });

    it('종합검진 풀 scaleScores -> 5행 분리 집계', () => {
        const items = [
            {
                submissionId: 'sub-multi-01',
                assessmentId: 'icheon-screening-23',
                severity: '종합검진',
                scaleSeverities: {
                    'phq-9': '경도 우울',
                    'gad-7': '경미한 불안',
                    'bepsi-k': '고스트레스군',
                    'sbq-r': '중위험군',
                    'isi-k': '경도 불면'
                }
            }
        ];
        const res = aggregateUnifiedSeverity(items);

        // 5개 모든 행의 total이 1이어야 함
        res.forEach(row => {
            assert.equal(row.total, 1, `testId ${row.testId} total must be 1`);
        });

        // 각 행의 해당 등급 카운트 확인
        const phqRow = res.find(r => r.testId === 'phq-9');
        assert.equal(phqRow.grades.find(g => g.grade === '경도 우울').count, 1);

        const gadRow = res.find(r => r.testId === 'gad-7');
        // SEVERITY_MAP maps '경미한 불안' to '경도 불안'
        assert.equal(gadRow.grades.find(g => g.grade === '경도 불안').count, 1);

        const bepsiRow = res.find(r => r.testId === 'bepsi-k');
        assert.equal(bepsiRow.grades.find(g => g.grade === '고스트레스군').count, 1);

        const sbqRow = res.find(r => r.testId === 'sbq-r');
        assert.equal(sbqRow.grades.find(g => g.grade === '중위험군').count, 1);

        const isiRow = res.find(r => r.testId === 'isi-k');
        assert.equal(isiRow.grades.find(g => g.grade === '경도 불면').count, 1);
    });

    it('scaleScores 없음(구 종합검진 기록) -> 5행 미집계 (total 0)', () => {
        const items = [
            {
                submissionId: 'sub-legacy-01',
                assessmentId: 'icheon-screening-23',
                severity: '종합검진',
                scaleSeverities: null
            },
            {
                submissionId: 'sub-legacy-02',
                assessmentId: 'icheon-screening-23',
                severity: '종합검진',
                scaleSeverities: {}
            }
        ];
        const res = aggregateUnifiedSeverity(items);
        res.forEach(row => {
            assert.equal(row.total, 0, `legacy item must not be aggregated: ${row.testId}`);
        });
    });

    it('contact-only(상담신청, 검사없음)는 집계에서 제외', () => {
        const items = [
            {
                submissionId: 'sub-contact-only-01',
                assessmentId: 'contact-only',
                contactOnly: true,
                severity: null
            }
        ];
        const res = aggregateUnifiedSeverity(items);
        res.forEach(row => {
            assert.equal(row.total, 0, `contact-only must be excluded: ${row.testId}`);
        });
    });

    it('전체 판정 복사 없음: 5행이 동일 라벨로 채워지지 않음을 단언', () => {
        const items = [
            {
                submissionId: 'sub-multi-distinct',
                assessmentId: 'icheon-screening-23',
                severity: '고위험군', // 단일 전체 위험판정
                scaleSeverities: {
                    'phq-9': '정상',
                    'gad-7': '경도 불안',
                    'bepsi-k': '저스트레스군',
                    'sbq-r': '고위험군',
                    'isi-k': '정상'
                }
            }
        ];
        const res = aggregateUnifiedSeverity(items);

        // phq-9는 '정상'이어야 하며 전체 판정 '고위험군'이 복사되지 않아야 함
        const phqRow = res.find(r => r.testId === 'phq-9');
        assert.equal(phqRow.grades.find(g => g.grade === '정상').count, 1);
        const phqHighRisk = phqRow.grades.find(g => g.grade === '고위험군' || g.grade === '중증 우울');
        assert.equal(phqHighRisk ? phqHighRisk.count : 0, 0);

        // 5개 행의 활성 등급 라벨들이 전부 동일하지 않음을 단언
        const activeGrades = res.map(row => {
            const active = row.grades.find(g => g.count > 0);
            return active ? active.grade : null;
        });
        const uniqueActiveGrades = new Set(activeGrades);
        assert.ok(uniqueActiveGrades.size > 1, '5개 행의 등급 라벨이 동일하게 복사되지 않아야 함');
    });
});

// ============================================================
// 6. 엑셀 내보내기 척도 점수 표시 (SurveyExportService) 단위 테스트
// ============================================================
describe('SurveyExportService - 엑셀 내보내기 척도 점수 표시', () => {
    const exportService = new SurveyExportService();

    function parseExportSheet(buffer) {
        const wb = (XLSX.default || XLSX).read(buffer, { type: 'buffer' });
        const sheet = wb.Sheets[wb.SheetNames[0]];
        const rawRows = (XLSX.default?.utils || XLSX.utils).sheet_to_json(sheet, { header: 1 });
        return rawRows.map(row =>
            row.map(val => (typeof val === 'string' && val.startsWith("'") ? val.slice(1) : val))
        );
    }

    it('종합검진 풀 숫자 scaleScores -> 5개 컬럼 전부 숫자 점수', () => {
        const records = [
            {
                submissionId: 'sub-comp-full',
                assessmentId: 'icheon-screening-23',
                submittedAt: '2026-03-01T10:00:00.000Z',
                contact: { clientName: '홍길동', phone: '010-1234-5678' },
                assessment: {
                    totalScore: 0,
                    severity: '종합검진',
                    scaleScores: {
                        'phq-9': { totalScore: 12, severity: '중등도 우울' },
                        'gad-7': { totalScore: 8, severity: '경도 불안' },
                        'isi-k': { totalScore: 10, severity: '중등도 불면' },
                        'bepsi-k': { meanScore: 2.80, responseSum: 14, severity: '고스트레스군' },
                        'sbq-r': { totalScore: 7, severity: '중위험군' }
                    }
                }
            }
        ];

        const { buffer } = exportService.generateExcelBuffer(records);
        const rows = parseExportSheet(buffer);

        // Header verification
        assert.deepEqual(rows[0], [
            '이름', '연락처', '우울(PHQ-9)', '불안(GAD-7)', '수면(ISI-K)', '스트레스(BEPSI-K)', '자살위험(SBQ-R)'
        ]);

        const dataRow = rows[1];
        assert.equal(dataRow[0], '홍*동');
        assert.equal(dataRow[1], '010-****-5678');
        assert.equal(dataRow[2], '12'); // PHQ-9
        assert.equal(dataRow[3], '8');  // GAD-7
        assert.equal(dataRow[4], '10'); // ISI-K
        assert.equal(dataRow[5], '2.8'); // BEPSI-K
        assert.equal(dataRow[6], '7');  // SBQ-R

        // All 5 score columns must be numeric
        [2, 3, 4, 5, 6].forEach(colIdx => {
            assert.notEqual(dataRow[colIdx], '-');
            assert.ok(!Number.isNaN(Number(dataRow[colIdx])));
        });
    });

    it('일부 척도만 있음 -> 있는 컬럼만 점수, 나머지는 \'-\'', () => {
        const records = [
            {
                submissionId: 'sub-comp-partial',
                assessmentId: 'icheon-screening-23',
                submittedAt: '2026-03-01T10:00:00.000Z',
                contact: { clientName: '김철수', phone: '010-2222-3333' },
                assessment: {
                    totalScore: 0,
                    scaleScores: {
                        'phq-9': { totalScore: 5 },
                        'gad-7': { totalScore: 3 }
                    }
                }
            }
        ];

        const { buffer } = exportService.generateExcelBuffer(records);
        const rows = parseExportSheet(buffer);
        const dataRow = rows[1];

        assert.equal(dataRow[2], '5'); // PHQ-9
        assert.equal(dataRow[3], '3'); // GAD-7
        assert.equal(dataRow[4], '-'); // ISI-K
        assert.equal(dataRow[5], '-'); // BEPSI-K
        assert.equal(dataRow[6], '-'); // SBQ-R
    });

    it('scaleScores 없음 -> 5개 컬럼 전부 \'-\' (전체 총점이 있어도 복사하지 않음을 단언)', () => {
        const records = [
            {
                submissionId: 'sub-comp-no-scales',
                assessmentId: 'icheon-screening-23',
                submittedAt: '2026-03-01T10:00:00.000Z',
                contact: { clientName: '이영희', phone: '010-4444-5555' },
                assessment: {
                    totalScore: 45,
                    severity: '고위험군'
                }
            }
        ];

        const { buffer } = exportService.generateExcelBuffer(records);
        const rows = parseExportSheet(buffer);
        const dataRow = rows[1];

        // 5개 컬럼 전부 '-'이어야 하며 종합검진 전체 totalScore(45)가 복사되지 않아야 함
        [2, 3, 4, 5, 6].forEach(colIdx => {
            assert.equal(dataRow[colIdx], '-');
            assert.notEqual(dataRow[colIdx], '45');
        });
    });

    it('개별 척도 기록 -> 기존 동작 unchanged (직접 totalScore)', () => {
        const records = [
            {
                submissionId: 'sub-indiv-phq',
                assessmentId: 'phq-9',
                submittedAt: '2026-03-01T10:00:00.000Z',
                contact: { clientName: '박민수', phone: '010-6666-7777' },
                assessment: {
                    totalScore: 15,
                    severity: '중등도 우울'
                }
            }
        ];

        const { buffer } = exportService.generateExcelBuffer(records);
        const rows = parseExportSheet(buffer);
        const dataRow = rows[1];

        assert.equal(dataRow[2], '15'); // PHQ-9
        assert.equal(dataRow[3], '-');  // GAD-7
        assert.equal(dataRow[4], '-');  // ISI-K
        assert.equal(dataRow[5], '-');  // BEPSI-K
        assert.equal(dataRow[6], '-');  // SBQ-R
    });

    it('최신 우선: 최신 개별 vs 구 종합검진 -> 개별 승리', () => {
        const records = [
            {
                submissionId: 'sub-comp-older',
                assessmentId: 'icheon-screening-23',
                submittedAt: '2026-03-01T10:00:00.000Z',
                contact: { clientName: '최신우선A', phone: '010-8888-0001' },
                assessment: {
                    scaleScores: {
                        'phq-9': { totalScore: 5 },
                        'gad-7': { totalScore: 10 }
                    }
                }
            },
            {
                submissionId: 'sub-indiv-newer',
                assessmentId: 'phq-9',
                submittedAt: '2026-03-02T10:00:00.000Z',
                contact: { clientName: '최신우선A', phone: '010-8888-0001' },
                assessment: {
                    totalScore: 18
                }
            }
        ];

        const { buffer } = exportService.generateExcelBuffer(records);
        const rows = parseExportSheet(buffer);
        const dataRow = rows[1];

        // PHQ-9: 최신 개별(18)이 구 종합검진(5)보다 우선
        assert.equal(dataRow[2], '18');
        // GAD-7: 구 종합검진(10)에서 매칭 유지
        assert.equal(dataRow[3], '10');
    });

    it('최신 우선: 최신 종합검진 vs 구 개별 -> 종합검진 승리', () => {
        const records = [
            {
                submissionId: 'sub-indiv-older',
                assessmentId: 'phq-9',
                submittedAt: '2026-03-01T10:00:00.000Z',
                contact: { clientName: '최신우선B', phone: '010-8888-0002' },
                assessment: {
                    totalScore: 18
                }
            },
            {
                submissionId: 'sub-comp-newer',
                assessmentId: 'icheon-screening-23',
                submittedAt: '2026-03-02T10:00:00.000Z',
                contact: { clientName: '최신우선B', phone: '010-8888-0002' },
                assessment: {
                    scaleScores: {
                        'phq-9': { totalScore: 6 }
                    }
                }
            }
        ];

        const { buffer } = exportService.generateExcelBuffer(records);
        const rows = parseExportSheet(buffer);
        const dataRow = rows[1];

        // PHQ-9: 최신 종합검진(6)이 구 개별(18)보다 우선
        assert.equal(dataRow[2], '6');
    });

    it('BEPSI-K는 meanScore가 나오는지 단언', () => {
        const records = [
            {
                submissionId: 'sub-bepsi-mean',
                assessmentId: 'icheon-screening-23',
                submittedAt: '2026-03-01T10:00:00.000Z',
                contact: { clientName: '정수진', phone: '010-9999-1111' },
                assessment: {
                    scaleScores: {
                        'bepsi-k': { meanScore: 1.40, responseSum: 7 }
                    }
                }
            }
        ];

        const { buffer } = exportService.generateExcelBuffer(records);
        const rows = parseExportSheet(buffer);
        const dataRow = rows[1];

        // BEPSI-K는 canonical에 totalScore가 없고 meanScore(1.40)가 나옴
        assert.equal(Number(dataRow[5]), 1.4);
    });

    it('라벨-only 척도는 \'-\' 단언', () => {
        const records = [
            {
                submissionId: 'sub-label-only',
                assessmentId: 'icheon-screening-23',
                submittedAt: '2026-03-01T10:00:00.000Z',
                contact: { clientName: '강태양', phone: '010-9999-2222' },
                assessment: {
                    scaleScores: {
                        'phq-9': { label: '경도 우울' },
                        'gad-7': { label: '경미한 불안' },
                        'isi-k': { label: '경도 불면' },
                        'bepsi-k': { label: '고스트레스군' },
                        'sbq-r': { label: '중위험군' }
                    }
                }
            }
        ];

        const { buffer } = exportService.generateExcelBuffer(records);
        const rows = parseExportSheet(buffer);
        const dataRow = rows[1];

        // 숫자가 없으므로 임의 추정 없이 fail-closed로 '-' 유지
        [2, 3, 4, 5, 6].forEach(colIdx => {
            assert.equal(dataRow[colIdx], '-');
        });
    });

    it('extractScaleScore: scales / scores 폴백 및 별칭 지원', () => {
        // scales 폴백
        const assessmentScales = {
            scales: {
                phq9: { totalScore: 11 },
                gad7: { totalScore: 9 },
                isik: { totalScore: 13 },
                bepsik: { meanScore: 2.2 },
                sbqr: { totalScore: 8 }
            }
        };
        assert.equal(extractScaleScore(assessmentScales, 'phq-9'), 11);
        assert.equal(extractScaleScore(assessmentScales, 'gad-7'), 9);
        assert.equal(extractScaleScore(assessmentScales, 'isi-k'), 13);
        assert.equal(extractScaleScore(assessmentScales, 'bepsi-k'), 2.2);
        assert.equal(extractScaleScore(assessmentScales, 'sbq-r'), 8);

        // scores 원형 폴백
        const assessmentScores = {
            scores: {
                phq: 14,
                gad: 12,
                isi: 7,
                bepsi: { meanScore: 1.8 },
                sbqr: { totalScore: 6 }
            }
        };
        assert.equal(extractScaleScore(assessmentScores, 'phq-9'), 14);
        assert.equal(extractScaleScore(assessmentScores, 'gad-7'), 12);
        assert.equal(extractScaleScore(assessmentScores, 'isi-k'), 7);
        assert.equal(extractScaleScore(assessmentScores, 'bepsi-k'), 1.8);
        assert.equal(extractScaleScore(assessmentScores, 'sbq-r'), 6);
    });
});
