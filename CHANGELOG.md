# Changelog

## 1.2.0

- `accounts.health(username)`: checks live that each connected account is still signed in, and when its access runs
  out (`ok`, `signed_out`, `expiring`, `not_checked` or `error`).
- `posts.status` takes `waitSeconds` (up to 120) to answer once every network has finished; `posts.wait` uses it, so it
  makes a few calls instead of polling every 5 seconds.
- Works with the API's new fields without changes: `{youtube.post_url}` links between the networks of one post,
  `{network}_caption`, `thumbnailMediaId`-style uploaded thumbnails (`youtube.setThumbnail({ mediaId })`), and
  `analytics.post` now returns each network's `readings` (24h, 72h, 7d) and `over_time`.

## 1.1.0

Covers the rest of the v1 API.

- Comments: `comments.list` (and `comments.all` to page through), `create`, `reply`, `privateReply`, `moderate`
  (hide, like, approve, hold, edit, ban the author…) and `delete`.
- Direct messages: `dms.conversations` and `dms.send`.
- AutoDM monitors: `autodms.start`, `list`, `get`, `logs`, `pause`, `resume`, `stop`, `check` and `delete`.
- Live posts: `posts.edit`, `posts.unpublish` and `posts.repost`; `posts.retry` takes `scheduledDate` to retry later.
- YouTube: `youtube.subtitles.list/add/delete` (a file, text or URL) and `youtube.setThumbnail`.
- Network choices: `facebook.pages/selectPage/clearPage/pageInfo/updatePageInfo`, `linkedin.pages/selectPage/clearPage`,
  `googleBusiness.locations/selectLocation/clearLocation`, `pinterest.boards/sections/createSection/savePin` (and
  `createBoard` takes a description and privacy), `tiktok.creatorInfo`, `reddit.posts`.
- Analytics: `analytics.postById` (any post, by the network's id) and `analytics.impressions` (totals over a period).
- Scheduled posts: `scheduled.preview` (signed media links) and `scheduled.thumbnail`.
- Account: `activity()`, `permissions()`, `publishingLimits()` and `preferences.get/set`.

## 1.0.2

- Removed captions from a video file (`POST /v1/ai/video-captions` is gone). Upload the video, then write captions
  from its media id with `ai.writeCaptions({ mediaId })`.

## 1.0.1

- Dropped Whop, Listmonk, Nostr and Lemmy, which Reelspan no longer supports.

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
