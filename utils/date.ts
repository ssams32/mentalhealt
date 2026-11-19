const kstDateFormat = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
});

export function toKSTDateString(date: Date): string {
    return kstDateFormat.format(date);
}

export function todayKST(): string {
    return toKSTDateString(new Date());
}
