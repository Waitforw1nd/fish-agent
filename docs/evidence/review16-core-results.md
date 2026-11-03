# Review 16 core evidence

Environment: Windows, bundled .tools/node/node.exe. Tests used local fixtures and did not connect to QQ or Bilibili.

- Download promotion failure: setup-download.mjs with a local HTTP server and an existing directory as the destination. Before the fix, the failure and preservation assertions passed, but the .part cleanup assertion failed (exit 1, 54 passed / 1 failed). After the fix, exit 0, 55 passed / 0 failed. Successful completion is now printed only after rename succeeds.
- node --test test/multi-entry.test.mjs test/memory-legacy-delete.test.mjs test/llm-error-redaction.test.mjs: exit 0, 27 passed, 0 failed, 0 skipped. This includes desktop tests owned elsewhere; no desktop files were edited.
- node --test test/headless-transport.test.mjs test/headless-runtime.test.mjs: exit 0, 26 passed, 0 failed, 1 skipped. Windows cannot deliver POSIX SIGTERM to Node; the conditional skip does not validate that shutdown path on Linux.
- Inspected OpenID encoding and member identity verification, memory legacy deletion, meter spool and acknowledgement handling, router deduplication and cross-entry checks. Passing tests do not establish exhaustive correctness.
- git diff --check on the two edited files: exit 0.

- Expanded promotion test: captured stderr with quiet:false and restored it in finally. An injected EACCES rename error retains its exact object and code; failed promotion preserves the destination, deletes the .part file, and does not print completion. A successful promotion prints completion and saves the complete payload.
- Reproducible in-memory negative control: review16-core-download-negative-loader.mjs restores the old ordering and direct rename only in the loaded module, without changing the worktree. review16-core-download-negative.txt: exit 1, 56 passed / 2 failed (temporary cleanup and false completion). review16-core-download-fixed.txt: exit 0, 58 passed / 0 failed. Both executions used review6-process-tracer.cjs and review16-core-processes.
