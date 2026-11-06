# Same-File Edit Ledger (`ledger`)

Guards concurrent Antigravity sessions against silent file clobbers in the same directory:

- **Same-file pause (`PreToolUse` / `PostToolUse`)**: If Session B tries to edit the exact same file on disk (`real_path`) that Session A edited in the last 30 minutes, pauses once (`deny`) so Session B re-reads the file first; the retry goes through.
