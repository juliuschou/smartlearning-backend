---
name: requirements-analysis-process
description: Transform raw elicitation outputs into analyzed, modeled, and structured requirements. Use when moving from "what stakeholders said" to "what the system shall do" through visual modeling, data analysis, and requirements decomposition.
intent: >-
  Guide requirements engineers through the analysis process that transforms raw elicitation outputs (notes, transcripts, brainstorms) into structured, analyzed requirements. Orchestrates visual modeling (DFDs, state diagrams, decision tables), data analysis (data dictionary, CRUD matrix, ERDs), requirement decomposition, and conflict resolution. Use this when you have elicitation outputs that need to be refined, decomposed, modeled, and organized into a coherent specification.
type: workflow
theme: re-process
best_for:
  - "Transforming raw elicitation notes into structured requirements"
  - "Applying visual models to discover missing requirements"
  - "Decomposing high-level needs into detailed functional requirements"
scenarios:
  - "I have 3 hours of elicitation notes and need to turn them into a requirements specification"
  - "Requirements feel incomplete. I need a systematic approach to find the gaps."
estimated_time: "2-4 hours per major feature area"
---


## Purpose
Transform raw elicitation outputs into structured, analyzed, modeled requirements. This is the bridge between "what stakeholders said" and "what the system shall do."

This is not elicitation (gathering information) or validation (reviewing requirements). It is the analytical work in between -- decomposing, modeling, structuring, and gap-filling.

## Key Concepts

### The Analysis Process
```
Raw Elicitation Outputs
    |
    v
[Classify] - Sort into requirement types
    |
    v
[Model] - Create visual analysis models
    |
    v
[Decompose] - Break high-level needs into detailed requirements
    |
    v
[Analyze Data] - Define data elements and relationships
    |
    v
[Resolve Conflicts] - Identify and resolve inconsistencies
    |
    v
[Verify Completeness] - Check for gaps using models and checklists
    |
    v
Structured Requirements (ready for SRS)
```

### Analysis Techniques by Purpose

| Purpose | Technique | Skill Reference |
|---------|-----------|----------------|
| System boundary | Context diagram | `skills/context-diagram/SKILL.md` |
| Process flow | DFDs, swimlane diagrams | (inline in this workflow) |
| Object lifecycle | State-transition diagrams | `skills/state-modeling/SKILL.md` |
| Complex logic | Decision tables | `skills/decision-table/SKILL.md` |
| Data structure | ERDs, data dictionary | `skills/data-dictionary/SKILL.md` |
| Completeness | CRUD matrix | `skills/data-dictionary/SKILL.md` |
| Behavior | Use cases | `skills/use-case/SKILL.md` |
| Business rules | Rule catalog | `skills/business-rule/SKILL.md` |

## Application

### Phase 1: Classify Elicitation Outputs (30-60 min)

Take your raw elicitation notes and sort each item into categories:

1. **Functional requirements** -- What the system must do
2. **Quality attributes** -- Performance, security, usability expectations
3. **Business rules** -- Policies and constraints that govern behavior
4. **Data requirements** -- What data is needed, stored, processed
5. **Constraints** -- Technical or business limitations
6. **Assumptions** -- Things assumed true but not verified
7. **Open questions** -- Ambiguities that need follow-up
8. **Out of scope** -- Items explicitly excluded

For each item, note:
- Source (which stakeholder said this)
- Confidence level (clear / needs clarification / conflicting)

---

### Phase 2: Create Visual Models (1-2 hours)

Apply analysis models to discover missing requirements:

**2.1 Context Diagram** (if not done during scoping)
Use `skills/context-diagram/SKILL.md`:
- Identify all external entities and data flows
- Each data flow becomes a candidate for interface requirements

**2.2 Process Models**
For each major workflow:
- Draw a swimlane diagram showing actors and process steps
- Identify decision points (these become use case alternative flows or decision tables)
- Identify data stores (these feed the data dictionary)

**2.3 State Models**
Use `skills/state-modeling/SKILL.md`:
- For each key domain object (orders, chemicals, requests, etc.)
- List all states and events
- Build the state table and fill in every cell
- Empty cells = missing requirements

**2.4 Decision Tables**
Use `skills/decision-table/SKILL.md`:
- For any requirement with multiple interacting conditions
- Build the table, verify 2^N completeness
- Each rule becomes a testable requirement

---

### Phase 3: Decompose Requirements (1-2 hours)

Transform high-level needs into detailed, atomic requirements:

**3.1 From User Needs to System Behavior**
```
Stakeholder said: "I need to know when chemicals are about to expire."
    |
    v
User Requirement: "Lab technician needs expiration visibility."
    |
    v
Functional Requirements:
  - FR-1: System shall display expiration date in chemical list
  - FR-2: System shall highlight chemicals expiring within 30 days
  - FR-3: System shall send email alert at 30-day mark
  - FR-4: System shall send urgent email at 7-day mark
  - FR-5: System shall prevent expired chemicals from being assigned
```

