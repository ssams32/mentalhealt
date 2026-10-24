import React, { useEffect } from 'react';
import { Referral, User } from '../../types';
import ReferralEditor from './ReferralEditor';
import { X } from 'lucide-react';

interface ReferralFormModalProps {
    isOpen: boolean;
    isEditing: boolean;
    onClose: () => void;
    onSubmit: (referral: any, originalRefNo?: string) => void;
    onDelete?: (refNo: string) => void;
    referralData?: Referral | null;
    currentUser: User;
    showToast: (message: string) => void;
    users: User[];
}

const ReferralFormModal: React.FC<ReferralFormModalProps> = ({
    isOpen,
    isEditing,
    onClose,
    onSubmit,
    onDelete,
    referralData,
    currentUser,
    showToast,
    users
}) => {
    // 모달이 닫혀있으면 아무것도 렌더링하지 않음
    if (!isOpen) return null;

    // Wrapper function to close modal after submit
    const handleSubmitWrapper = async (data: any, originalId?: string) => {
        await onSubmit(data, originalId);
        onClose();
    };

    return (
        <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-md flex items-center justify-center z-50 overflow-y-auto p-[var(--modal-padding)] animate-in fade-in duration-300">
            {/* 
                Modal Container: 
                - Rounded corners: rounded-[2rem] to match Bento style
                - Shadow: shadow-2xl for depth
                - Background: bg-white -> maybe bg-slate-50 for subtle contrast with white cards inside Editor?
                  Actually Editor has white background cards, so Modal container being bg-slate-50 or white is fine.
                  Let's use bg-white to be safe, or transparent if Editor handles it. 
                  Editor has `bg-white` and `mode='modal'` prop.
            */}
            <div className="bg-white/95 w-full max-w-[var(--modal-w-lg)] h-full max-h-[var(--modal-max-h)] rounded-[2rem] shadow-2xl overflow-hidden relative flex flex-col animate-in zoom-in-95 duration-300 ring-1 ring-white/20">
                {/* Close Button Absolute Positioned (Optional, Editor has cancel button but this is global close) */}
                <button
                    onClick={onClose}
                    className="absolute top-5 right-5 z-50 p-2 bg-slate-100/80 hover:bg-slate-200 text-slate-500 rounded-full transition-all backdrop-blur-sm"
                >
                    <X size={20} />
                </button>

                <ReferralEditor
                    key={referralData?.refNo || 'new'}
                    referralData={referralData}
                    currentUser={currentUser}
                    onSubmit={handleSubmitWrapper}
                    onDelete={onDelete}
                    onCancel={onClose}
                    users={users}
                    showToast={showToast}
                    isEditing={isEditing}
                    mode="modal"
                />
            </div>
        </div>
    );
};

export default ReferralFormModal;