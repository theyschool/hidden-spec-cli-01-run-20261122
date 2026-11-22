# mend — one patch tool for every AI edit format

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/theyschool/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/theyschool/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

`mend` applies an edit that an AI model wrote to a tree of text files. Models write edits in four formats — a unified diff (often with wrong line numbers), SEARCH/REPLACE blocks, the V4A patch format, and text-editor tool calls as JSON — and `mend` reads all four, matches lines fuzzily at three tiers (exact, trailing-whitespace-insensitive, fully whitespace-insensitive with re-indentation), and applies the whole patch atomically: every file changes, or nothing does. See `SPEC.md` for the full specification.

## Run it

```
node main.ts [options] [PATCH]
```

Options: `--format=unified|search-replace|v4a|json|auto` (default `auto`, detected from the patch), `--check` (report what would change, write nothing), `--strict` (exact line matches only). `PATCH` is the patch file, or `-`/absent to read it from standard input. Exit code 0 lists the changed files (`A`/`D`/`M`, `R old -> new` for moves) and `ok: n files`; 1 lists each failed edit and `failed: k of n edits`; 2 is a usage, missing-patch, format-detection or parse error.

## Files

- `main.ts` — the CLI, Node 22 standard library only.
- `runner.ts` — the trial runner (kept as supplied by the kit).
- `check.ts` — the local practice runner: `node check.ts <practice.json>`.
- `SPEC.md` — the whole specification.
- `LICENSE` — MIT.

## Ambiguities

Where `SPEC.md` leaves a choice, this is what `mend` does:

- "A section starts at a `diff --git a/<X> b/<Y>` line, or at a `--- ` line followed by a `+++ ` line that is not already part of a section's header." A second `--- `/`+++ ` pair in a header that already has one is therefore read as the start of a new section, not as a replacement pair.
- "A `--- ` line not followed by a `+++ ` line, inside a section's header, is `error: parse <the line after it>`." A lone `--- ` line outside any section is not inside a section's header, so it is ignored as prose.
- "A `*** End of File` line ends a chunk and anchors it to the end of the file." With no open chunk there is nothing to end, so a stray `*** End of File` is `error: parse <its line>`.
- Tier-2 re-indentation ("a line of N that is not empty and not only whitespace, and starts with P, has that P replaced by F") is applied literally, including when P is empty: then F is prepended to the line.
- A `diff --git` line with trailing spaces or tabs is accepted as being of the stated form.

<sub>Entered on [make.fun](https://make.fun/?ref=w0xx5wp9&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