**3.2 Apply EARS Templates**
Use the EARS patterns from `skills/srs-document/SKILL.md`:
- Ubiquitous: "The system shall [always do this]"
- Event-driven: "When [trigger], the system shall [response]"
- State-driven: "While [condition], the system shall [behavior]"
- Unwanted: "If [error], the system shall [handling]"
- Optional: "Where [feature included], the system shall [behavior]"

**3.3 Write Each Requirement**
For each decomposed requirement:
- Assign a unique ID
- Write using "shall" language
- Link to source (stakeholder, elicitation session)
- Link to business objective
- Identify business rules that apply
- Flag any remaining ambiguity as open questions

---

### Phase 4: Analyze Data (30-60 min)

Use `skills/data-dictionary/SKILL.md`:

**4.1 Build the Data Dictionary**
- Extract every data element mentioned in requirements
- Define each element: type, format, valid values
- Compose structures from primitives

**4.2 Create CRUD Matrix**
- Cross-reference data entities with system functions
- Identify missing operations (created but never read? read but never created?)
- Each gap is a potential missing requirement

**4.3 Define Entity Relationships**
- Draw ERD or class diagram showing key entities
- Identify cardinality (1:1, 1:N, M:N)
- Each relationship implies data integrity requirements

---

### Phase 5: Resolve Conflicts (30-60 min)

**5.1 Identify Conflicts**
During classification and modeling, you will find:
- Stakeholder A says X; Stakeholder B says not-X
- Two requirements that contradict each other
- A requirement that conflicts with a constraint

**5.2 Resolve Each Conflict**
For each conflict:
1. Document both positions with source
2. Identify the root cause (different user classes? different assumptions?)
3. Propose resolution options
4. Escalate to the appropriate stakeholder for decision
5. Document the decision and rationale

---

### Phase 6: Verify Completeness (30 min)

Use these systematic checks:

- [ ] Every data flow in the context diagram has at least one requirement
- [ ] Every cell in every state table is filled
- [ ] Every cell in the CRUD matrix is accounted for
- [ ] Every decision table has 2^N rules (or documented consolidation)
- [ ] Every business rule traces to at least one functional requirement
- [ ] Every user class (from stakeholder analysis) has at least one use case or user story
- [ ] Error handling is specified for every normal flow step
- [ ] Quality attributes are specified for all critical functions
- [ ] Open questions list is reviewed -- any remaining TBDs?

---

## Examples

See `examples/sample.md` for an analysis walkthrough.

## Common Pitfalls

### Pitfall 1: Skipping Visual Models
**Symptom:** Going directly from elicitation notes to writing requirements in an SRS.

**Consequence:** Missing requirements that visual models would reveal (unhandled states, incomplete data operations, missing decision rules).

**Fix:** Invest 1-2 hours in visual modeling. The CRUD matrix alone typically reveals 5-10 missing requirements.

---

### Pitfall 2: Writing Requirements at the Wrong Level
**Symptom:** Some requirements are high-level ("manage chemicals") and others are detailed ("validate CAS check digit using algorithm X").

**Consequence:** Inconsistent abstraction level makes the SRS hard to review, estimate, and test.

**Fix:** Decompose consistently. Each requirement should be at the same level of detail -- one testable behavior per requirement.

---

### Pitfall 3: Ignoring Conflicts
**Symptom:** Contradictory requirements from different stakeholders are both included in the SRS without resolution.

**Consequence:** Developers discover the contradiction during implementation and must make a design decision that should have been a requirements decision.

**Fix:** Resolve every conflict before baselining. Document the decision and rationale so the "losing" stakeholder understands why.

## References

### Related Skills (Orchestrated by This Workflow)
- `skills/context-diagram/SKILL.md` -- Phase 2: Boundary modeling
- `skills/state-modeling/SKILL.md` -- Phase 2: Object lifecycle modeling
- `skills/decision-table/SKILL.md` -- Phase 2: Complex logic analysis
- `skills/data-dictionary/SKILL.md` -- Phase 4: Data analysis and CRUD matrix
- `skills/use-case/SKILL.md` -- Phase 3: Behavioral decomposition
- `skills/business-rule/SKILL.md` -- Phase 1: Classification
- `skills/srs-document/SKILL.md` -- Final output structure

### External Frameworks
- Karl Wiegers & Joy Beatty, *Software Requirements, Third Edition* (2013) -- Chapters 12-13
- Tom DeMarco, *Structured Analysis and System Specification* (1979) -- DFDs and data dictionary
- Peter Chen, "The Entity-Relationship Model" (1976) -- Data modeling

---

**Skill type:** Workflow
**Dependencies:** Follows `skills/requirements-elicitation-workshop/SKILL.md`
**Outputs:** Ready-to-write requirements for `skills/srs-document/SKILL.md`
