# Domain Docs

OpenFilm uses a single-context layout shared by `apps/desktop`, `packages/openfilm`, and `packages/shared`.

## Before exploring, read these

- **`GLOSSARY.md`** at the repository root for the shared domain vocabulary.
- **`docs/adr/`** at the repository root: read ADRs that touch the area you are about to work in.

If any of these files do not exist, **proceed silently**. Do not flag their absence or suggest creating them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved.

## File structure

```text
/
├── GLOSSARY.md
├── docs/adr/
├── apps/desktop/
├── packages/openfilm/
└── packages/shared/
```

The glossary and ADRs apply across all packages. Do not create separate per-package domain documentation by default.

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, or a test name), use the term as defined in `GLOSSARY.md`. Do not drift to synonyms the glossary explicitly avoids.

If a concept is not in the glossary, reconsider whether it belongs to the project's domain language or note a real gap for `/domain-modeling`.

## Flag ADR conflicts

If your output contradicts an existing ADR, surface the conflict explicitly rather than silently overriding it. Identify the ADR and explain why reopening the decision might be appropriate.
