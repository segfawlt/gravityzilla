---
title: Shell mutation classifiers and git --no-optional-locks flag ordering
category: logic-errors
module: bin/agy-compound, bin/agy-watch
tags: [shell-parsing, regex, redirects, git-flags, stop-hook, pre-tool-hook]
problem_type: logic-error
date: 2026-11-19
---

# Shell Mutation Classifiers and `git --no-optional-locks` Flag Ordering

## Problem

1. `is_mutating_command()` in `bin/agy-compound` misclassified read-only commands containing `2>/dev/null` as file mutations, while missing real in-repo `sed -i` commands on relative paths such as `config/GEMINI.md`.
2. Calling `git -C <dir> diff --cached --name-only --no-optional-locks` in `bin/agy-watch` failed with exit code `129` (`usage: git diff ...`).

## Symptoms

- `find ~/Projects/gravityzilla/docs -maxdepth 3 2>/dev/null` triggered `<compound-check>` Stop bounces on read-only turns.
- `sed -i 's/a/b/' config/GEMINI.md` returned `False` in `is_mutating_command()`.
- `git diff` rejected `--no-optional-locks` as an unknown subcommand flag, whereas `git status --no-optional-locks` silently accepted it.

## What Didn't Work

- Matching `(?<![-=<&\d])[12]?>>?\s*[^\s&>]+` without excluding `/dev/*` and `/tmp/*` targets caught `2>/dev/null` and `/tmp` redirects.
- Running `re.findall(r"(?:/[^\s\"';&|)]+|~/[^\s\"';&|)]+)", seg)` against raw `seg` extracted `/a/b/'` from quoted `'s/a/b/'`; switching to `seg_unquoted` alone still extracted `/GEMINI.md` from `config/GEMINI.md` because the pattern lacked a left token boundary.

## Solution

1. In `bin/agy-compound`, strip `(?:[12]|&)?>>?\s*/dev/(?:null|stdout|stderr)\b` and exclude `/dev/` and `/tmp/` from `SHELL_REDIRECT_TARGET_RE`, scope redirect-only commands to their redirect target path, and scan `seg_unquoted` with a left token boundary:
   ```python
   abs_paths = re.findall(r"(?:(?<=^)|(?<=[\s=]))(?:/[^\s\"';&|)]+|~/[^\s\"';&|)]+)", seg_unquoted)
   ```
2. In `bin/agy-watch`, pass `--no-optional-locks` as a top-level `git` option before `-C`:
   ```python
   ["git", "--no-optional-locks", "-C", git_dir, *args]
   ```

## Why This Works

Quoting masks regex literals (`'s/a/b/'`), the `(?:(?<=^)|(?<=[\s=]))` lookbehind restricts `/...` matches to actual filesystem tokens rather than relative path tails (`config/GEMINI.md`), and `--no-optional-locks` is a top-level `git` binary option rather than a universal subcommand flag.

## Prevention

Keep unit tests in `test_watchdog.py` (`test_11_git_safety_guard_env_force_push_and_reset`) and `agy-compound` regression checks covering `2>/dev/null`, `/tmp/` redirects, relative-path `sed -i`, and `git diff --cached` with `.env` staged.

## References

0
