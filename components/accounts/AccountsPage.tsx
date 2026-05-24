
import React, { useState, useMemo } from 'react';
import { User, Log, Permission, AnyLog } from '../../types';
import PageContainer from '../layout/PageContainer';
import { ALL_TEAMS, TEAMS_CONFIG } from '../../constants';
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
    const [activeTab, setActiveTab] = useState<'users' | 'activity'>('users');
    const [isAddModalOpen, setIsAddModalOpen] = useState(false);
    const [isEditModalOpen, setIsEditModalOpen] = useState(false);
    const [editingUser, setEditingUser] = useState<User | null>(null);
    const [newUser, setNewUser] = useState<Partial<User>>({ role: 'user', status: 'active', team: '증진팀' });
    const [addUserError, setAddUserError] = useState('');
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [isImporting, setIsImporting] = useState(false);

    const sessionLogs = useMemo(() => logs.filter(l => l.loginTime && !l.action).sort((a, b) => new Date(b.loginTime).getTime() - new Date(a.loginTime).getTime()), [logs]);
    const activityLogs = useMemo(() => logs.filter(l => l.action).sort((a, b) => {
        const timeA = a.timestamp || a.loginTime || 0;
        const timeB = b.timestamp || b.loginTime || 0;
        return new Date(timeB).getTime() - new Date(timeA).getTime();
    }), [logs]);

    const handleOpenAddModal = () => {
        setNewUser({ role: 'user', status: 'active', team: '증진팀' });
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
                    <button onClick={handleOpenChangePasswordModal} className="bg-white border border-slate-200 text-slate-600 hover:bg-slate-50 px-4 py-2.5 rounded-xl font-bold text-sm shadow-sm transition flex items-center gap-2">
                        <i className="fas fa-key"></i> 비밀번호 변경
                    </button>

                    {currentUser.role === 'admin' && activeTab === 'users' && (
                        <>
                            <button onClick={handleExport} className="bg-indigo-600 text-white px-5 py-2.5 rounded-xl font-bold text-sm shadow-lg shadow-indigo-600/20 transition flex items-center gap-2 hover:bg-indigo-700">
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
                                <button disabled={isImporting} className="bg-emerald-600 text-white px-5 py-2.5 rounded-xl font-bold text-sm shadow-lg shadow-emerald-600/20 transition flex items-center gap-2 hover:bg-emerald-700">
                                    {isImporting ? <i className="fas fa-spinner fa-spin"></i> : <i className="fas fa-file-excel"></i>}
                                    <span>{isImporting ? '가져오는 중...' : '계정 엑셀 가져오기'}</span>
                                </button>
                            </div>

                            <button onClick={handleOpenAddModal} className="bg-slate-900 text-white px-5 py-2.5 rounded-xl font-bold text-sm shadow-lg shadow-slate-900/20 transition flex items-center gap-2 shadow-lg shadow-slate-900/20">
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
                    className={`px-6 py-2.5 rounded-xl text-sm font-bold transition-all ${activeTab === 'users' ? 'bg-white text-indigo-600 shadow-sm border border-slate-100' : 'text-slate-400 hover:text-slate-600'}`}
                >
                    사용자 관리
                </button>
                <button
                    onClick={() => setActiveTab('activity')}
                    className={`px-6 py-2.5 rounded-xl text-sm font-bold transition-all ${activeTab === 'activity' ? 'bg-white text-indigo-600 shadow-sm border border-slate-100' : 'text-slate-400 hover:text-slate-600'}`}
                >
                    활동 로그
                </button>
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
                    <div className="bg-white rounded-[2.5rem] shadow-sm border border-slate-100 overflow-hidden mb-8">
                        <table className="w-full text-sm text-left text-slate-600">
                            <thead className="bg-slate-50/50 text-xs text-slate-400 font-extrabold uppercase tracking-wider border-b border-slate-100">
                                <tr>
                                    {['ID', '이름', '소속팀', '권한', '상태', '생성일', '관리'].map(h => <th key={h} className="px-8 py-5">{h}</th>)}
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-50">
                                {users.map(u => (
                                    <tr key={u.id} className="hover:bg-slate-50/80 transition">
                                        <td className="px-8 py-5 font-bold text-slate-900">{u.id}</td>
                                        <td className="px-8 py-5 font-medium">{u.name}</td>
                                        <td className="px-8 py-5">{TEAMS_CONFIG[u.team]?.title || u.team}</td>
                                        <td className="px-8 py-5"><span className={`px-3 py-1 text-xs font-bold rounded-lg ${u.role === 'admin' ? 'bg-red-100 text-red-700' : u.role === 'manager' ? 'bg-orange-100 text-orange-700' : 'bg-blue-100 text-blue-700'}`}>{u.role}</span></td>
                                        <td className="px-8 py-5">
                                            <span
                                                onClick={() => currentUser.role === 'admin' && handleToggleUserStatus(u.id)}
                                                className={`px-3 py-1 text-xs font-bold rounded-lg ${currentUser.role === 'admin' ? 'cursor-pointer' : 'cursor-not-allowed opacity-60'
                                                    } ${u.status === 'active' ? 'bg-green-100 text-green-700' : 'bg-slate-200 text-slate-600'}`}
                                            >
                                                {u.status === 'active' ? '활성' : '정지'}
                                            </span>
                                        </td>
                                        <td className="px-8 py-5 text-slate-400">{u.createdDate}</td>
                                        <td className="px-8 py-5 flex items-center gap-3">
                                            {currentUser.role === 'admin' ? (
                                                <>
                                                    <button onClick={() => handleOpenEditModal(u)} className="text-blue-600 font-bold text-xs hover:underline">수정</button>
                                                    <button onClick={() => handleResetPassword(u.id)} className="text-green-600 font-bold text-xs hover:underline">비번초기화</button>
                                                    <button onClick={() => handleDeleteUser(u.id)} className="text-red-500 font-bold text-xs hover:underline">삭제</button>
                                                </>
                                            ) : (
                                                <span className="text-gray-400 text-xs">권한 없음</span>
                                            )}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
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
            ) : (
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
            )}

            {isAddModalOpen && <div className="fixed inset-0 bg-black/30 backdrop-blur-sm flex items-center justify-center z-50 p-4"><div className="bg-white rounded-[2rem] shadow-2xl p-8 space-y-6 w-full max-w-md animate-scale-in"><h2 className="text-2xl font-extrabold text-slate-900">사용자 추가</h2><form onSubmit={handleAddNewUser} className="space-y-4">{addUserError && <p className="text-red-500 text-sm bg-red-50 p-3 rounded-xl font-bold">{addUserError}</p>}<div><label className="block text-xs font-bold text-slate-400 mb-1 ml-1">아이디</label><input type="text" value={newUser.id || ''} onChange={(e) => setNewUser({ ...newUser, id: e.target.value })} className="w-full px-4 py-3 bg-slate-50 rounded-xl font-bold text-slate-800 focus:ring-2 focus:ring-blue-500/20 outline-none" required /></div><div><label className="block text-xs font-bold text-slate-400 mb-1 ml-1">이름</label><input type="text" value={newUser.name || ''} onChange={(e) => setNewUser({ ...newUser, name: e.target.value })} className="w-full px-4 py-3 bg-slate-50 rounded-xl font-bold text-slate-800 focus:ring-2 focus:ring-blue-500/20 outline-none" required /></div><div><label className="block text-xs font-bold text-slate-400 mb-1 ml-1">비밀번호</label><input type="password" value={newUser.password || ''} onChange={(e) => setNewUser({ ...newUser, password: e.target.value })} className="w-full px-4 py-3 bg-slate-50 rounded-xl font-bold text-slate-800 focus:ring-2 focus:ring-blue-500/20 outline-none" required /></div><div><label className="block text-xs font-bold text-slate-400 mb-1 ml-1">소속팀</label><select value={newUser.team || '증진팀'} onChange={(e) => setNewUser({ ...newUser, team: e.target.value as any })} className="w-full px-4 py-3 bg-slate-50 rounded-xl font-bold text-slate-800 focus:ring-2 focus:ring-blue-500/20 outline-none appearance-none">{ALL_TEAMS.map(team => <option key={team} value={team}>{TEAMS_CONFIG[team]?.title || team}</option>)}</select></div><div><label className="block text-xs font-bold text-slate-400 mb-1 ml-1">권한</label><select value={newUser.role || 'user'} onChange={(e) => setNewUser({ ...newUser, role: e.target.value as any })} className="w-full px-4 py-3 bg-slate-50 rounded-xl font-bold text-slate-800 focus:ring-2 focus:ring-blue-500/20 outline-none appearance-none"><option value="user">사용자</option><option value="manager">매니저</option><option value="admin">관리자</option></select></div><div className="flex justify-end gap-3 pt-4"><button type="button" onClick={handleCloseAddModal} className="px-6 py-3 bg-slate-100 rounded-xl font-bold text-slate-500 hover:bg-slate-200 transition" disabled={isSubmitting}>취소</button><button type="submit" className="px-6 py-3 bg-blue-600 text-white rounded-xl font-bold hover:bg-blue-700 transition shadow-lg shadow-blue-600/20 disabled:opacity-50 disabled:cursor-not-allowed" disabled={isSubmitting}>{isSubmitting ? '생성 중...' : '생성'}</button></div></form></div></div>}

            {isEditModalOpen && editingUser && <div className="fixed inset-0 bg-black/30 backdrop-blur-sm flex items-center justify-center z-50 p-4"><div className="bg-white rounded-[2rem] shadow-2xl p-8 space-y-6 w-full max-w-md animate-scale-in"><h2 className="text-2xl font-extrabold text-slate-900">계정 수정</h2><form onSubmit={handleUpdateUser} className="space-y-4"><div><label className="block text-xs font-bold text-slate-400 mb-1 ml-1">이름</label><input type="text" value={editingUser.name || ''} onChange={(e) => setEditingUser({ ...editingUser, name: e.target.value })} className="w-full px-4 py-3 bg-slate-50 rounded-xl font-bold text-slate-800 outline-none" required /></div>                            <div><label className="block text-xs font-bold text-slate-400 mb-1 ml-1">소속팀</label><select value={editingUser.team || '증진팀'} onChange={(e) => setEditingUser({ ...editingUser, team: e.target.value as any })} className="w-full px-4 py-3 bg-slate-50 rounded-xl font-bold text-slate-800 outline-none">{ALL_TEAMS.map(team => <option key={team} value={team}>{TEAMS_CONFIG[team]?.title || team}</option>)}</select></div>

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

                <div className="flex justify-end gap-3 pt-4"><button type="button" onClick={handleCloseEditModal} className="px-6 py-3 bg-slate-100 rounded-xl font-bold text-slate-500">취소</button><button type="submit" className="px-6 py-3 bg-blue-600 text-white rounded-xl font-bold shadow-lg">저장</button></div></form></div></div>}

            {isChangePasswordModalOpen && (
                <div className="fixed inset-0 bg-black/30 backdrop-blur-sm flex items-center justify-center z-50 p-4">
                    <div className="bg-white rounded-[2rem] shadow-2xl p-8 space-y-6 w-full max-w-md animate-scale-in">
                        <h2 className="text-2xl font-extrabold text-slate-900">비밀번호 변경</h2>
                        <form onSubmit={handleChangePassword} className="space-y-4">
                            <div>
                                <label className="block text-xs font-bold text-slate-400 mb-1 ml-1">현재 비밀번호</label>
                                <input type="password" value={passwordData.oldPassword} onChange={(e) => setPasswordData({ ...passwordData, oldPassword: e.target.value })} className="w-full px-4 py-3 bg-slate-50 rounded-xl font-bold text-slate-800 outline-none focus:ring-2 focus:ring-blue-500/20" required placeholder="현재 사용 중인 비밀번호" />
                            </div>
                            <div>
                                <label className="block text-xs font-bold text-slate-400 mb-1 ml-1">새 비밀번호</label>
                                <input type="password" value={passwordData.newPassword} onChange={(e) => setPasswordData({ ...passwordData, newPassword: e.target.value })} className="w-full px-4 py-3 bg-slate-50 rounded-xl font-bold text-slate-800 outline-none focus:ring-2 focus:ring-blue-500/20" required placeholder="변경할 비밀번호" />
                            </div>
                            <div>
                                <label className="block text-xs font-bold text-slate-400 mb-1 ml-1">새 비밀번호 확인</label>
                                <input type="password" value={passwordData.confirmPassword} onChange={(e) => setPasswordData({ ...passwordData, confirmPassword: e.target.value })} className="w-full px-4 py-3 bg-slate-50 rounded-xl font-bold text-slate-800 outline-none focus:ring-2 focus:ring-blue-500/20" required placeholder="비밀번호 재입력" />
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
