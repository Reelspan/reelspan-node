// The client against a fake fetch: what it sends, how it retries, and its errors. No network, no dependencies.
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { Reelspan, ReelspanConnectionError, ReelspanError, VERSION, verifyWebhook } from '../dist/index.js';

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

/** A client whose fetch answers with `handler(url, init, n)` and records each call. */
function fake(handler, opts = {}) {
  const calls = [];
  const client = new Reelspan({
    apiKey: 'rs_test_abc',
    baseUrl: 'https://api.test',
    ...opts,
    fetch: async (url, init = {}) => {
      calls.push({ url: String(url), init, headers: new Headers(init.headers) });
      return handler(String(url), init, calls.length);
    },
  });
  return { client, calls };
}

test('sends the key, a JSON body and the SDK version', async () => {
  const { client, calls } = fake(() => json({ success: true, profile: { username: 'brand' } }));
  await client.profiles.create('brand', 'Brand');
  assert.equal(calls[0].url, 'https://api.test/v1/profiles');
  assert.equal(calls[0].headers.get('authorization'), 'Bearer rs_test_abc');
  assert.equal(calls[0].headers.get('x-reelspan-sdk'), `node/${VERSION}`);
  assert.deepEqual(JSON.parse(calls[0].init.body), { username: 'brand', display_name: 'Brand' });
});

test('posts a video as multipart with repeated platforms and an idempotency key', async () => {
  const { client, calls } = fake(() => json({ success: true, results: { tiktok: { success: true } } }));
  await client.posts.video({ user: 'brand', platforms: ['tiktok', 'youtube'], title: 'Launch', video: { data: new Uint8Array([1, 2, 3]), name: 'clip.mp4', type: 'video/mp4' }, repeatEvery: 'week', repeatTimes: 3 });
  const form = calls[0].init.body;
  assert.deepEqual(form.getAll('platform[]'), ['tiktok', 'youtube']);
  assert.equal(form.get('repeat_times'), '3');
  assert.equal(form.get('video').name, 'clip.mp4');
  assert.ok(calls[0].headers.get('idempotency-key'));
});

test('a text post sends platform as a JSON list, and keeps a key you pass', async () => {
  const { client, calls } = fake(() => json({ success: true }));
  await client.posts.text({ user: 'brand', platforms: ['x'], title: 'Hello', idempotencyKey: 'mine' });
  assert.deepEqual(JSON.parse(calls[0].init.body).platform, ['x']);
  assert.equal(calls[0].headers.get('idempotency-key'), 'mine');
});

test('retries network errors and 503s on safe requests, then reads the rate limit', async () => {
  const { client, calls } = fake((_u, _i, n) => {
    if (n === 1) throw new TypeError('fetch failed');
    if (n === 2) return json({ message: 'busy' }, 503, { 'retry-after': '0' });
    return json({ success: true }, 200, { 'x-ratelimit-limit': '600', 'x-ratelimit-remaining': '599', 'x-ratelimit-reset': '1' });
  });
  assert.deepEqual(await client.me(), { success: true });
  assert.equal(calls.length, 3);
  assert.deepEqual(client.rateLimit, { limit: 600, remaining: 599, reset: 1 });
});

test('does not repeat a POST without an idempotency key after a 500', async () => {
  const { client, calls } = fake(() => json({ message: 'oops' }, 500));
  await assert.rejects(client.profiles.create('x'), (e) => e instanceof ReelspanError && e.status === 500);
  assert.equal(calls.length, 1);
});

test('gives up with a connection error', async () => {
  const { client } = fake(
    () => {
      throw new TypeError('fetch failed');
    },
    { maxRetries: 1 },
  );
  await assert.rejects(client.me(), ReelspanConnectionError);
});

test('errors carry the status, code and Retry-After', async () => {
  const { client } = fake(() => json({ message: 'Slow down', error_code: 'RATE_LIMITED' }, 429, { 'retry-after': '7' }), { maxRetries: 0 });
  await assert.rejects(client.me(), (e) => e.status === 429 && e.code === 'RATE_LIMITED' && e.retryAfter === 7 && e.isRateLimited);
});

test('uploads large files in parts and completes them in order', async () => {
  const puts = [];
  const { client, calls } = fake(
    async (url, init) => {
      if (url.endsWith('/v1/media/uploads')) {
        const { size_bytes } = JSON.parse(init.body);
        return json({ media_id: 'med_1', part_size: 10, parts: Array.from({ length: Math.ceil(size_bytes / 10) }, (_, i) => ({ part_number: i + 1, url: `https://storage.test/${i + 1}` })) });
      }
      if (url.startsWith('https://storage.test/')) {
        puts.push(new Uint8Array(await init.body.arrayBuffer()).length);
        return new Response('', { headers: { etag: `"e${url.split('/').pop()}"` } });
      }
      if (url.endsWith('/complete')) return json({ success: true, media_id: 'med_1', kind: 'video', size_bytes: 32 });
      return json({}, 404);
    },
    { directUploadBytes: 16 },
  );
  const sent = [];
  const out = await client.media.upload({ data: new Uint8Array(32), name: 'big.mp4' }, { onProgress: (s) => sent.push(s) });
  assert.equal(out.media_id, 'med_1');
  assert.deepEqual(puts.sort(), [10, 10, 10, 2].sort());
  const complete = JSON.parse(calls.find((c) => c.url.endsWith('/complete')).init.body);
  assert.deepEqual(complete.parts.map((p) => p.part_number), [1, 2, 3, 4]);
  assert.equal(sent.at(-1), 32);
});

