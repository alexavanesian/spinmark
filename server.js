import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';

const app = express();
const PORT = process.env.PORT || 3001;
const APP_NAME = process.env.APP_NAME || 'SpinmarkApp';
const APP_VERSION = process.env.APP_VERSION || '1.0';
const CONTACT_EMAIL = process.env.CONTACT_EMAIL || 'you@example.com';

// MusicBrainz's API policy requires every client to identify itself.
// See: https://musicbrainz.org/doc/MusicBrainz_API/Rate_Limiting
const USER_AGENT = `${APP_NAME}/${APP_VERSION} ( ${CONTACT_EMAIL} )`;

app.use(cors());

// Guard your own server against abuse (separate from MusicBrainz's own limit below).
app.use('/api/', rateLimit({ windowMs: 60_000, max: 60 }));

// MusicBrainz asks for roughly one request per second per client.
// This tiny queue makes sure this server never sends requests faster than that,
// no matter how many browsers are hitting this API at once.
let lastRequestAt = 0;
let queue = Promise.resolve();
function mbFetch(url) {
  queue = queue.then(async () => {
    const wait = Math.max(0, 1100 - (Date.now() - lastRequestAt));
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastRequestAt = Date.now();
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`MusicBrainz responded ${res.status}`);
    return res.json();
  });
  return queue;
}

// GET /api/search?q=abbey+road&type=album|single
app.get('/api/search', async (req, res) => {
  const q = (req.query.q || '').toString().trim();
  const wantsSingle = req.query.type === 'single';
  if (!q) return res.status(400).json({ error: 'Missing q parameter' });

  try {
    if (wantsSingle) {
      const url = `https://musicbrainz.org/ws/2/recording/?query=${encodeURIComponent(q)}&fmt=json&limit=8`;
      const data = await mbFetch(url);
      const results = (data.recordings || []).map((r) => ({
        mbid: r.id,
        title: r.title,
        artist: (r['artist-credit'] || []).map((a) => a.name).join(', '),
        year: r['first-release-date'] ? r['first-release-date'].slice(0, 4) : null,
        releaseGroupId: r.releases?.[0]?.['release-group']?.id || null,
      }));
      return res.json({ results });
    } else {
      const url = `https://musicbrainz.org/ws/2/release-group/?query=${encodeURIComponent(q)}&fmt=json&limit=8`;
      const data = await mbFetch(url);
      const results = (data['release-groups'] || []).map((g) => ({
        mbid: g.id,
        title: g.title,
        artist: (g['artist-credit'] || []).map((a) => a.name).join(', '),
        year: g['first-release-date'] ? g['first-release-date'].slice(0, 4) : null,
        releaseGroupId: g.id,
      }));
      return res.json({ results });
    }
  } catch (err) {
    res.status(502).json({ error: 'MusicBrainz lookup failed', detail: err.message });
  }
});

// GET /api/cover/:releaseGroupId  -> proxies the Cover Art Archive front image
app.get('/api/cover/:releaseGroupId', async (req, res) => {
  const { releaseGroupId } = req.params;
  try {
    const caaRes = await fetch(
      `https://coverartarchive.org/release-group/${releaseGroupId}/front-250`,
      { headers: { 'User-Agent': USER_AGENT } }
    );
    if (!caaRes.ok) return res.status(404).json({ error: 'No cover art found' });
    res.set('Content-Type', caaRes.headers.get('content-type') || 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=86400');
    const buf = Buffer.from(await caaRes.arrayBuffer());
    res.send(buf);
  } catch (err) {
    res.status(502).json({ error: 'Cover art lookup failed', detail: err.message });
  }
});

app.get('/', (_req, res) => res.send('Spinmark API is running.'));

app.listen(PORT, () => console.log(`Spinmark API listening on port ${PORT}`));
