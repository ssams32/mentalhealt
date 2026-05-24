# ISP Evaluation Engine Handoff Document

This document summarizes the business logic and evaluation rules implemented for the ISP Intervention Achievement system.

## 1. Applied Formulas (Dynamic Targeting)
The engine dynamically calculates the target counseling count based on the duration of the management category within the period.

| 관리구분 (Category) | 기준 (Rule) | 수식 (Formula) |
| :--- | :--- | :--- |
| **집중관리 (Intensive)** | 매주 1회 이상 | `CEIL(days / 7.0)` |
| **유지관리 (Maintenance)** | 매월 1회 이상 | `CEIL(days / 30.0)` |
| **일시관리 (Temporary)** | 3개월 1회 이상 | `CEIL(days / 90.0)` |

## 2. Multi-tier Appropriateness Evaluation
The engine evaluates intervention levels into three distinct tiers based on the `OVER_THRESHOLD` (Default: 2 sessions).

| 상태 (Status) | 조건 (Condition) | UI 색상 (Color) |
| :--- | :--- | :--- |
| **개입 부족 (미달)** | `actual < target` | Red (Rose) |
| **적정 개입 (달성)** | `target <= actual <= target + 2` | Green (Emerald) |
| **과잉 개입 (점검 요망)** | `actual > target + 2` | Orange (Amber) |

## 3. Resolved Edge Cases
- **[Case A] Short Durations**: `CEIL` logic ensures a minimum of 1 session target even for partial months.
- **[Case B] Face-to-Face Filter**: Only `visit` and `inOffice` sessions are counted.
- **[Case C] Over-intervention Detection**: If an '일시관리' member (Target 1) receives 4 sessions, the system flags it as '과잉 개입', allowing managers to consider upgrading the ISP category to '유지관리' or '집중관리'.

## 3. Data Structure (Backend ➔ Frontend)
The API returns an array of the following objects:

```json
{
  "memberId": "C001",
  "memberName": "홍길동",
  "managementCategory": "집중관리",
  "targetSessions": 5,
  "actualSessions": 4,
  "achievementRate": 80,
  "status": "fail",
  "statusText": "개입 부족 (미달)"
}
```

## 4. Frontend Integration
- **Component**: `ISPAnalysisTab.tsx`
- **Hook**: `useEffect` on `selectedMonth` change.
- **API**: `apiClient.getISPAchievement(month)`