test('pages through history', async () => {
  const { client } = fake((url) => {
    const page = Number(new URL(url).searchParams.get('page'));
    const rows = Array.from({ length: page < 3 ? 100 : 30 }, (_, i) => ({ n: (page - 1) * 100 + i }));
    return json({ history: rows, total: 230, page, limit: 100 });
  });
  const rows = [];
  for await (const row of client.posts.all({ platform: 'x' })) rows.push(row);
  assert.equal(rows.length, 230);
});

test('connects a credential network', async () => {
  const { client, calls } = fake(() => json({ success: true, platform: 'telegram', account: '@news', reconnected: false }));
  await client.accounts.connect('brand', 'telegram', { bot_token: '1:abc', chat_id: '@news' });
  assert.equal(calls[0].url, 'https://api.test/v1/accounts/telegram');
  assert.deepEqual(JSON.parse(calls[0].init.body), { profile_username: 'brand', bot_token: '1:abc', chat_id: '@news' });
});

test('lists comments with the post and paging, and walks every page', async () => {
  const { client, calls } = fake((url) => {
    const cursor = new URL(url).searchParams.get('cursor');
    return json({ success: true, platform: 'youtube', comments: [{ id: cursor ?? 'c1', text: 'hi' }], pagination: { next_cursor: cursor ? null : 'c2', has_next: !cursor }, cached: false });
  });
  await client.comments.list({ platform: 'youtube', user: 'brand', postId: 'vid1', held: true, limit: 10 });
  const q = new URL(calls[0].url).searchParams;
  assert.equal(new URL(calls[0].url).pathname, '/v1/comments');
  assert.deepEqual(Object.fromEntries(q), { platform: 'youtube', user: 'brand', post_id: 'vid1', held: 'true', limit: '10' });
  const ids = [];
  for await (const c of client.comments.all({ platform: 'youtube', user: 'brand', postId: 'vid1' })) ids.push(c.id);
  assert.deepEqual(ids, ['c1', 'c2']);
});

test('moderates and deletes comments in snake_case JSON', async () => {
  const { client, calls } = fake(() => json({ success: true, action: 'hide' }));
  await client.comments.moderate({ platform: 'instagram', user: 'brand', commentId: 'c9', action: 'hide' });
  assert.equal(calls[0].url, 'https://api.test/v1/comments/action');
  assert.deepEqual(JSON.parse(calls[0].init.body), { platform: 'instagram', user: 'brand', comment_id: 'c9', action: 'hide' });
  await client.comments.delete({ platform: 'instagram', user: 'brand', commentId: 'c9' });
  assert.equal(calls[1].init.method, 'DELETE');
  assert.deepEqual(JSON.parse(calls[1].init.body), { platform: 'instagram', user: 'brand', comment_id: 'c9' });
});

test('sends a DM and starts and controls an AutoDM monitor', async () => {
  const { client, calls } = fake(() => json({ success: true, monitor: { monitor_id: 'm1', status: 'running' } }));
  await client.dms.send({ platform: 'instagram', user: 'brand', recipientId: 'u1', message: 'Thanks!', quickReplies: [{ title: 'Yes' }] });
  assert.deepEqual(JSON.parse(calls[0].init.body), { platform: 'instagram', user: 'brand', recipient_id: 'u1', message: 'Thanks!', quick_replies: [{ title: 'Yes' }] });
  await client.autodms.start({ platform: 'instagram', user: 'brand', requestId: 'req_1', replyMessage: 'Link inside', triggerKeywords: ['link'], monitoringInterval: 30 });
  assert.equal(calls[1].url, 'https://api.test/v1/autodms');
  assert.deepEqual(JSON.parse(calls[1].init.body), { platform: 'instagram', user: 'brand', request_id: 'req_1', reply_message: 'Link inside', trigger_keywords: ['link'], monitoring_interval: 30 });
  await client.autodms.pause('m1');
  await client.autodms.logs('m1', 20);
  assert.equal(calls[2].url, 'https://api.test/v1/autodms/m1/pause');
  assert.equal(calls[3].url, 'https://api.test/v1/autodms/m1/logs?limit=20');
});

