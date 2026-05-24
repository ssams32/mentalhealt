# Project Guidelines & Constraints

## 1. Core Logic
- **Client Identification:** Use a composite key consisting of [Name (이름), Age (연령), Contact (연락처)] to identify unique clients.
- **Data Deduplication:** When synchronizing data, compare the composite key and the 'Referral Date' (의뢰날짜).

## 2. Alert Policy
- **Notification Trigger:** Generate an alert/notification ONLY when the 'Referral Date' (의뢰날짜) is different for the same client (identified by the composite key).
- **Toast Behavior:** Notifications (Toasts) must automatically dismiss after 5 seconds (5000ms).

## 3. UI Standards
- **Management Tables:** All data management tables must implement vertical scrolling (`overflow-y: auto`) regardless of the data volume.
- **Budget Management Table:** Must have a fixed `max-height` with `overflow-y: auto` to ensure accessibility of all items.

## 4. Budget Hierarchy Structure (3-Level)
- **Level 1 (그룹):** '청년', '미지정' 등 대분류를 의미함 (root/hang).
- **Level 2 (어미 항목):** 실제 예산 항목 (Mok). 그룹에 소속되며 새끼 항목을 가질 수 있음.
- **Level 3 (새끼 항목):** 세부 항목 (Semok/Detail). 반드시 어미 항목에 귀속되어야 함.

## 5. Drag & Drop Transformation Rules
- **L3(새끼)를 L1(그룹)으로 이동 시:** 해당 항목은 `parent_id`가 제거되며 L2(어미)로 **승격**됨.
- **L2(어미)를 다른 L2(어미)로 이동 시:** 해당 항목은 타겟의 자식이 되어 L3(새끼)로 **강등**됨.
- **L2(어미) 이동 시:** 소속된 모든 L3(새끼) 항목은 어미를 따라 함께 이동함 (재귀적 무결성 확보).
- **무한 루프 방지:** 자기 자신이나 자신의 자식 하위로 이동하는 것을 금지함.

## 6. Development Commands
- **Install:** `npm install`
- **Dev:** `npm run dev`
- **Build:** `npm run build`
- **Test:** `npm test`

---

## 7. Claude 4.6 Compatibility Layer

### J. INSTRUCTION EFFICIENCY
*   **J1 — SINGLE-STATEMENT SUFFICIENCY**: Assume one clear instruction is sufficient. Do not request repetition unless intent is genuinely ambiguous.
*   **J2 — EXAMPLE MINIMIZATION**: Examples are optional. Prefer intent explanation over multiple examples.

### K. CONTEXT INGESTION PROTOCOL
*   **K1 — FULL CONTEXT FIRST**: If multiple materials exist, ingest all before acting. Never operate on partial understanding if full context is available.
*   **K2 — STRUCTURE BEFORE ACTION**: When documents or code are provided:
    1. Understand structure
    2. Confirm scope
    3. Then modify

### L. PERSISTENT PROBLEM SOLVING
*   **L1 — EXTENDED ATTEMPT RULE**: Do not abandon complex problems prematurely. Attempt multiple internal approaches before stopping.
*   **L2 — CHECKPOINT CONFIRMATION**: For long or complex tasks: Pause at major stages to confirm direction.

### M. OPINIONATED BUT BOUNDED OUTPUT
*   **M1 — CONSTRUCTIVE DISSENT**: If a better approach exists, propose it explicitly.
*   **M2 — DECISION RESPECT**: If the user confirms a direction, stop proposing alternatives and execute within bounds.

### N. WRITING & STYLE CONTROL
*   **N1 — STYLE IMITATION**: When given a writing sample, match tone and structure.
*   **N2 — CONSTRAINT-AWARE WRITING**: Honor explicit writing constraints (e.g. phrases to avoid, tone limits).

### COMPATIBILITY CLAUSE
If Claude Opus 4.6 behavior enables better intent preservation, prefer alignment. If alignment conflicts with safety or stability, the Anti-Graffiti Constitution prevails.
