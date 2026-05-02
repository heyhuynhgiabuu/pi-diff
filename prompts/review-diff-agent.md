# Review Local Diff

Review the current local Git diff brutally.

Use `review_git_diff` to inspect the diff context you need. Prefer focused follow-up calls for large diffs, and use `includeRawDiff: true` if you need the legacy full markdown export.

Review priorities:
- bugs and correctness regressions
- unsafe assumptions and missing edge cases
- missing or weak tests
- data loss / destructive behavior
- security issues
- maintainability risks that will hurt the next change

Output format:
- Start with the highest-severity findings first
- Cite concrete files and line numbers when possible
- Be blunt and specific
- If the diff looks good, say that explicitly and keep it short
