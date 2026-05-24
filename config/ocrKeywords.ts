export const OCR_KEYWORDS = [
    // Red - Suicide Risk (#ff6b6b)
    { keyword: '자살', color: '#ff6b6b' },
    { keyword: '자살충동', color: '#ff6b6b' },
    { keyword: '자살위험', color: '#ff6b6b' },
    { keyword: '자살시도', color: '#ff6b6b' },
    { keyword: '자해', color: '#ff6b6b' },
    { keyword: '자포자기', color: '#ff6b6b' },
    { keyword: '자살예방', color: '#ff6b6b' },
    { keyword: '자살고위험군', color: '#ff6b6b' },

    // Orange - Psychosis/Trauma (#ffa726)
    { keyword: '조증', color: '#ffa726' },
    { keyword: '조현병', color: '#ffa726' },
    { keyword: '망상', color: '#ffa726' },
    { keyword: '환청', color: '#ffa726' },
    { keyword: '환각', color: '#ffa726' },
    { keyword: '공격성', color: '#ffa726' },
    { keyword: '폭력', color: '#ffa726' },
    { keyword: '학대', color: '#ffa726' },
    { keyword: '성폭력', color: '#ffa726' },
    { keyword: '강박', color: '#ffa726' },
    { keyword: '공황', color: '#ffa726' },
    { keyword: 'PTSD', color: '#ffa726' },
    { keyword: '트라우마', color: '#ffa726' },

    // Light Yellow - Depression/Isolation (#fff59d)
    { keyword: '우울', color: '#fff59d' },
    { keyword: '불안', color: '#fff59d' },
    { keyword: '무기력', color: '#fff59d' },
    { keyword: '무가치감', color: '#fff59d' },
    { keyword: '고립', color: '#fff59d' },
    { keyword: '집중력저하', color: '#fff59d' },
    { keyword: '기분변화', color: '#fff59d' },
    { keyword: '불면', color: '#fff59d' },
    { keyword: '자기혐오', color: '#fff59d' },
    { keyword: '소외', color: '#fff59d' },

    // Light Green - Addiction/Family/Economy (#c6ff9d)
    { keyword: '알코올', color: '#c6ff9d' },
    { keyword: '중독', color: '#c6ff9d' },
    { keyword: '마약', color: '#c6ff9d' },
    { keyword: '도박', color: '#c6ff9d' },
    { keyword: '가족갈등', color: '#c6ff9d' },
    { keyword: '가정폭력', color: '#c6ff9d' },
    { keyword: '경제적어려움', color: '#c6ff9d' },

    // Blue - Resources/Support (#6bc1ff)
    { keyword: '자원연계', color: '#6bc1ff' },
    { keyword: '자원지원', color: '#6bc1ff' },
    { keyword: '지역자원', color: '#6bc1ff' },
    { keyword: '치료연계', color: '#6bc1ff' },
    { keyword: '프로그램', color: '#6bc1ff' },
];

export const MASKING_RULES = [
    // Resident Registration Number (e.g., 900101-1234567 -> 900101-*******)
    { regex: /(\d{6})[- ]?[1-4]\d{6}/g, mask: '$1-*******' },
    // Phone Number (e.g., 010-1234-5678 -> 010-****-5678)
    { regex: /(01[016789])[- ]?(\d{3,4})[- ]?(\d{4})/g, mask: '$1-****-$3' },
    // Email (e.g., user@example.com -> use***@example.com)
    { regex: /([a-zA-Z0-9._-]+)@([a-zA-Z0-9._-]+\.[a-zA-Z0-9_-]+)/g, mask: '***@$2' }
];
