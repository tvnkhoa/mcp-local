## MCP-ISSUE-102 — a linked git worktree beside its main checkout could not be indexed

- **Status:** ✅ FIXED 2026-10-27 (wec.aria request, C3).
- **Scenario:** `assertPathAllowed` is a path-prefix check against `CODEBASE_INDEX_ALLOWED_ROOTS`. A worktree made
  with `git worktree add ../wt-x` lives beside the checkout, so `index_repository` refused it, and the only
  workaround was widening the allowed roots.
- **Fix:** when the prefix check fails, `resolveGitCommonDir` (`gitHelpers.ts`, file reads, no spawn) decides.
  The path is accepted iff
  - its `.git` file's `gitdir:` target sits in `<common>/worktrees/<name>`, and
  - that entry's own `gitdir` file names this `.git` back (it is a REGISTERED worktree), and
  - the realpath of `<common>` lies inside a realpath of an allowed root.

  A `.git` file that only points into an allowed repository has no back-link and is refused. The roots are never
  widened. It is indexed under the caller's repoId with its own HEAD. `list_repositories` and `health_check`
  report `worktreeOf`: the repoId of the registered main checkout owning that common dir, or null.
- **Guarded:** `indexGuardrailsWorktree.test.ts` (temp repo + `git worktree add`: accepted with its branch's HEAD;
  unregistered sibling refused; forged `.git` files refused; unrelated root refused; `worktreeOf`; junctioned `.git` directory refused; symlinked `.git` refused, skipped on
  EPERM; worktree subdirectory refused).
- **Hardening (follow-up, review finding):** outside the roots only a linked worktree is accepted. `.git` is read
  with `lstat`: a symlink or junction is never followed, and a `.git` directory (real or junctioned to an allowed
  repo's) is refused, since a directory carries no back-link. The back-link is compared with
  `<realpath(repoPath)>/.git` without resolving `.git` itself. A subdirectory of a worktree is refused.
- **Not covered:** a worktree whose main checkout is not registered is accepted but reports `worktreeOf: null`.