test('edits, unpublishes and reposts live posts', async () => {
  const { client, calls } = fake(() => json({ success: true, platform: 'x', post_id: '2' }));
  await client.posts.edit({ requestId: 'req_1', platform: 'x', text: 'Fixed typo', fields: { x_keep_links: 'true' } });
  assert.deepEqual(JSON.parse(calls[0].init.body), { request_id: 'req_1', platform: 'x', text: 'Fixed typo', fields: { x_keep_links: 'true' } });
  await client.posts.unpublish({ platform: 'bluesky', user: 'brand', postId: 'at://p' });
  assert.equal(calls[1].url, 'https://api.test/v1/posts/unpublish');
  await client.posts.repost({ platform: 'linkedin', user: 'brand', postId: 'urn:li:share:1', commentary: 'Worth a read', targetLinkedinPageId: '42' });
  assert.equal(JSON.parse(calls[2].init.body).target_linkedin_page_id, '42');
});

test('adds YouTube subtitles from a file as multipart, and from text as JSON', async () => {
  const { client, calls } = fake(() => json({ success: true, video_id: 'v1', subtitle: { id: 's1' } }));
  await client.youtube.subtitles.add({ user: 'brand', videoId: 'v1', language: 'en', file: { data: new TextEncoder().encode('WEBVTT'), name: 'en.srt' } });
  const form = calls[0].init.body;
  assert.equal(form.get('video_id'), 'v1');
  assert.equal(form.get('language'), 'en');
  assert.equal(form.get('subtitles').name, 'en.srt');
  await client.youtube.subtitles.add({ requestId: 'req_1', language: 'ur', text: 'WEBVTT' });
  assert.deepEqual(JSON.parse(calls[1].init.body), { request_id: 'req_1', language: 'ur', subtitle_text: 'WEBVTT' });
});

test('reads lookups, analytics by post id, impressions and the scheduled thumbnail link', async () => {
  const { client, calls } = fake(() => json({ success: true }));
  await client.facebook.selectPage('brand', 'p1');
  assert.deepEqual(JSON.parse(calls[0].init.body), { profile_username: 'brand', facebook_page_id: 'p1' });
  await client.pinterest.sections('brand', 'b 1');
  assert.equal(calls[1].url, 'https://api.test/v1/pinterest/boards/b%201/sections?profile_username=brand');
  await client.analytics.postById('brand', 'instagram', '1789');
  assert.equal(calls[2].url, 'https://api.test/v1/post-analytics?profile_username=brand&platform=instagram&platform_post_id=1789');
  await client.analytics.impressions('brand', { startDate: '2026-10-01', endDate: '2026-10-31', platforms: ['x', 'threads'] });
  assert.equal(calls[3].url, 'https://api.test/v1/analytics/brand/impressions?start_date=2026-10-01&end_date=2026-10-31&platforms=x%2Cthreads');
  await client.scheduled.thumbnail('job_1');
  assert.equal(calls[4].url, 'https://api.test/v1/scheduled/job_1/thumbnail?format=json');
  await client.publishingLimits('brand', { refresh: true });
  assert.equal(calls[5].url, 'https://api.test/v1/publishing-limits?profile_username=brand&refresh=true');
  await client.preferences.set({ timezone: null });
  assert.deepEqual(JSON.parse(calls[6].init.body), { timezone: null });
});

test('verifies webhook signatures', async () => {
  const ts = String(Math.floor(Date.now() / 1000));
  const body = '{"event":"upload_completed"}';
  const sig = (t, b) => `sha256=${createHmac('sha256', 'whsec_1').update(`${t}.${b}`).digest('hex')}`;
  assert.equal(await verifyWebhook(body, sig(ts, body), ts, 'whsec_1'), true);
  assert.equal(await verifyWebhook(`${body} `, sig(ts, body), ts, 'whsec_1'), false);
  assert.equal(await verifyWebhook(body, sig('1000', body), '1000', 'whsec_1'), false);
});

test('the CommonJS build loads with require', () => {
  const cjs = createRequire(import.meta.url)('../dist/cjs/index.js');
  assert.equal(typeof cjs.Reelspan, 'function');
  assert.equal(cjs.VERSION, VERSION);
});

test('checks account sign-ins and waits for results on the server', async () => {
  const { client, calls } = fake(() => json({ success: true, status: 'completed', results: [] }));
  await client.accounts.health('brand');
  assert.equal(calls[0].url, 'https://api.test/v1/accounts/health?profile=brand');
  await client.posts.status({ requestId: 'r1', waitSeconds: 90 });
  assert.equal(calls[1].url, 'https://api.test/v1/posts/status?request_id=r1&wait=90');
  await client.posts.wait('r1', { timeoutMs: 30_000 });
  assert.match(calls[2].url, /\/v1\/posts\/status\?request_id=r1&wait=(29|30)$/);
});
