# Diet mapping corpus

The two named goldens specify the complete MealPlanDraft independently of the mapper.
Inputs are the corresponding normalized document, extraction and `userDecisions`
in `../../manifest.json`. Tests reserve the plan ID ending in 002 and item IDs
ending in 010 + current item index. Food items use their parent meal as provenance
target. No provenance or evidence is included in either golden document.

`reviewed-conditions.json` applies its additional decisions to `diet-spec-example`
and specifies the expected plan with a confirmed empty quantity, an explicit day
type, complete alternative groups, nutrients and food conditions.

Additional decision-based cases in `import-diet-mapping.test.ts` cover missing
quantities, explicit day types, two complete breakfast options, duplicated food
names/notes, scope and global-rule regressions, empty content, code points, UTF-8
byte bounds and stable reservations. Alternatives and quantities are not normalized.
