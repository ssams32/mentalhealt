import React, { useState, useMemo } from 'react';
import { User as UserType } from '../../types';
import { getTeams } from '../../services/orgConfig';
import { AlertTriangle, Bell, User, Phone, Building2, ChevronRight, FileInput, Trash2, X } from 'lucide-react';

interface PendingReferral {
    id: string;
    name: string;
    phone?: string;
    gender?: string;
    age?: string | number;
    agency?: string;
    agencyPhone?: string;
    requesterName?: string;
    registrationDate?: string;
    problem?: string;
    reason?: string;
    createdAt: string;
    [key: string]: any;
}

interface ReferralInboxProps {
    pendingReferrals: PendingReferral[];
    onAccept: (referral: PendingReferral, team: string, assignee: string) => Promise<void>;
    onDismiss: (id: string) => void;
    onImport: (referral: PendingReferral) => void;
    users: { name: string; team: any }[];
}


const ReferralInbox: React.FC<ReferralInboxProps> = ({ pendingReferrals, onAccept, onDismiss, onImport, users }) => {
    const [expandedId, setExpandedId] = useState<string | null>(null);
    const [selectedTeam, setSelectedTeam] = useState<string>(() => getTeams()[0] || '');
    const [selectedAssignee, setSelectedAssignee] = useState('');
    const [isProcessing, setIsProcessing] = useState(false);

    // [Security & Channel Isolation Filter] Ensure only website referrals are shown, strictly exclude surveys/voice/spam
    const cleanReferrals = useMemo(() => {
        return (pendingReferrals || []).filter(p => {
            if (!p || typeof p !== 'object') return false;
            // Strictly exclude online surveys
            if (p.source === 'online_survey' || p.surveySubmissionId || p.submissionId || p.sourceSurveyId) return false;
            if (p.referralPath === '온라인설문' || p.requestAgency === '온라인 자가검진') return false;
            // Strictly exclude voice calls
            if (p.source === 'voice_call' || p.voiceCallId || p.referralPath === '음성통화' || p.referralPath === '음성접수') return false;
            // Exclude automated scanner probes or test spam
            if (/sparrow|dast|<script|alert\(/i.test(`${p.name} ${p.phone} ${p.problem} ${p.reason}`)) return false;
            // Explicit website channel requirement (fail-closed, externalIdx alone is not sufficient)
            const isExplicitWeb = p.source === 'website' || p.source === 'homepage' || p.source === 'web' ||
                p.referralPath === '홈페이지' || p.referralPath === '홈페이지 의뢰' || p.referralPath === '홈페이지 상담신청' ||
                p.requestAgency === '홈페이지' || p.isWebsiteReferral === true;
            return isExplicitWeb;
        });
    }, [pendingReferrals]);

    const handleAccept = async (referral: PendingReferral) => {
        if (!selectedAssignee) {
            alert('담당자를 선택해주세요.');
            return;
        }
        setIsProcessing(true);
        try {
            await onAccept(referral, selectedTeam, selectedAssignee);
            setExpandedId(null);
        } finally {
            setIsProcessing(false);
        }
    };

    const teamUsers = users.filter(u => u.team === selectedTeam);

    return (
        <div className={`rounded-3xl border-2 p-6 mb-6 shadow-lg ${cleanReferrals.length > 0
            ? 'bg-gradient-to-br from-amber-50 to-orange-50 border-amber-200'
            : 'bg-gradient-to-br from-slate-50 to-blue-50 border-slate-200'}`}>
            <div className="flex items-center gap-3 mb-4">
                <div className={`w-10 h-10 rounded-xl flex items-center justify-center shadow-lg ${cleanReferrals.length > 0 ? 'bg-amber-500 shadow-amber-200' : 'bg-slate-400 shadow-slate-200'
                    }`}>
                    {cleanReferrals.length > 0
                        ? <AlertTriangle className="text-white" size={20} />
                        : <Bell className="text-white" size={20} />
                    }
                </div>
                <div>
                    <h3 className={`text-lg font-black ${cleanReferrals.length > 0 ? 'text-amber-900' : 'text-slate-700'}`}>
                        알림 / 신규 의뢰
                    </h3>
                    <p className={`text-xs font-bold ${cleanReferrals.length > 0 ? 'text-amber-600' : 'text-slate-400'}`}>
                        {cleanReferrals.length > 0
                            ? `홈페이지에서 ${cleanReferrals.length}건의 새로운 의뢰가 도착했습니다.`
                            : '대기 중인 신규 의뢰가 없습니다.'
                        }
                    </p>
                </div>
            </div>

            <div className="space-y-3">
                {cleanReferrals.map((referral, index) => {
                    const itemKey = referral.id || referral.externalIdx || `pending_ref_${index}`;
                    return (
                        <div
                            key={itemKey}
                            className={`bg-white rounded-2xl border-2 transition-all duration-300 overflow-hidden ${expandedId === referral.id
                                ? 'border-amber-400 shadow-xl'
                                : 'border-amber-100 hover:border-amber-300 hover:shadow-md'
                                }`}
                        >
                        {/* Header */}
                        <div
                            className="p-4 cursor-pointer flex items-center justify-between"
                            onClick={() => setExpandedId(expandedId === referral.id ? null : referral.id)}
                        >
                            <div className="flex items-center gap-4">
                                <div className="w-12 h-12 bg-gradient-to-br from-amber-100 to-orange-100 rounded-xl flex items-center justify-center">
                                    <User className="text-amber-600" size={24} />
                                </div>
                                <div>
                                    <div className="flex items-center gap-2">
                                        <span className="text-lg font-black text-slate-900">{referral.name || '이름 미입력'}</span>
                                        <span className="text-xs font-bold text-slate-400">
                                            ({referral.gender || '성별미상'}{referral.age ? `, ${String(referral.age).replace('세', '')}세` : ''})
                                        </span>
                                    </div>
                                    <div className="flex items-center gap-3 text-xs font-bold text-slate-500">
                                        {referral.phone && <span className="flex items-center gap-1"><Phone size={10} />{referral.phone}</span>}
                                        {referral.agency && <span className="flex items-center gap-1"><Building2 size={10} />{referral.agency}</span>}
                                    </div>
                                </div>
                            </div>
                            <div className="flex items-center gap-3">
                                <span className="text-xs font-bold text-amber-600 bg-amber-50 px-3 py-1 rounded-full">
                                    {referral.registrationDate || new Date(referral.createdAt).toLocaleDateString('ko-KR')}
                                </span>
                                <ChevronRight className={`text-slate-400 transition-transform ${expandedId === referral.id ? 'rotate-90' : ''}`} size={20} />
                            </div>
                        </div>

                        {/* Expanded Content */}
                        {expandedId === referral.id && (
                            <div className="px-4 pb-4 border-t border-slate-100 animate-in slide-in-from-top-2 duration-200">
                                {/* Details */}
                                {referral.problem && (
                                    <div className="mt-3 p-3 bg-slate-50 rounded-xl">
                                        <span className="text-[10px] font-black text-slate-400 uppercase">주문제</span>
                                        <p className="text-xs font-bold text-slate-700 mt-1">{referral.problem}</p>
                                    </div>
                                )}
                                {referral.reason && (
                                    <div className="mt-2 p-3 bg-slate-50 rounded-xl max-h-32 overflow-y-auto">
                                        <span className="text-[10px] font-black text-slate-400 uppercase">의뢰 사유</span>
                                        <p className="text-xs font-bold text-slate-600 mt-1 whitespace-pre-wrap">{referral.reason}</p>
                                    </div>
                                )}

                                {/* Assignment Section Removed per user request */}

                                <div className="flex gap-2 mt-4">
                                    <button
                                        onClick={() => setExpandedId(null)}
                                        className="px-4 py-3 bg-slate-100 text-slate-500 rounded-xl font-black text-sm hover:bg-slate-200 transition-all flex items-center justify-center gap-2"
                                    >
                                        <X size={16} />
                                        나중에
                                    </button>
                                    <button
                                        onClick={() => onDismiss(referral.id)}
                                        className="px-4 py-3 bg-rose-50 text-rose-500 rounded-xl font-black text-sm hover:bg-rose-100 transition-all flex items-center justify-center gap-2"
                                    >
                                        <Trash2 size={16} />
                                        삭제
                                    </button>
                                    {Boolean(referral.source === 'registered' || referral.refNo || referral.referralId) ? (
                                        <button
                                            onClick={() => onImport({
                                                targetReferralId: referral.refNo || referral.referralId,
                                                source: 'registered',
                                                refNo: referral.refNo,
                                                referralId: referral.referralId
                                            })}
                                            className="flex-1 py-3 bg-slate-100 text-slate-700 hover:bg-slate-200 rounded-xl font-black text-sm transition-all flex items-center justify-center gap-2"
                                        >
                                            <FileInput size={16} />
                                            등록된 의뢰 보기
                                        </button>
                                    ) : (
                                        <button
                                            onClick={() => onImport(referral)}
                                            className="flex-1 py-3 bg-blue-500 text-white rounded-xl font-black text-sm shadow-lg shadow-blue-200 hover:bg-blue-600 transition-all flex items-center justify-center gap-2"
                                        >
                                            <FileInput size={16} />
                                            신규 의뢰 등록
                                        </button>
                                    )}
                                </div>
                            </div>
                        )}
                    </div>
                    );
                })}
            </div>
        </div >
    );
};

export default ReferralInbox;
