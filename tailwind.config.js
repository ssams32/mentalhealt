/*
 * Copyright (c) 2026 Your Company Name. All Rights Reserved.
 *
 * This source code is licensed under the license found in the
 * LICENSE file in the root directory of this source tree.
 */
/** @type {import('tailwindcss').Config} */
export default {
    content: [
        "./index.html",
        "./App.tsx",
        "./index.tsx",
        "./components/**/*.{js,ts,jsx,tsx}",
        "./services/**/*.{js,ts,jsx,tsx}",
    ],
    theme: {
        extend: {
            colors: {
                slate: {
                    50: '#F8F9FA',
                    400: '#94A3B8',
                    800: '#1E293B',
                },
                blue: {
                    50: '#EFF6FF',
                    600: '#2563EB',
                },
                violet: {
                    50: '#F5F3FF',
                    600: '#7C3AED',
                },
                emerald: {
                    50: '#ECFDF5',
                    500: '#10B981',
                },
                rose: {
                    50: '#FFF1F2',
                    500: '#F43F5E',
                },
            },
            boxShadow: {
                'anti-gravity': '0 10px 40px -10px rgba(0,0,0,0.05)',
                'anti-gravity-hover': '0 20px 50px -10px rgba(0,0,0,0.08)',
                'bento': '0 0 0 1px rgba(0,0,0,0.03), 0 2px 4px rgba(0,0,0,0.02), 0 12px 24px -12px rgba(0,0,0,0.1)',
                'bento-hover': '0 20px 40px -16px rgba(0,0,0,0.12)',
            },
            borderRadius: {
                'xl': '12px',
                '2xl': '16px',
                '3xl': '24px',
                '4xl': '32px',
            },
            letterSpacing: {
                tightest: '-0.02em',
            },
            screens: {
                'lg': '992px',
            },
        },
    },
    plugins: [],
}
