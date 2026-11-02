---
name: Review checklist
description: Review a change for correctness, regressions, security and missing tests, with findings ordered by severity.
---

# Review checklist

Use this skill when the user asks you to review a change, a diff, a pull
request, or code they wrote. Do not use it for greenfield implementation.

## Method

1. Establish the scope first: which files changed, and what behavior was
   intended. Read the changed code and the existing tests around it before
   forming findings.
2. Check, in this order:
   - Correctness: wrong results, broken edge cases, error paths that
     swallow or misreport failures.
   - Regressions: behavior other callers rely on that this change alters.
   - Security: untrusted input reaching shells, queries, paths or HTML;
     secrets in code or logs; permission checks bypassed.
   - Tests: new behavior without coverage; tests that assert the
     implementation instead of the contract.
   - Simplicity: needless duplication or abstraction that will cost the
     next reader.
3. Verify at least one finding candidate against the real code or a test
   run before reporting it as a defect. Label anything you could not
   verify as a question, not a finding.

## Report shape

- Lead with the highest-severity finding.
- Give each finding a file and line, the concrete failure scenario, and a
  suggested fix.
- Separate proven defects from questions and style preferences.
- End with what you checked and found sound, so the reader knows the
  review's coverage.
- If you find nothing, say so plainly and name the residual risks.
