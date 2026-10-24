
import React, { useState, useMemo } from 'react';
import { User, Log, Permission, AnyLog, Team } from '../../types';
import PageContainer from '../layout/PageContainer';
import { getTeams, getTeamsConfig } from '../../services/orgConfig';
import OrgSettingsPanel from '../setup/OrgSettingsPanel';
import { apiClient } from '../../services/apiClient';
import * as XLSX from 'xlsx';

declare var _: any;
declare const google: any;

interface AccountsPageProps {
    users: User[];
    setUsers: React.Dispatch<React.SetStateAction<User[]>>;
    logs: AnyLog[];
    currentUser: User;
    onForceLogout: () => void;
    showToast: (msg: string) => void;
}

const USER_EXCEL_HEADERS: Record<string, string> = {
    id: '아이디',
    name: '이름',
    password: '비밀번호',
    team: '소속팀',
    role: '권한',
    status: '상태'
};

const AccountsPage: React.FC<AccountsPageProps> = ({ users, setUsers, logs, currentUser, onForceLogout, showToast }) => {
    const [activeTab, setActiveTab] = useState<'users' | 'activity' | 'org'>('users');
    const [isAddModalOpen, setIsAddModalOpen] = useState(false);
    const [isEditModalOpen, setIsEditModalOpen] = useState(false);
    const [editingUser, setEditingUser] = useState<User | null>(null);
    const [newUser, setNewUser] = useState<Partial<User>>({ role: 'user', status: 'active', team: (getTeams()[0] || '') as Team });
    const [addUserError, setAddUserError] = useState('');
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [isImporting, setIsImporting] = useState(false);
    const [updatingPerm, setUpdatingPerm] = useState<{ userId: string; permKey: 'online_survey' | 'voice_ai' } | null>(null);
    const [permissionFilter, setPermissionFilter] = useState<'all' | 'survey' | 'voice' | 'unassigned' | 'inactive'>('all');
    const [searchQuery, setSearchQuery] = useState('');

    // 서버 판정(server/permissions/voiceCapabilities.js의 isPermissionFlagGranted)과 동일한 규칙.
    // boolean true 외에 'true'/'TRUE'/'1'/1 같은 명시적 true 표현만 ON으로 인정하고,
    // 'false' 문자열처럼 truthy이지만 실제로는 미부여인 값을 ON으로 잘못 표시하지 않는다.
    const isPermissionFlagGranted = (value: any): boolean => {
        if (value === true || value === 1) return true;
        if (typeof value === 'string') {
            const normalized = value.trim().toLowerCase();
            return normalized === 'true' || normalized === '1';
        }
        return false;
    };

    const checkHasSurveyAccess = (u: User) => {
        return Array.isArray(u.permissions)
            ? u.permissions.includes('ONLINE_SURVEY_ACCESS')
            : isPermissionFlagGranted((u.permissions as any)?.ONLINE_SURVEY_ACCESS);
    };

    const checkHasVoiceAccess = (u: User) => {
        return Array.isArray(u.permissions)
            ? u.permissions.includes('VOICE_RECORDING_AI_ACCESS') || u.permissions.includes('voiceCalls')
            : Boolean((u.permissions as any)?.VOICE_RECORDING_AI_ACCESS || (u.permissions as any)?.voiceCalls);
    };

    const checkHasSurveyAssignmentAccess = (u: User) => {
        if (!u.permissions) return false;
        return Array.isArray(u.permissions)
            ? (u.permissions as any).includes('SURVEY_ASSIGNMENT_ACCESS')
            : isPermissionFlagGranted((u.permissions as any)?.SURVEY_ASSIGNMENT_ACCESS);
    };

    const handleToggleOnlineSurveyAccess = async (user: User) => {
        if (currentUser.role !== 'admin') return;
        if (updatingPerm?.userId === user.id && updatingPerm?.permKey === 'online_survey') return;
        if (user.status !== 'active') {
            alert('비활성 또는 정지된 사용자에게는 권한을 부여할 수 없습니다.');
            return;
        }

        const currentAccess = checkHasSurveyAccess(user);
        const nextGranted = !currentAccess;
        const confirmMessage = nextGranted
            ? `'${user.name}'(${user.id}) 사용자에게 온라인 설문 조회 및 처리 권한을 부여할까요?\n부여하면 온라인 설문 담당자 배정 대상에도 포함됩니다.`
            : `'${user.name}'(${user.id}) 사용자의 온라인 설문 조회 및 처리 권한을 회수할까요?\n회수하면 온라인 설문 담당자 배정 대상에서도 제외됩니다.`;

        if (!window.confirm(confirmMessage)) return;

        setUpdatingPerm({ userId: user.id, permKey: 'online_survey' });
        try {
            const res = await apiClient.patchOnlineSurveyAccess(user.id, nextGranted);
            if (res && res.success) {
                setUsers(prev => prev.map(u => {
                    if (u.id !== user.id) return u;
                    return {
                        ...u,
                        permissions: res.user?.permissions || (
                            Array.isArray(u.permissions)
                                ? (nextGranted ? [...u.permissions.filter(p => p !== 'ONLINE_SURVEY_ACCESS'), 'ONLINE_SURVEY_ACCESS'] : u.permissions.filter(p => p !== 'ONLINE_SURVEY_ACCESS'))
                                : { ...(u.permissions || {}), ONLINE_SURVEY_ACCESS: nextGranted }
                        )
                    };
                }));
                showToast?.(res.message || '온라인 설문 사용 권한이 변경되었습니다.');
            } else {
                alert(res?.error?.message || res?.error || '권한 변경에 실패했습니다.');
            }
        } catch (err: any) {
            console.error('Error toggling online survey permission:', err);
            alert(err.message || '권한 변경 중 통신 오류가 발생했습니다.');
        } finally {
            setUpdatingPerm(null);
        }
    };

    const handleToggleVoiceAccess = async (user: User) => {
        if (currentUser.role !== 'admin') return;
        if (updatingPerm?.userId === user.id && updatingPerm?.permKey === 'voice_ai') return;
        if (user.status !== 'active') {
            alert('비활성 또는 정지된 사용자에게는 권한을 부여할 수 없습니다.');
            return;
        }

        const currentAccess = checkHasVoiceAccess(user);
        const nextGranted = !currentAccess;
        const confirmMessage = nextGranted
            ? `'${user.name}'(${user.id}) 사용자에게 음성 녹음 분석(AI) 사용 권한을 부여할까요?`
            : `'${user.name}'(${user.id}) 사용자의 음성 녹음 분석(AI) 사용 권한을 회수할까요?`;

        if (!window.confirm(confirmMessage)) return;

        setUpdatingPerm({ userId: user.id, permKey: 'voice_ai' });
        try {
            const res = await apiClient.patchVoiceAccess(user.id, nextGranted);
            if (res && res.success) {
                setUsers(prev => prev.map(u => {
                    if (u.id !== user.id) return u;
                    return {
                        ...u,
                        permissions: res.user?.permissions || (
                            Array.isArray(u.permissions)
                                ? (nextGranted ? [...u.permissions.filter(p => p !== 'VOICE_RECORDING_AI_ACCESS'), 'VOICE_RECORDING_AI_ACCESS'] : u.permissions.filter(p => p !== 'VOICE_RECORDING_AI_ACCESS' && p !== 'voiceCalls'))
                                : { ...(u.permissions || {}), VOICE_RECORDING_AI_ACCESS: nextGranted, voiceCalls: nextGranted }
                        )
                    };
                }));
                showToast?.(res.message || '음성 녹음 분석(AI) 권한이 변경되었습니다.');
            } else {
                alert(res?.error?.message || res?.error || '권한 변경에 실패했습니다.');
            }
        } catch (err: any) {
            console.error('Error toggling voice AI permission:', err);
            alert(err.message || '권한 변경 중 통신 오류가 발생했습니다.');
        } finally {
            setUpdatingPerm(null);
        }
    };

    const filteredUsers = useMemo(() => {
        return users.filter(u => {
            if (searchQuery.trim()) {
                const query = searchQuery.trim().toLowerCase();
                const matchName = u.name?.toLowerCase().includes(query);
                const matchId = u.id?.toLowerCase().includes(query);
                const matchTeam = u.team?.toLowerCase().includes(query);
                if (!matchName && !matchId && !matchTeam) return false;
            }

            if (permissionFilter === 'inactive') {
                return u.status !== 'active';
            }
            if (permissionFilter === 'survey') {
                return u.status === 'active' && (u.role === 'admin' || checkHasSurveyAccess(u));
            }
            if (permissionFilter === 'voice') {
                return u.status === 'active' && (u.role === 'admin' || checkHasVoiceAccess(u));
            }
            if (permissionFilter === 'unassigned') {
                return u.status === 'active' && u.role !== 'admin' && !checkHasSurveyAccess(u) && !checkHasVoiceAccess(u);
            }
            return true;
        });
    }, [users, searchQuery, permissionFilter]);

    const permissionSummary = useMemo(() => {
        const activeUsers = users.filter(u => u.status === 'active');
        const surveyCount = activeUsers.filter(u => u.role === 'admin' || checkHasSurveyAccess(u)).length;
        const voiceCount = activeUsers.filter(u => u.role === 'admin' || checkHasVoiceAccess(u)).length;
        return {
            totalActive: activeUsers.length,
            surveyCount,
            voiceCount
        };
    }, [users]);

    const sessionLogs = useMemo(() => logs.filter(l => l.loginTime && !l.action).sort((a, b) => new Date(b.loginTime).getTime() - new Date(a.loginTime).getTime()), [logs]);
    const activityLogs = useMemo(() => logs.filter(l => l.action).sort((a, b) => {
        const timeA = a.timestamp || a.loginTime || 0;
        const timeB = b.timestamp || b.loginTime || 0;
        return new Date(timeB).getTime() - new Date(timeA).getTime();
    }), [logs]);

    const handleOpenAddModal = () => {
        setNewUser({ role: 'user', status: 'active', team: (getTeams()[0] || '') as Team });
        setAddUserError('');
        setIsAddModalOpen(true);
    };
    const handleCloseAddModal = () => setIsAddModalOpen(false);

    const handleOpenEditModal = (user: User) => {
        const userToEdit = { ...user };
        if (!userToEdit.permissions) {
            userToEdit.permissions = {
                referrals: { read: user.role !== 'user', write: user.role !== 'user', delete: user.role === 'admin' },
                suicideAttempters: { read: true, write: true, delete: user.role === 'admin' },
                caseAnalysis: { read: true, write: true, delete: false },
                data: { read: true, write: true, delete: false },
                reports: { read: true, write: false, delete: false },
                budget: { read: true, write: false, delete: false },
                accounts: { read: false, write: false, delete: false },
            } as Permission;
        }

        const disposalLog = logs.find(l =>
            l.userId === user.id &&
            ((l as any).action === 'ASSET_DISPOSE' || (l as any).details?.includes('폐기'))
        );

        if (disposalLog) {
            alert(`⚠️ [경고] 해당 사용자(${user.name})는 최근 할당된 자산이 폐기되었습니다. 권한 회수를 검토하십시오.`);
        }

        setEditingUser(userToEdit);
        setIsEditModalOpen(true);
    };
    const handleCloseEditModal = () => setIsEditModalOpen(false);

    const handleAddNewUser = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!newUser.id || !newUser.name || !newUser.password || !newUser.team) {
            setAddUserError('아이디, 이름, 비밀번호, 팀은 필수 항목입니다.');
            return;
        }
        if (users.some(u => u.id === newUser.id)) {
            setAddUserError('이미 사용 중인 아이디입니다.');
            return;
        }

        setIsSubmitting(true);
        const defaultPermissions: Permission = {
            referrals: { read: true, write: true, delete: false },
            suicideAttempters: { read: true, write: true, delete: false },
            caseAnalysis: { read: true, write: true, delete: false },
            data: { read: true, write: true, delete: false },
            reports: { read: true, write: true, delete: false },
            budget: { read: true, write: true, delete: false },
            accounts: { read: false, write: false, delete: false },
        };
        const userToAdd = {
            ...newUser,
            createdDate: new Date().toISOString().split('T')[0],
            lastLogin: '',
            permissions: defaultPermissions
        } as User;

        const result = await apiClient.createUser(userToAdd);
        setIsSubmitting(false);

        if (result.success) {
            setUsers(prev => [...prev, userToAdd]);
            handleCloseAddModal();
        } else {
            setAddUserError(result.error || '사용자 생성 실패');
        }
    };

    const handleUpdateUser = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!editingUser || isSubmitting) return;

        setIsSubmitting(true);
        const updatedUser = { ...editingUser, password: editingUser.password || users.find(u => u.id === editingUser.id)?.password || '' } as User;

        const result = await apiClient.updateUser(updatedUser);
        setIsSubmitting(false);

        if (result.success) {
            setUsers(users.map(u => u.id === editingUser.id ? updatedUser : u));
            handleCloseEditModal();
        } else {
            alert(result.error || '사용자 업데이트 실패');
        }
    };

    const handleDeleteUser = async (userId: string) => {
        if (isSubmitting) return;
        if (window.confirm(`정말로 '${userId}' 계정을 삭제하시겠습니까?`)) {
            setIsSubmitting(true);
            const result = await apiClient.deleteUser(userId);
            setIsSubmitting(false);

            if (result.success) {
                setUsers(users.filter(u => u.id !== userId));
            } else {
                alert(result.error || '사용자 삭제 실패');
            }
        }
    };

    const [isChangePasswordModalOpen, setIsChangePasswordModalOpen] = useState(false);
    const [passwordData, setPasswordData] = useState({ oldPassword: '', newPassword: '', confirmPassword: '' });

    const handleOpenChangePasswordModal = () => {
        setPasswordData({ oldPassword: '', newPassword: '', confirmPassword: '' });
        setIsChangePasswordModalOpen(true);
    }

    const handleChangePassword = async (e: React.FormEvent) => {
        e.preventDefault();

        if (!passwordData.oldPassword || !passwordData.newPassword || !passwordData.confirmPassword) {
            alert('모든 필드를 입력해주세요.');
            return;
        }

        if (passwordData.newPassword !== passwordData.confirmPassword) {
            alert('새 비밀번호가 일치하지 않습니다.');
            return;
        }

        if (passwordData.newPassword.length < 4) {
            alert('비밀번호는 최소 4자 이상이어야 합니다.');
            return;
        }

        setIsSubmitting(true);
        try {
            const result = await apiClient.changeMyPassword(currentUser.id, passwordData.oldPassword, passwordData.newPassword);
            if (result.success) {
                alert('비밀번호가 변경되었습니다. 다시 로그인해주세요.');
                setIsChangePasswordModalOpen(false);
                onForceLogout();
            } else {
                alert(result.error || '비밀번호 변경 실패');
            }
        } catch (error) {
            console.error('Password change error:', error);
            alert('비밀번호 변경 중 오류가 발생했습니다. 현재 비밀번호를 다시 확인해주세요.');
        } finally {
            setIsSubmitting(false);
        }
    };

    const handleResetPassword = async (userId: string) => {
        if (isSubmitting) return;
        const userToReset = users.find(u => u.id === userId);
        if (!userToReset) return;
        if (window.confirm(`'${userToReset.name}'(${userId}) 사용자의 비밀번호를 초기화하시겠습니까?`)) {
            setIsSubmitting(true);
            const newPassword = Math.random().toString(36).substring(2, 10);
            const result = await apiClient.resetUserPassword(currentUser.id, userId, newPassword);
            setIsSubmitting(false);

            if (result.success) {
                setUsers(prev => prev.map(u => u.id === userId ? { ...u, password: newPassword } : u));
                alert(`비밀번호가 초기화되었습니다.\n[ ${userId} ]의 새 비밀번호는 [ ${newPassword} ] 입니다.\n(꼭 전달해주세요!)`);
            } else {
                alert(result.error || '비밀번호 초기화 실패');
            }
        }
    };

    const handleToggleUserStatus = async (userId: string) => {
        if (isSubmitting) return;
        const user = users.find(u => u.id === userId);
        if (!user) return;

        setIsSubmitting(true);
        const updatedUser = { ...user, status: user.status === 'active' ? 'suspended' as const : 'active' as const };
        const result = await apiClient.updateUser(updatedUser);
        setIsSubmitting(false);

        if (result.success) {
            setUsers(users.map(u => u.id === userId ? updatedUser : u));
        } else {
            alert(result.error || '상태 변경 실패');
        }
    };

    const handleImport = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;

        if (!confirm('사용자 계정 엑셀 파일을 불러오겠습니까?\\n기존 사용자는 업데이트되고, 새로운 사용자는 추가됩니다.')) {
            e.target.value = '';
            return;
        }

        setIsImporting(true);
        const reader = new FileReader();
        reader.onload = (evt) => {
            try {
                const bstr = evt.target?.result;
                const wb = XLSX.read(bstr, { type: 'binary' });
                const wsname = wb.SheetNames[0];
                const ws = wb.Sheets[wsname];
                const jsonData = XLSX.utils.sheet_to_json(ws);

                const headerMap: Record<string, string> = {};
                Object.entries(USER_EXCEL_HEADERS).forEach(([key, label]) => {
                    headerMap[label] = key;
                });

                const parsedData = jsonData.map((row: any) => {
                    const newObj: any = {};
                    Object.keys(row).forEach(header => {
                        const key = headerMap[header];
                        if (key) {
                            newObj[key] = row[header];
                        }
                    });
                    return newObj;
                });

                apiClient.importUsers(parsedData)
                    .then((res: any) => {
                        setIsImporting(false);
                        if (res.success) {
                            alert(res.message);
                            window.location.reload();
                        } else {
                            alert("Import Failed: " + res.error);
                        }
                    })
                    .catch((err: any) => {
                        setIsImporting(false);
                        alert("Import Error: " + err);
                    });
            } catch (error) {
                console.error(error);
                setIsImporting(false);
                alert("파일 처리 중 오류 발생");
            }
            e.target.value = '';
        };
        reader.readAsBinaryString(file);
    };

    const handleExport = () => {
        const dataToExport = users.map(u => {
            const row: any = {};
            Object.entries(USER_EXCEL_HEADERS).forEach(([key, label]) => {
                row[label] = (u as any)[key] || '';
            });
            return row;
        });

        const worksheet = XLSX.utils.json_to_sheet(dataToExport);
        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, worksheet, 'Users');

        const excelBuffer = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
        const data = new Blob([excelBuffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheet.sheet;charset=UTF-8' });

        const url = URL.createObjectURL(data);
        const a = document.createElement('a');
        a.href = url;
        a.download = '시스템_사용자_계정.xlsx';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    };

    return (
        <PageContainer
            title="계정 관리"
            subtitle={currentUser.role === 'admin' ? "시스템 사용자 및 권한 설정" : "시스템 사용자 목록 (관리자만 수정 가능)"}
            headerContent={
                <div className="flex items-center gap-3">
                    <button onClick={handleOpenChangePasswordModal} className="bg-white border border-slate-200 text-slate-600 hover:bg-slate-50 px-[13px] py-[8px] rounded-xl font-bold text-sm shadow-sm transition flex items-center gap-2">
                        <i className="fas fa-key"></i> 비밀번호 변경
                    </button>

                    {currentUser.role === 'admin' && activeTab === 'users' && (
                        <>
                            <button onClick={handleExport} className="bg-indigo-600 text-white px-[13px] py-[8px] rounded-xl font-bold text-sm shadow-lg shadow-indigo-600/20 transition flex items-center gap-2 hover:bg-indigo-700">
                                <i className="fas fa-file-export"></i> 엑셀 저장
                            </button>

                            <div className="relative group">
                                <input
                                    type="file"
                                    accept=".xlsx, .xls"
                                    onChange={handleImport}
                                    className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10"
                                    disabled={isImporting}
                                />
                                <button disabled={isImporting} className="bg-emerald-600 text-white px-[13px] py-[8px] rounded-xl font-bold text-sm shadow-lg shadow-emerald-600/20 transition flex items-center gap-2 hover:bg-emerald-700">
                                    {isImporting ? <i className="fas fa-spinner fa-spin"></i> : <i className="fas fa-file-excel"></i>}
                                    <span>{isImporting ? '가져오는 중...' : '계정 엑셀 가져오기'}</span>
                                </button>
                            </div>

                            <button onClick={handleOpenAddModal} className="bg-slate-900 text-white px-[13px] py-[8px] rounded-xl font-bold text-sm shadow-lg shadow-slate-900/20 transition flex items-center gap-2">
                                <i className="fas fa-plus"></i> 사용자 추가
                            </button>
                        </>
                    )}

                </div>
            }
        >
            {/* Tab Navigation */}
            <div className="flex gap-1 mb-6 bg-white/50 p-1 rounded-2xl border border-slate-100 w-fit">
                <button
                    onClick={() => setActiveTab('users')}
                    className={`px-[13px] py-[8px] rounded-xl text-sm font-bold transition-all ${activeTab === 'users' ? 'bg-white text-indigo-600 shadow-sm border border-slate-100' : 'text-slate-400 hover:text-slate-600'}`}
                >
                    사용자 관리
                </button>
                <button
                    onClick={() => setActiveTab('activity')}
                    className={`px-[13px] py-[8px] rounded-xl text-sm font-bold transition-all ${activeTab === 'activity' ? 'bg-white text-indigo-600 shadow-sm border border-slate-100' : 'text-slate-400 hover:text-slate-600'}`}
                >
                    활동 로그
                </button>
                {currentUser.role === 'admin' && (
                    <button
                        onClick={() => setActiveTab('org')}
                        className={`px-[13px] py-[8px] rounded-xl text-sm font-bold transition-all ${activeTab === 'org' ? 'bg-white text-indigo-600 shadow-sm border border-slate-100' : 'text-slate-400 hover:text-slate-600'}`}
                    >
                        기관 설정
                    </button>
                )}
            </div>

            {currentUser.role === 'user' ? (
                <div className="flex flex-col items-center justify-center p-20 bg-white rounded-[3rem] border border-slate-100 shadow-sm text-center">
                    <div className="w-20 h-20 bg-blue-50 text-blue-500 rounded-3xl flex items-center justify-center text-3xl mb-6 shadow-inner">
                        <i className="fas fa-user-shield"></i>
                    </div>
                    <h3 className="text-xl font-black text-slate-900 mb-3">개인 정보 및 보안</h3>
                    <p className="text-slate-500 mb-8 max-w-sm">
                        일반 사용자는 계정 목록을 조회할 수 없습니다.<br />
                        비밀번호 변경이 필요하시면 상단의 버튼을 눌러주세요.
                    </p>
                    <button onClick={handleOpenChangePasswordModal} className="bg-blue-600 text-white px-8 py-4 rounded-2xl font-black text-sm shadow-xl shadow-blue-200 hover:bg-blue-700 transition transform hover:scale-105 active:scale-95 flex items-center gap-3">
                        <i className="fas fa-key"></i> 비밀번호 변경하기
                    </button>
                </div>
            ) : activeTab === 'users' ? (
                <>
                    {/* Permission Summary & Filters */}
                    <div className="mb-6 flex flex-col md:flex-row md:items-center justify-between gap-4 bg-white p-6 rounded-[2rem] border border-slate-100 shadow-sm">
                        {/* Summary Badges */}
                        <div className="flex flex-wrap items-center gap-3">
                            <div className="flex items-center gap-2 px-[13px] py-[8px] rounded-xl bg-slate-50 border border-slate-200 text-xs font-bold text-slate-700">
                                <i className="fas fa-users text-slate-400"></i>
                                <span>활성 사용자 <strong className="text-slate-900">{permissionSummary.totalActive}</strong>명</span>
                            </div>
                            <div className="flex items-center gap-2 px-[13px] py-[8px] rounded-xl bg-teal-50 border border-teal-200 text-xs font-bold text-teal-800">
                                <i className="fas fa-clipboard-check text-teal-600"></i>
                                <span>온라인 설문 <strong className="text-teal-900">{permissionSummary.surveyCount}</strong>명</span>
                            </div>
                            <div className="flex items-center gap-2 px-[13px] py-[8px] rounded-xl bg-purple-50 border border-purple-200 text-xs font-bold text-purple-800">
                                <i className="fas fa-microphone text-purple-600"></i>
                                <span>음성 녹음 분석(AI) <strong className="text-purple-900">{permissionSummary.voiceCount}</strong>명</span>
                            </div>
                        </div>

                        {/* Search & Filter Dropdown */}
                        <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
                            <div className="relative min-w-[200px]">
                                <i className="fas fa-search absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400 text-xs"></i>
                                <input
                                    type="text"
                                    value={searchQuery}
                                    onChange={(e) => setSearchQuery(e.target.value)}
                                    placeholder="이름 / ID / 팀 검색"
                                    className="w-full pl-9 pr-[13px] py-[8px] bg-slate-50 border border-slate-200 rounded-xl text-xs font-medium text-slate-800 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition"
                                />
                            </div>
                            <select
                                value={permissionFilter}
                                onChange={(e) => setPermissionFilter(e.target.value as any)}
                                className="px-[13px] py-[8px] bg-slate-50 border border-slate-200 rounded-xl text-xs font-bold text-slate-700 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 cursor-pointer"
                            >
                                <option value="all">전체 사용자 ({users.length}명)</option>
                                <option value="survey">온라인 설문 허용 ({permissionSummary.surveyCount}명)</option>
                                <option value="voice">음성 AI 허용 ({permissionSummary.voiceCount}명)</option>
                                <option value="unassigned">권한 미부여</option>
                                <option value="inactive">비활성/정지 사용자</option>
                            </select>
                        </div>
                    </div>

                    {/* Desktop Table View */}
                    <div className="hidden md:block bg-white rounded-[2.5rem] shadow-sm border border-slate-100 overflow-hidden mb-8">
                        <table className="w-full text-sm text-left text-slate-600">
                            <thead className="bg-slate-50/50 text-xs text-slate-400 font-extrabold uppercase tracking-wider border-b border-slate-100">
                                <tr>
                                    {['ID', '이름', '소속팀', '역할', ...(currentUser.role === 'admin' ? ['온라인 설문', '음성 녹음 분석(AI)'] : []), '상태', '생성일', '관리'].map(h => (
                                        <th key={h} className="px-6 py-5 whitespace-nowrap">{h}</th>
                                    ))}
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-50">
                                {filteredUsers.length === 0 ? (
                                    <tr>
                                        <td colSpan={currentUser.role === 'admin' ? 9 : 7} className="px-6 py-12 text-center text-slate-400">
                                            검색된 사용자가 없습니다.
                                        </td>
                                    </tr>
                                ) : (
                                    filteredUsers.map(u => (
                                        <tr key={u.id} className="hover:bg-slate-50/80 transition">
                                            <td className="px-6 py-4 font-bold text-slate-900 whitespace-nowrap">{u.id}</td>
                                            <td className="px-6 py-4 font-medium whitespace-nowrap">{u.name}</td>
                                            <td className="px-6 py-4 whitespace-nowrap">{getTeamsConfig()[u.team]?.title || u.team}</td>
                                            <td className="px-6 py-4 whitespace-nowrap">
                                                <span className={`px-2.5 py-1 text-xs font-bold rounded-lg ${u.role === 'admin' ? 'bg-red-100 text-red-700' : u.role === 'manager' ? 'bg-orange-100 text-orange-700' : 'bg-blue-100 text-blue-700'}`}>
                                                    {u.role}
                                                </span>
                                            </td>

                                            {/* Online Survey Permission Column */}
                                            {currentUser.role === 'admin' && (
                                                <td className="px-6 py-4 whitespace-nowrap">
                                                    {u.role === 'admin' ? (
                                                        <span className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold rounded-xl bg-indigo-50 text-indigo-700 border border-indigo-200" title="관리자는 전권한 자동 허용">
                                                            <i className="fas fa-shield-alt text-indigo-500"></i>
                                                            관리자 (자동)
                                                        </span>
                                                    ) : (() => {
                                                        const hasSurvey = checkHasSurveyAccess(u);
                                                        const isInactive = u.status !== 'active';
                                                        const isBusy = updatingPerm?.userId === u.id && updatingPerm?.permKey === 'online_survey';

                                                        return (
                                                            <button
                                                                type="button"
                                                                onClick={() => handleToggleOnlineSurveyAccess(u)}
                                                                disabled={isInactive || isBusy}
                                                                title={isInactive ? '비활성 사용자에게는 권한을 부여할 수 없습니다.' : hasSurvey ? '클릭 시 온라인 설문 권한 회수' : '클릭 시 온라인 설문 권한 부여'}
                                                                className={`min-h-[44px] px-3.5 py-2 text-xs font-extrabold rounded-xl transition flex items-center gap-2 ${
                                                                    isInactive
                                                                        ? 'bg-slate-100 text-slate-400 cursor-not-allowed opacity-60 border border-slate-200'
                                                                        : isBusy
                                                                            ? 'bg-amber-100 text-amber-700 cursor-wait border border-amber-300'
                                                                            : hasSurvey
                                                                                ? 'bg-teal-100 text-teal-800 hover:bg-teal-200 shadow-sm border border-teal-300'
                                                                                : 'bg-slate-100 text-slate-500 hover:bg-slate-200 border border-slate-200'
                                                                }`}
                                                            >
                                                                <i className={`fas ${isBusy ? 'fa-spinner fa-spin text-amber-600' : hasSurvey ? 'fa-clipboard-check text-teal-600' : 'fa-clipboard text-slate-400'}`}></i>
                                                                <span>{isBusy ? '변경 중...' : isInactive ? '사용 불가' : hasSurvey ? '허용됨 (ON)' : '미부여 (OFF)'}</span>
                                                            </button>
                                                        );
                                                    })()}
                                                </td>
                                            )}

                                            {/* Voice AI Permission Column */}
                                            {currentUser.role === 'admin' && (
                                                <td className="px-6 py-4 whitespace-nowrap">
                                                    {u.role === 'admin' ? (
                                                        <span className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold rounded-xl bg-indigo-50 text-indigo-700 border border-indigo-200" title="관리자는 전권한 자동 허용">
                                                            <i className="fas fa-shield-alt text-indigo-500"></i>
                                                            관리자 (자동)
                                                        </span>
                                                    ) : (() => {
                                                        const hasVoice = checkHasVoiceAccess(u);
                                                        const isInactive = u.status !== 'active';
                                                        const isBusy = updatingPerm?.userId === u.id && updatingPerm?.permKey === 'voice_ai';

                                                        return (
                                                            <button
                                                                type="button"
                                                                onClick={() => handleToggleVoiceAccess(u)}
                                                                disabled={isInactive || isBusy}
                                                                title={isInactive ? '비활성 사용자에게는 권한을 부여할 수 없습니다.' : hasVoice ? '클릭 시 음성 AI 권한 회수' : '클릭 시 음성 AI 권한 부여'}
                                                                className={`min-h-[44px] px-3.5 py-2 text-xs font-extrabold rounded-xl transition flex items-center gap-2 ${
                                                                    isInactive
                                                                        ? 'bg-slate-100 text-slate-400 cursor-not-allowed opacity-60 border border-slate-200'
                                                                        : isBusy
                                                                            ? 'bg-amber-100 text-amber-700 cursor-wait border border-amber-300'
                                                                            : hasVoice
                                                                                ? 'bg-purple-100 text-purple-800 hover:bg-purple-200 shadow-sm border border-purple-300'
                                                                                : 'bg-slate-100 text-slate-500 hover:bg-slate-200 border border-slate-200'
                                                                }`}
                                                            >
                                                                <i className={`fas ${isBusy ? 'fa-spinner fa-spin text-amber-600' : hasVoice ? 'fa-microphone text-purple-600' : 'fa-microphone-slash text-slate-400'}`}></i>
                                                                <span>{isBusy ? '변경 중...' : isInactive ? '사용 불가' : hasVoice ? '허용됨 (ON)' : '미부여 (OFF)'}</span>
                                                            </button>
                                                        );
                                                    })()}
                                                </td>
                                            )}

                                            <td className="px-6 py-4 whitespace-nowrap">
                                                <span
                                                    onClick={() => currentUser.role === 'admin' && handleToggleUserStatus(u.id)}
                                                    className={`px-2.5 py-1 text-xs font-bold rounded-lg ${currentUser.role === 'admin' ? 'cursor-pointer' : 'cursor-not-allowed opacity-60'} ${u.status === 'active' ? 'bg-green-100 text-green-700' : 'bg-slate-200 text-slate-600'}`}
                                                >
                                                    {u.status === 'active' ? '활성' : '정지'}
                                                </span>
                                            </td>
                                            <td className="px-6 py-4 text-slate-400 whitespace-nowrap">{u.createdDate}</td>
                                            <td className="px-6 py-4 whitespace-nowrap">
                                                {currentUser.role === 'admin' ? (
                                                    <div className="flex items-center gap-3">
                                                        <button onClick={() => handleOpenEditModal(u)} className="text-blue-600 font-bold text-xs hover:underline">수정</button>
                                                        <button onClick={() => handleResetPassword(u.id)} className="text-green-600 font-bold text-xs hover:underline">비번초기화</button>
                                                        <button onClick={() => handleDeleteUser(u.id)} className="text-red-500 font-bold text-xs hover:underline">삭제</button>
                                                    </div>
                                                ) : (
                                                    <span className="text-gray-400 text-xs">권한 없음</span>
                                                )}
                                            </td>
                                        </tr>
                                    ))
                                )}
                            </tbody>
                        </table>
                    </div>

                    {/* Mobile User Cards View */}
                    <div className="md:hidden space-y-4 mb-8">
                        {filteredUsers.length === 0 ? (
                            <div className="p-[21px] text-center text-slate-400 bg-white rounded-[24px] border border-slate-100">
                                검색된 사용자가 없습니다.
                            </div>
                        ) : (
                            filteredUsers.map(u => {
                                const hasSurvey = checkHasSurveyAccess(u);
                                const hasVoice = checkHasVoiceAccess(u);
                                const isInactive = u.status !== 'active';
                                const isSurveyBusy = updatingPerm?.userId === u.id && updatingPerm?.permKey === 'online_survey';
                                const isVoiceBusy = updatingPerm?.userId === u.id && updatingPerm?.permKey === 'voice_ai';

                                return (
                                    <div key={u.id} className="bg-white p-[21px] rounded-[24px] border border-slate-100 shadow-sm space-y-4">
                                        {/* Card Header */}
                                        <div className="flex items-start justify-between gap-2">
                                            <div>
                                                <div className="flex items-center gap-2 flex-wrap">
                                                    <span className="font-extrabold text-slate-900 text-base">{u.name}</span>
                                                    <span className="text-xs text-slate-400 font-mono">({u.id})</span>
                                                </div>
                                                <div className="text-xs text-slate-500 mt-0.5">
                                                    {getTeamsConfig()[u.team]?.title || u.team}
                                                </div>
                                            </div>
                                            <div className="flex items-center gap-1.5 flex-shrink-0">
                                                <span className={`px-2.5 py-1 text-xs font-bold rounded-lg ${u.role === 'admin' ? 'bg-red-100 text-red-700' : u.role === 'manager' ? 'bg-orange-100 text-orange-700' : 'bg-blue-100 text-blue-700'}`}>
                                                    {u.role}
                                                </span>
                                                <span
                                                    onClick={() => currentUser.role === 'admin' && handleToggleUserStatus(u.id)}
                                                    className={`px-2.5 py-1 text-xs font-bold rounded-lg ${currentUser.role === 'admin' ? 'cursor-pointer' : 'opacity-60'} ${u.status === 'active' ? 'bg-green-100 text-green-700' : 'bg-slate-200 text-slate-600'}`}
                                                >
                                                    {u.status === 'active' ? '활성' : '정지'}
                                                </span>
                                            </div>
                                        </div>

                                        {/* Permissions Matrix */}
                                        {currentUser.role === 'admin' && (
                                            <div className="bg-slate-50 p-3.5 rounded-2xl border border-slate-100 space-y-2.5">
                                                {/* Online Survey Permission */}
                                                <div className="flex items-center justify-between gap-2">
                                                    <span className="text-xs font-bold text-slate-700 flex items-center gap-1.5">
                                                        <i className="fas fa-clipboard-list text-teal-600"></i>
                                                        온라인 설문
                                                    </span>
                                                    {u.role === 'admin' ? (
                                                        <span className="px-3 py-1.5 text-xs font-bold rounded-xl bg-indigo-50 text-indigo-700 border border-indigo-200">
                                                            관리자 (자동)
                                                        </span>
                                                    ) : (
                                                        <button
                                                            type="button"
                                                            onClick={() => handleToggleOnlineSurveyAccess(u)}
                                                            disabled={isInactive || isSurveyBusy}
                                                            className={`min-h-[44px] px-3.5 py-2 text-xs font-extrabold rounded-xl transition flex items-center gap-1.5 ${
                                                                isInactive
                                                                    ? 'bg-slate-100 text-slate-400 cursor-not-allowed opacity-60 border border-slate-200'
                                                                    : isSurveyBusy
                                                                        ? 'bg-amber-100 text-amber-700 cursor-wait border border-amber-300'
                                                                        : hasSurvey
                                                                            ? 'bg-teal-100 text-teal-800 hover:bg-teal-200 border border-teal-300'
                                                                            : 'bg-white text-slate-600 hover:bg-slate-100 border border-slate-200'
                                                            }`}
                                                        >
                                                            <i className={`fas ${isSurveyBusy ? 'fa-spinner fa-spin text-amber-600' : hasSurvey ? 'fa-clipboard-check text-teal-600' : 'fa-clipboard text-slate-400'}`}></i>
                                                            <span>{isSurveyBusy ? '변경 중...' : isInactive ? '사용 불가' : hasSurvey ? '허용됨 (ON)' : '미부여 (OFF)'}</span>
                                                        </button>
                                                    )}
                                                </div>

                                                {/* Voice AI Permission */}
                                                <div className="flex items-center justify-between gap-2 pt-2 border-t border-slate-200/60">
                                                    <span className="text-xs font-bold text-slate-700 flex items-center gap-1.5">
                                                        <i className="fas fa-microphone text-purple-600"></i>
                                                        음성 녹음 분석(AI)
                                                    </span>
                                                    {u.role === 'admin' ? (
                                                        <span className="px-3 py-1.5 text-xs font-bold rounded-xl bg-indigo-50 text-indigo-700 border border-indigo-200">
                                                            관리자 (자동)
                                                        </span>
                                                    ) : (
                                                        <button
                                                            type="button"
                                                            onClick={() => handleToggleVoiceAccess(u)}
                                                            disabled={isInactive || isVoiceBusy}
                                                            className={`min-h-[44px] px-3.5 py-2 text-xs font-extrabold rounded-xl transition flex items-center gap-1.5 ${
                                                                isInactive
                                                                    ? 'bg-slate-100 text-slate-400 cursor-not-allowed opacity-60 border border-slate-200'
                                                                    : isVoiceBusy
                                                                        ? 'bg-amber-100 text-amber-700 cursor-wait border border-amber-300'
                                                                        : hasVoice
                                                                            ? 'bg-purple-100 text-purple-800 hover:bg-purple-200 border border-purple-300'
                                                                            : 'bg-white text-slate-600 hover:bg-slate-100 border border-slate-200'
                                                            }`}
                                                        >
                                                            <i className={`fas ${isVoiceBusy ? 'fa-spinner fa-spin text-amber-600' : hasVoice ? 'fa-microphone text-purple-600' : 'fa-microphone-slash text-slate-400'}`}></i>
                                                            <span>{isVoiceBusy ? '변경 중...' : isInactive ? '사용 불가' : hasVoice ? '허용됨 (ON)' : '미부여 (OFF)'}</span>
                                                        </button>
                                                    )}
                                                </div>
                                            </div>
                                        )}

                                        {/* Card Actions */}
                                        <div className="flex items-center justify-between pt-2 border-t border-slate-50 text-xs">
                                            <span className="text-slate-400">{u.createdDate}</span>
                                            {currentUser.role === 'admin' && (
                                                <div className="flex items-center gap-3">
                                                    <button onClick={() => handleOpenEditModal(u)} className="min-h-[44px] px-2 text-blue-600 font-bold hover:underline">수정</button>
                                                    <button onClick={() => handleResetPassword(u.id)} className="min-h-[44px] px-2 text-green-600 font-bold hover:underline">비번초기화</button>
                                                    <button onClick={() => handleDeleteUser(u.id)} className="min-h-[44px] px-2 text-red-500 font-bold hover:underline">삭제</button>
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                );
                            })
                        )}
                    </div>

                    <div className="bg-white p-8 rounded-[2.5rem] shadow-sm border border-slate-100">
                        <h3 className="text-lg font-extrabold text-slate-900 mb-6">최근 접속 기록</h3>
                        <div className="overflow-x-auto">
                            <table className="w-full text-sm text-left text-slate-600">
                                <thead className="text-xs text-slate-400 uppercase font-bold border-b border-slate-100">
                                    <tr>
                                        <th className="pb-3 px-4">사용자 ID</th>
                                        <th className="pb-3 px-4">로그인 시간</th>
                                        <th className="pb-3 px-4">로그아웃 시간</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-slate-50">
                                    {sessionLogs.slice(0, 10).map(log => (
                                        <tr key={log.logId}>
                                            <td className="py-3 px-4 font-bold text-slate-800">{log.userId}</td>
                                            <td className="py-3 px-4 text-slate-500 font-mono text-xs">{log.loginTime}</td>
                                            <td className="py-3 px-4 text-slate-500 font-mono text-xs">{log.logoutTime || '접속 중'}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </div>
                </>
            ) : activeTab === 'activity' ? (
                <div className="bg-white rounded-[2.5rem] shadow-sm border border-slate-100 overflow-hidden">
                    <table className="w-full text-sm text-left text-slate-600">
                        <thead className="bg-slate-50/50 text-xs text-slate-400 font-extrabold uppercase tracking-wider border-b border-slate-100">
                            <tr>
                                <th className="px-8 py-5">시간</th>
                                <th className="px-8 py-5">사용자</th>
                                <th className="px-8 py-5">작업</th>
                                <th className="px-8 py-5">상세 내용</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-50">
                            {activityLogs.length > 0 ? (
                                activityLogs.map(log => (
                                    <tr key={log.logId || log.id} className="hover:bg-slate-50/80 transition">
                                        <td className="px-8 py-5 text-slate-400 font-mono text-xs whitespace-nowrap">{log.timestamp || log.loginTime}</td>
                                        <td className="px-8 py-5 font-bold text-slate-900">{log.userId || (log as any).user}</td>
                                        <td className="px-8 py-5">
                                            <span className={`px-3 py-1 text-[11px] font-extrabold rounded-lg ${log.action?.includes('삭제') ? 'bg-red-50 text-red-600' :
                                                log.action?.includes('등록') ? 'bg-green-50 text-green-600' :
                                                    log.action?.includes('수정') ? 'bg-blue-50 text-blue-600' :
                                                        'bg-slate-100 text-slate-600'
                                                }`}>
                                                {log.action}
                                            </span>
                                        </td>
                                        <td className="px-8 py-5 text-slate-500">{log.details}</td>
                                    </tr>
                                ))
                            ) : (
                                <tr>
                                    <td colSpan={4} className="px-8 py-20 text-center text-slate-400 font-bold">활동 로그가 없습니다.</td>
                                </tr>
                            )}
                        </tbody>
                    </table>
                </div>
            ) : (
                <OrgSettingsPanel showToast={showToast} />
            )}

            {isAddModalOpen && <div className="fixed inset-0 bg-black/30 backdrop-blur-sm flex items-center justify-center z-50 p-[21px]"><div className="bg-white rounded-[24px] shadow-2xl p-[21px] space-y-6 w-full max-w-[448px] max-h-[calc(100vh-89px)] overflow-y-auto animate-scale-in"><h2 className="text-2xl font-extrabold text-slate-900">사용자 추가</h2><form onSubmit={handleAddNewUser} className="space-y-4">{addUserError && <p className="text-red-500 text-sm bg-red-50 p-3 rounded-xl font-bold">{addUserError}</p>}<div><label className="block text-xs font-bold text-slate-400 mb-1 ml-1">아이디</label><input type="text" value={newUser.id || ''} onChange={(e) => setNewUser({ ...newUser, id: e.target.value })} className="w-full px-[13px] py-[8px] bg-slate-50 rounded-xl font-bold text-slate-800 focus:ring-2 focus:ring-blue-500/20 outline-none" required /></div><div><label className="block text-xs font-bold text-slate-400 mb-1 ml-1">이름</label><input type="text" value={newUser.name || ''} onChange={(e) => setNewUser({ ...newUser, name: e.target.value })} className="w-full px-[13px] py-[8px] bg-slate-50 rounded-xl font-bold text-slate-800 focus:ring-2 focus:ring-blue-500/20 outline-none" required /></div><div><label className="block text-xs font-bold text-slate-400 mb-1 ml-1">비밀번호</label><input type="password" value={newUser.password || ''} onChange={(e) => setNewUser({ ...newUser, password: e.target.value })} className="w-full px-[13px] py-[8px] bg-slate-50 rounded-xl font-bold text-slate-800 focus:ring-2 focus:ring-blue-500/20 outline-none" required /></div><div><label className="block text-xs font-bold text-slate-400 mb-1 ml-1">소속팀</label><select value={newUser.team || getTeams()[0]} onChange={(e) => setNewUser({ ...newUser, team: e.target.value as any })} className="w-full px-[13px] py-[8px] bg-slate-50 rounded-xl font-bold text-slate-800 focus:ring-2 focus:ring-blue-500/20 outline-none appearance-none">{getTeams().map(team => <option key={team} value={team}>{getTeamsConfig()[team]?.title || team}</option>)}</select></div><div><label className="block text-xs font-bold text-slate-400 mb-1 ml-1">권한</label><select value={newUser.role || 'user'} onChange={(e) => setNewUser({ ...newUser, role: e.target.value as any })} className="w-full px-[13px] py-[8px] bg-slate-50 rounded-xl font-bold text-slate-800 focus:ring-2 focus:ring-blue-500/20 outline-none appearance-none"><option value="user">사용자</option><option value="manager">매니저</option><option value="admin">관리자</option></select></div><div className="flex justify-end gap-3 pt-4"><button type="button" onClick={handleCloseAddModal} className="px-6 py-3 bg-slate-100 rounded-xl font-bold text-slate-500 hover:bg-slate-200 transition" disabled={isSubmitting}>취소</button><button type="submit" className="px-6 py-3 bg-blue-600 text-white rounded-xl font-bold hover:bg-blue-700 transition shadow-lg shadow-blue-600/20 disabled:opacity-50 disabled:cursor-not-allowed" disabled={isSubmitting}>{isSubmitting ? '생성 중...' : '생성'}</button></div></form></div></div>}

            {isEditModalOpen && editingUser && <div className="fixed inset-0 bg-black/30 backdrop-blur-sm flex items-center justify-center z-50 p-[21px]"><div className="bg-white rounded-[24px] shadow-2xl p-[21px] space-y-6 w-full max-w-[448px] max-h-[calc(100vh-89px)] overflow-y-auto animate-scale-in"><h2 className="text-2xl font-extrabold text-slate-900">계정 수정</h2><form onSubmit={handleUpdateUser} className="space-y-4"><div><label className="block text-xs font-bold text-slate-400 mb-1 ml-1">이름</label><input type="text" value={editingUser.name || ''} onChange={(e) => setEditingUser({ ...editingUser, name: e.target.value })} className="w-full px-[13px] py-[8px] bg-slate-50 rounded-xl font-bold text-slate-800 outline-none" required /></div>                            <div><label className="block text-xs font-bold text-slate-400 mb-1 ml-1">소속팀</label><select value={editingUser.team || getTeams()[0]} onChange={(e) => setEditingUser({ ...editingUser, team: e.target.value as any })} className="w-full px-[13px] py-[8px] bg-slate-50 rounded-xl font-bold text-slate-800 outline-none">{getTeams().map(team => <option key={team} value={team}>{getTeamsConfig()[team]?.title || team}</option>)}</select></div>

                {/* Permission Editor - Improved Compact Grid UI */}
                <div className="bg-slate-50 p-5 rounded-2xl border border-slate-100">
                    <h4 className="text-sm font-extrabold text-slate-700 mb-4 flex items-center gap-2">
                        <i className="fas fa-shield-alt text-blue-500"></i> 접근 권한 설정
                    </h4>
                    <div className="grid grid-cols-2 gap-3 max-h-64 overflow-y-auto pr-1 custom-scrollbar">
                        {(['referrals', 'suicideAttempters', 'caseAnalysis', 'data', 'reports', 'budget', 'accounts'] as (keyof Permission)[]).map(menu => (
                            <div key={menu} className="flex flex-col p-3 bg-white rounded-xl shadow-[0_2px_8px_rgba(0,0,0,0.04)] border border-slate-100/50">
                                <div className="flex items-center gap-2 mb-2">
                                    <span className="w-6 h-6 flex items-center justify-center bg-slate-100 rounded-full text-xs text-slate-500">
                                        {menu === 'referrals' ? <i className="fas fa-file-medical"></i> :
                                            menu === 'suicideAttempters' ? <i className="fas fa-heartbeat"></i> :
                                                menu === 'caseAnalysis' ? <i className="fas fa-users-cog"></i> :
                                                    menu === 'data' ? <i className="fas fa-database"></i> :
                                                        menu === 'reports' ? <i className="fas fa-chart-pie"></i> :
                                                            menu === 'budget' ? <i className="fas fa-won-sign"></i> :
                                                                <i className="fas fa-user-shield"></i>}
                                    </span>
                                    <span className="text-xs font-bold text-slate-700">
                                        {menu === 'referrals' ? '의뢰관리' :
                                            menu === 'suicideAttempters' ? '자살시도자' :
                                                menu === 'caseAnalysis' ? '사례분석' :
                                                    menu === 'data' ? '데이터' :
                                                        menu === 'reports' ? '통계' :
                                                            menu === 'budget' ? '예산' : '계정'}
                                    </span>
                                </div>
                                <div className="flex justify-between bg-slate-50 rounded-lg p-1.5">
                                    {(['read', 'write', 'delete'] as const).map(action => (
                                        <label key={action} className="flex items-center gap-1.5 cursor-pointer hover:bg-white rounded px-1.5 py-0.5 transition-colors">
                                            <input
                                                type="checkbox"
                                                checked={editingUser.permissions?.[menu]?.[action] ?? false}
                                                onChange={(e) => {
                                                    const newPerms = { ...editingUser.permissions } as Permission;
                                                    if (!newPerms[menu]) newPerms[menu] = { read: false, write: false, delete: false };
                                                    newPerms[menu][action] = e.target.checked;
                                                    setEditingUser({ ...editingUser, permissions: newPerms });
                                                }}
                                                className="w-3.5 h-3.5 rounded text-blue-600 focus:ring-0 border-slate-300"
                                            />
                                            <span className={`text-[10px] font-bold ${action === 'read' ? 'text-blue-600' :
                                                action === 'write' ? 'text-emerald-600' : 'text-red-500'
                                                }`}>
                                                {action === 'read' ? '읽기' : action === 'write' ? '쓰기' : '삭제'}
                                            </span>
                                        </label>
                                    ))}
                                </div>
                            </div>
                        ))}
                    </div>
                </div>

                {/* SURVEY_ASSIGNMENT_ACCESS Toggle */}
                <div className="bg-slate-50 p-4 rounded-2xl border border-slate-100">
                    <label className="flex items-start gap-3 cursor-pointer">
                        <input
                            type="checkbox"
                            checked={checkHasSurveyAssignmentAccess(editingUser)}
                            onChange={(e) => {
                                const isChecked = e.target.checked;
                                const newPerms = Array.isArray(editingUser.permissions)
                                    ? (isChecked
                                        ? [...(editingUser.permissions as any[]).filter(p => p !== 'SURVEY_ASSIGNMENT_ACCESS'), 'SURVEY_ASSIGNMENT_ACCESS']
                                        : (editingUser.permissions as any[]).filter(p => p !== 'SURVEY_ASSIGNMENT_ACCESS'))
                                    : { ...(editingUser.permissions || {}), SURVEY_ASSIGNMENT_ACCESS: isChecked };
                                setEditingUser({ ...editingUser, permissions: newPerms as any });
                            }}
                            className="mt-0.5 w-4 h-4 rounded text-blue-600 focus:ring-0 border-slate-300"
                        />
                        <div className="flex flex-col">
                            <span className="text-xs font-bold text-slate-800">설문 담당자 배정 (실행 권한)</span>
                            <span className="text-[11px] text-slate-500">본인이 개별 설문의 담당자를 배정·재배정할 수 있는 권한입니다. 배정받는 대상 자격은 직원 목록의 '온라인 설문' 허용 여부로 결정됩니다.</span>
                        </div>
                    </label>
                </div>

                <div className="flex justify-end gap-3 pt-4"><button type="button" onClick={handleCloseEditModal} className="px-6 py-3 bg-slate-100 rounded-xl font-bold text-slate-500">취소</button><button type="submit" className="px-6 py-3 bg-blue-600 text-white rounded-xl font-bold shadow-lg">저장</button></div></form></div></div>}

            {isChangePasswordModalOpen && (
                <div className="fixed inset-0 bg-black/30 backdrop-blur-sm flex items-center justify-center z-50 p-[21px]">
                    <div className="bg-white rounded-[24px] shadow-2xl p-[21px] space-y-6 w-full max-w-[448px] max-h-[calc(100vh-89px)] overflow-y-auto animate-scale-in">
                        <h2 className="text-2xl font-extrabold text-slate-900">비밀번호 변경</h2>
                        <form onSubmit={handleChangePassword} className="space-y-4">
                            <div>
                                <label className="block text-xs font-bold text-slate-400 mb-1 ml-1">현재 비밀번호</label>
                                <input type="password" value={passwordData.oldPassword} onChange={(e) => setPasswordData({ ...passwordData, oldPassword: e.target.value })} className="w-full px-[13px] py-[8px] bg-slate-50 rounded-xl font-bold text-slate-800 outline-none focus:ring-2 focus:ring-blue-500/20" required placeholder="현재 사용 중인 비밀번호" />
                            </div>
                            <div>
                                <label className="block text-xs font-bold text-slate-400 mb-1 ml-1">새 비밀번호</label>
                                <input type="password" value={passwordData.newPassword} onChange={(e) => setPasswordData({ ...passwordData, newPassword: e.target.value })} className="w-full px-[13px] py-[8px] bg-slate-50 rounded-xl font-bold text-slate-800 outline-none focus:ring-2 focus:ring-blue-500/20" required placeholder="변경할 비밀번호" />
                            </div>
                            <div>
                                <label className="block text-xs font-bold text-slate-400 mb-1 ml-1">새 비밀번호 확인</label>
                                <input type="password" value={passwordData.confirmPassword} onChange={(e) => setPasswordData({ ...passwordData, confirmPassword: e.target.value })} className="w-full px-[13px] py-[8px] bg-slate-50 rounded-xl font-bold text-slate-800 outline-none focus:ring-2 focus:ring-blue-500/20" required placeholder="비밀번호 재입력" />
                            </div>
                            <div className="flex justify-end gap-3 pt-4">
                                <button type="button" onClick={() => setIsChangePasswordModalOpen(false)} className="px-6 py-3 bg-slate-100 rounded-xl font-bold text-slate-500 hover:bg-slate-200 transition">취소</button>
                                <button type="submit" className="px-6 py-3 bg-blue-600 text-white rounded-xl font-bold shadow-lg hover:bg-blue-700 transition" disabled={isSubmitting}>{isSubmitting ? '변경 중...' : '변경'}</button>
                            </div>
                        </form>
                    </div>
                </div>
            )}
        </PageContainer>
    );
};

export default AccountsPage;
