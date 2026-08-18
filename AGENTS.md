# AGENTS.md — Constitución del proyecto

> **MANDATORY AGENT CONTRACT**
>
> These rules are mandatory. They are not suggestions.
> Before modifying ANY file, the agent MUST read this file completely.
> If a requested action conflicts with these rules, STOP and explain the conflict instead of proceeding.
>
> **Before coding, verify:**
>
> 1. `AGENTS.md` has been read completely.
> 2. `docs/memoria.md` has been read.
> 3. `docs/verificacion.md` has been read.
> 4. `git status` has been inspected.
> 5. The requested change has an explicit acceptance criterion.
>
> **After coding, verify:**
>
> 1. Build passes.
> 2. Tests pass.
> 3. `docs/memoria.md` is updated.
> 4. Any correction to previously documented data is added to `docs/verificacion.md`.
> 5. No commit or push is performed by the agent.
>
> **NEVER skip these steps.**
>
> If any required verification cannot be performed, explicitly report:
>
> `BLOCKED: <reason>`
>
> Do not claim completion when verification was not performed.
>
> ## Core rules
>
> * Code identifiers and comments: English.
> * Documentation: Spanish.
> * Never invent data or assume file/API state without reading it.
> * Consult live documentation before assuming API/library paths, fields, signatures, or behavior.
> * Never commit or push.
> * Always leave the exact commit command ready for the human.
>
> ## Comments — applies to every file, new and old
>
> * **Header, 2–3 lines, always.** First line of the file:
>   `// <filename>: <what this file does>`. Two or three lines total, no more.
> * **Inside the file, keep only what the code cannot say.** A trap, a non-obvious
>   decision, a bug that would come back. If a comment restates the code, delete it.
> * **No session history in code.** Dates, session numbers, "live bug 2026-07-26",
>   rationale narratives — that is `docs/memoria.md`. Code keeps the rule, not the story.
> * **No commented-out code.** Git remembers it.
> * **`.md` files: be concise.** Same test — say it once, drop the retelling.
> * When editing an old file, bring it to this shape before adding to it.
>
> ## SDD
>
> 1. Specify → `docs/plan.md`
> 2. Plan → `docs/memoria.md`
> 3. Tasks → `docs/plan.md`
> 4. Implement → code + docs
> 5. Verify → build + tests
>
> ## Write → Test → Fix
>
> `Write → Test → Fix`
>
> A task is NOT complete until verification succeeds.
>
> ## Session startup
>
> Execute/read in this order:
>
> ```text
> AGENTS.md
> docs/memoria.md
> docs/verificacion.md
> git status
> ```
>
> ## Completion contract
>
> Before reporting completion, output:
>
> ```text
> VERIFICATION
> - Build: PASS/FAIL
> - Tests: PASS/FAIL
> - Docs updated: YES/NO
> - git commit executed: NO
> - git push executed: NO
> ```
>
> If any required item is `FAIL` or `NO`, do not report the task as fully complete.
