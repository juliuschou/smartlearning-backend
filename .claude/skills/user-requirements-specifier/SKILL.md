---
name: user-requirements-specifier
description: Transform vague feature ideas or business requests into structured User Requirements, Agile User Stories, Gherkin Acceptance Criteria, and edge-case specifications. Use when the user asks to write user requirements, PRD sections, user stories, acceptance criteria, or functional specifications.
---

# User Requirements Specifier

A skill for translating high-level product ideas or stakeholder requests into rigorous, developer-ready user requirements and acceptance criteria.

## When to Use

- The user wants to write or refine user requirements (使用者需求), User Stories, or functional specifications.
- The user provides a rough feature idea and needs Acceptance Criteria (驗收條件) or edge-case analysis.
- The user wants to review existing requirements for ambiguity or missing scenarios.

## Workflow

### Step 1: Clarify Context and Scope
Before drafting full specifications, check if critical context is missing:
1. Identify the target user persona (Who), the core action (What), and the business value (Why).
2. If the prompt is overly broad, ask 2 to 3 targeted clarifying questions regarding permissions, platform constraints, or key business rules before generating the full spec. Otherwise, state reasonable assumptions explicitly and proceed.

### Step 2: Write the User Story and Value
Structure each requirement around user value using standard Agile format:
- **角色 (As a)**: Specify the exact user role or permission level.
- **需求 (I want to)**: Describe the behavior or goal, not the UI implementation detail.
- **價值 (So that)**: Articulate the concrete benefit or problem solved.

### Step 3: Define Acceptance Criteria (Gherkin Format)
Break down testable rules using `Given / When / Then` syntax. Ensure coverage across three dimensions:
1. **Happy Path (正向主流程)**: Standard successful operation.
2. **Validation and Alternative Flows (驗證與替代流程)**: Input limits, empty states, formatting errors, or cancellation actions.
3. **Edge Cases and Permissions (邊界條件與異常處理)**: Network timeouts, unauthorized access, concurrent modifications, or state conflicts.

### Step 4: Specify Non-Functional and UI/Data Constraints
Append a concise checklist of technical and operational boundaries:
- **Data / Validation Rules**: Field types, character limits, required vs. optional states.
- **Non-Functional Requirements (NFRs)**: Performance expectations, security/privacy constraints, or audit logging needs.
- **Open Questions (待確認事項)**: Flag any dependencies or policy decisions that require stakeholder sign-off.

## Output Template

### 1. 需求概覽與假設 (Overview & Assumptions)
- **功能目標**：[一句話總結]
- **前置條件 / 假設**：[列出系統狀態或權限假設]

### 2. 使用者故事 (User Story)
> **身為** [具體角色]
> **我希望** [執行某項操作或達成某個行為]
> **以便於** [獲得的商業或使用價值]

### 3. 驗收條件 (Acceptance Criteria)
- **場景 1：[正向流程名稱]**
  - **Given** [前置狀態]
  - **When** [觸發動作]
  - **Then** [預期結果與系統狀態變更]
- **場景 2：[異常或邊界狀況名稱]**
  - **Given** [前置狀態]
  - **When** [錯誤輸入或異常操作]
  - **Then** [錯誤提示或防呆機制]

### 4. 欄位規範與邊界檢查 (Rules & Edge Cases)
- **資料與欄位限制**：[格式、長度、必填限制]
- **非功能性需求 (NFR)**：[效能、權限、相容性或資安要求]
- **待釐清問題 (Open Questions)**：[需要與 PM、設計或工程確認的細節]

## Gotchas
- Avoid prescribing specific UI elements (e.g., "click the blue button in the top right") unless the request is strictly a UI change; focus on user intent and system response.
- Never write vague criteria like "the system should be fast" or "show an appropriate error message". Specify exact behavior or mark it with a placeholder for the exact error copy/threshold.