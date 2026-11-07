# Changelog

## 1.0.0

First public release.

- Every endpoint of the v1 API: posts (video, photos, text, document), status, retry, history with paging, scheduled
  posts, the queue, media and the library, analytics and reports, approvals, AI captions, Pinterest boards, account and
  profile webhooks, connect links, OAuth starts and connecting credential networks.
- Every network Reelspan supports.
- Retries with backoff on network errors, 408, 409, 429 and 5xx, honouring `Retry-After`; POSTs are retried only with
  an idempotency key, and every post gets one automatically.
- Large files go to storage in parts, three at a time, with progress and per-part retries.
- ESM and CommonJS builds with TypeScript types; runs on Node 20+, Deno, Bun and edge runtimes.
- `ReelspanError` (status, code, retryAfter) and `ReelspanConnectionError`; `verifyWebhook` for signed webhooks.
