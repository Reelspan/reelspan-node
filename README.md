# reelspan

The official Node.js and TypeScript client for the [Reelspan API](https://reelspan.com/docs). Publish one video,
photo set or text post to TikTok, YouTube, Instagram, Facebook, X, Threads, LinkedIn, Pinterest, Bluesky, Reddit,
Google Business, Telegram, Discord, Slack, Mastodon, Dev.to, Hashnode, WordPress and more,
schedule it, and read how it did.

- No dependencies. Node 20+, Deno, Bun and edge runtimes; ESM and CommonJS; full TypeScript types.
- Retries network errors, 429s and 5xx answers with backoff, honouring `Retry-After`.
- Every post carries an `Idempotency-Key`, so a retried post is never published twice.
- Large files go straight to storage in parts, with progress and per-part retries.

```bash
npm install reelspan
```

## Quick start

```ts
import { Reelspan } from 'reelspan';
import { readFile } from 'node:fs/promises';

const reelspan = new Reelspan(); // reads REELSPAN_API_KEY

const post = await reelspan.posts.video({
  user: 'my-brand', // a profile's username
  platforms: ['tiktok', 'youtube', 'instagram'],
  title: 'Launch day',
  video: { data: await readFile('launch.mp4'), name: 'launch.mp4', type: 'video/mp4' },
});

for (const [platform, r] of Object.entries(post.results ?? {})) console.log(platform, r.success ? r.url : r.error);
```

`video` also takes a `Blob`/`File` or a public https URL (Google Drive and Dropbox share links work).

## Posting

```ts
// photos or a carousel, in order, with alt text
await reelspan.posts.photos({ user: 'my-brand', platforms: ['instagram', 'pinterest'], photos: [a, b], altTexts: ['Front', 'Back'], extra: { pinterest_board_id: '123' } });

// text: long posts become threads on X and Bluesky
await reelspan.posts.text({ user: 'my-brand', platforms: ['x', 'bluesky', 'threads', 'linkedin'], title: 'We shipped it.' });

// a PDF to LinkedIn as a swipeable document
await reelspan.posts.document({ user: 'my-brand', platforms: ['linkedin'], title: 'Q3 report', document: pdf });

// schedule, queue or repeat
await reelspan.posts.video({ user: 'my-brand', platforms: ['tiktok'], video, scheduledDate: '2026-12-01T09:00:00Z' });
await reelspan.posts.video({ user: 'my-brand', platforms: ['tiktok'], video, addToQueue: true });
await reelspan.posts.text({ user: 'my-brand', platforms: ['x'], title: 'Weekly tip', scheduledDate, repeatEvery: 'week', repeatTimes: 6 });

// network settings go in `extra`
await reelspan.posts.video({ user: 'my-brand', platforms: ['reddit', 'tiktok'], video, title: 'Clip', extra: { reddit_subreddit: 'videos', privacy_level: 'PUBLIC_TO_EVERYONE' } });
```

Send `async: true` to get a `request_id` at once, then:

```ts
const { request_id } = await reelspan.posts.video({ user: 'my-brand', platforms: ['youtube'], video, async: true });
const done = await reelspan.posts.wait(request_id!); // polls until every network has finished
await reelspan.posts.retry(request_id!); // sends the failed networks again
```

## Large files

Files from 90 MB go up in parts on their own. To upload once and reuse:

```ts
const media = await reelspan.media.upload(file, { kind: 'video', onProgress: (sent, total) => console.log(Math.round((sent / total) * 100), '%') });
await reelspan.posts.video({ user: 'my-brand', platforms: ['youtube'], videoMediaId: media.media_id });
```

## Profiles and accounts

```ts
await reelspan.profiles.create('client-a', 'Client A');

// networks that sign in with OAuth: send your customer to a hosted, branded page
const { access_url } = await reelspan.connect.link('client-a', { logo_image: 'https://…', redirect_url: 'https://you.com/done' });

// networks that use credentials: connect them straight from your code
await reelspan.accounts.connect('client-a', 'discord', { webhook_url: 'https://discord.com/api/webhooks/…' });
await reelspan.accounts.connect('client-a', 'mastodon', { instance_url: 'mastodon.social', access_token: '…' });

await reelspan.accounts.disconnect('client-a', 'discord');
```

## History, analytics and scheduling

```ts
for await (const row of reelspan.posts.all({ platform: 'tiktok', status: 'failed' })) console.log(row);
await reelspan.analytics.account('my-brand');
await reelspan.analytics.bestTimes('my-brand', { timezone: 'Asia/Karachi' });
await reelspan.scheduled.list({ profile_username: 'my-brand' });
await reelspan.scheduled.cancel(jobId, { withLaterRepeats: true });
```

Also: `queue`, `library`, `approvals`, `ai` (captions from a video or your text), `pinterest.createBoard`,
`webhooks` (account and per-profile), and `request(method, path)` for anything else.

## Webhooks

```ts
import { verifyWebhook } from 'reelspan';

app.post('/reelspan', express.raw({ type: 'application/json' }), async (req, res) => {
  const ok = await verifyWebhook(req.body.toString(), req.get('x-reelspan-signature'), req.get('x-reelspan-timestamp'), process.env.REELSPAN_WEBHOOK_SECRET!);
  if (!ok) return res.sendStatus(401);
  // …
  res.sendStatus(200);
});
```

## Errors

```ts
import { ReelspanError, ReelspanConnectionError } from 'reelspan';

try {
  await reelspan.posts.text({ user: 'my-brand', platforms: ['x'], title: 'Hi' });
} catch (err) {
  if (err instanceof ReelspanError) console.log(err.status, err.code, err.message, err.retryAfter);
  else if (err instanceof ReelspanConnectionError) console.log('no answer', err.message);
}
```

## Options

```ts
new Reelspan({
  apiKey: 'rs_live_…', // or REELSPAN_API_KEY
  baseUrl: 'https://api.reelspan.com',
  timeoutMs: 120_000, // per attempt
  maxRetries: 2,
  headers: { 'x-my-app': 'scheduler' },
});
```

Use a test key (`rs_test_…`) to try everything without publishing. `reelspan.rateLimit` holds the limit the API
reported last. Full reference: [reelspan.com/docs](https://reelspan.com/docs).

MIT licensed.
