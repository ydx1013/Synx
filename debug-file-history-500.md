# File history 500 debugging

- Session: `file-history-500`
- Status: `[OPEN]`
- Symptom: `/api/repository/file-history` returns HTTP 500 while `/api/repository/head` returns 200.
- Evidence: failing request takes about 11 seconds before the first 500 response.

## Hypotheses

1. Scanning 40 commits still exceeds the Cloudflare subrequest budget.
2. A specific commit object is missing or malformed and `readCommit` throws.
3. The commit parent chain contains an invalid link or cycle.
4. R2/S3 object reads time out or return an unexpected response.
5. Production is running a different Worker version than expected.

## Evidence plan

Instrument the file-history route and scan loop to report request identity, scanned count, current commit ID, read duration, and caught error metadata. Do not change business behavior until runtime evidence identifies the cause.

## Root cause (confirmed)

`fileHistory` scanned commits with `readCommit`, which issues `fs.head()` + `fs.get()` per commit = 2 subrequests each. With `FILE_HISTORY_SCAN_LIMIT = 40`, one request issues up to ~80 subrequests, exceeding the Workers free-plan limit of 50 subrequests per request. The platform terminates the request and returns a bare 500, which is why:
- No `repository_route_error` / `repository_integrity_error` app logs appeared.
- `head` (2 subrequests) succeeds while `file-history` fails on every file.
- Every failing request is terminated at roughly the same elapsed time.

## Fix (deployed as version bdc748b1)

- `fileHistory` now walks the chain with single-read `readCommitFast` (one `fs.get` per commit; chain end on missing commit).
- `listCommits` (web timeline `/commits`) also switched to `readCommitFast` — it previously issued 50×2=100 subrequests per page and always 500'd.
- `COMMIT_PAGE_SIZE` lowered 50 → 40 and `FILE_HISTORY_SCAN_LIMIT` 40 → 30, keeping worst-case subrequests comfortably under 50.
- `/head` resolves the full tree by walking back to the checkpoint (~20+ storage ops → 4-12s); added a KV cache keyed by immutable commitId (1 KV read on hit, TTL 1h).
- Worker typecheck passes; 282 tests pass.

## Root cause summary (complete)

1. Commit chain reads used `readCommit` = `fs.head()` + `fs.get()` = 2 subrequests each.
2. `fileHistory` looped until it had scanned 40 commits regardless of matches → every request hit ~80 subrequests → exceeded the Workers free-plan limit of 50 subrequests → the platform killed the request and returned a bare 500 (no app log). This is why every file failed.
3. Web timeline `listCommits` (page size 50) hit ~100 subrequests → same 500 as soon as the repo grew past ~24 commits.
4. Storage per-object latency is high (200-500ms), so `/head`'s full-tree resolve and any chain walk are slow; the KV cache cuts repeat `/head` calls to one KV read.

## Verification

Awaiting user confirmation that the Obsidian history pane AND the web history page load successfully.
