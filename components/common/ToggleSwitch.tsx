
import React from 'react';

interface ToggleSwitchProps {
    checked: boolean;
    onChange: (checked: boolean) => void;
}

const ToggleSwitch: React.FC<ToggleSwitchProps> = ({ checked, onChange }) => {
    return (
        <button
            type="button"
            role="switch"
            aria-checked={checked}
            onClick={() => onChange(!checked)}
            className={`relative inline-flex items-center h-6 w-11 rounded-full transition-all duration-200 ease-in-out focus:outline-none ${checked ? 'bg-emerald-500' : 'bg-slate-200'}`}
        >
            <span
                className={`inline-block w-5 h-5 transform bg-white rounded-full transition-all duration-200 ease-in-out shadow-md ${checked ? 'translate-x-5.5' : 'translate-x-0.5'}`}
            />
        </button>
    );
};

export default ToggleSwitch;
