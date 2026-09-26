# SDIS Quality Management Architecture

Status: Step 1 — **architecture boundary documented; contract skeleton reserved.**

## 1. Why quality is first-class

Because SDIS is a diagnostic system, quality management is a first-class
architectural concern — not an afterthought.

## 2. Reserved future capabilities

```text
SOPs · document control · training records · competency ·
calibration · maintenance · QC · IQC · EQA/PT · nonconformities ·
corrective actions · preventive actions · risk management ·
incident management · audit · quality indicators · records retention
```

WHO laboratory quality guidance specifically emphasizes documented quality systems,
equipment/reagent management, records, document control, safety, and continual
quality management. SDIS design intent aligns with that structure.

## 3. Relationship to other domains

- **Documents** — SOPs, certificates, and quality documents live in the Document
  domain (`src/domain/documents/` contract), not scattered across modules.
- **Inventory** — reagent/kit/control batch and lot traceability connects to
  `src/domain/inventory/` (Laboratory Medical Inventory boundary).
- **Devices** — calibration and maintenance records reference the Device Registry
  (`src/domain/devices/`).
- **Audit/Provenance** — every quality artifact is audited.

## 4. Boundaries in code (Step 1)

`src/domain/quality/` exposes typed contract stubs for the quality families above,
so later modules integrate without core rewrites. No workflows are implemented.

## 5. Honest status

- **No accreditation readiness is claimed.**
- Documenting these concepts is not accreditation.
- Accreditation (e.g., ISO 15189) requires external audit and operational evidence
  that no software repository can substitute.
