const http = require('node:http');
const crypto = require('node:crypto');
const { URL } = require('node:url');

const PORT = Number(process.env.PORT) || 8787;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const AUDIUS_DISCOVERY_URL = process.env.AUDIUS_DISCOVERY_URL || 'https://discoveryprovider.audius.co';

const RATE_WINDOW_MS = 60000;
const MAX_REQUESTS_PER_WINDOW = 40;
let ephemeralWindowSalt = crypto.randomBytes(16).toString('hex');
const rateCounters = new Map();

setInterval(() => {
  rateCounters.clear();
  ephemeralWindowSalt = crypto.randomBytes(16).toString('hex');
}, RATE_WINDOW_MS).unref();

function checkRateLimit(remoteAddress) {
  const token = crypto.createHash('sha256').update(String(remoteAddress || 'local') + ephemeralWindowSalt).digest('hex');
  const current = (rateCounters.get(token) || 0) + 1;
  rateCounters.set(token, current);
  return current <= MAX_REQUESTS_PER_WINDOW;
}

function sanitizeText(value, maxLength = 120) {
  return String(value == null ? '' : value)
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, maxLength);
}

function isVerifiedPartnerUrl(rawUrl) {
  if (!rawUrl) return false;
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'https:') return false;
    const host = parsed.hostname.toLowerCase();
    if (host.endsWith('.asdn') || host === 'saavn.com.asdn') return false;
    return (
      host === 'audius.co' ||
      host.endsWith('.audius.co') ||
      host === 'archive.org' ||
      host.endsWith('.archive.org') ||
      host === 'commons.wikimedia.org' ||
      host === 'upload.wikimedia.org' ||
      host.endsWith('.wikimedia.org')
    );
  } catch (_) {
    return false;
  }
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'Pragma': 'no-cache',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(body);
}

async function queryAudius(query) {
  const endpoint = `${AUDIUS_DISCOVERY_URL.replace(/\/+$/, '')}/v1/tracks/search?query=${encodeURIComponent(query)}&app_name=AudioImmersiver`;
  const response = await fetch(endpoint, {
    headers: { 'Accept': 'application/json' },
    referrerPolicy: 'no-referrer'
  });
  if (!response.ok) {
    throw new Error('Upstream Audius service returned an error');
  }
  const data = await response.json();
  const tracks = Array.isArray(data?.data) ? data.data : [];
  return tracks.slice(0, 15).map(item => ({
    id: sanitizeText(item.id, 60),
    title: sanitizeText(item.title || 'Untitled'),
    artist: sanitizeText(item.user?.name || 'Artist'),
    duration: Number(item.duration) || 0,
    artwork: sanitizeText(item.artwork?.['480x480'] || item.artwork?.['150x150'] || '', 300),
    streamUrl: `${AUDIUS_DISCOVERY_URL.replace(/\/+$/, '')}/v1/tracks/${encodeURIComponent(item.id)}/stream?app_name=AudioImmersiver`,
    directPlaybackAuthorized: true
  }));
}

async function queryWikimediaCommons(query) {
  const endpoint = `https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent('filetype:audio ' + query)}&gsrnamespace=6&gsrlimit=14&prop=imageinfo&iiprop=url|extmetadata|size|mime&format=json&origin=*`;
  const response = await fetch(endpoint, {
    headers: { 'Accept': 'application/json' },
    referrerPolicy: 'no-referrer'
  });
  if (!response.ok) {
    throw new Error('Upstream Wikimedia Commons API returned an error');
  }
  const data = await response.json();
  const pages = Object.values(data?.query?.pages || {});
  return pages
    .map(p => {
      const ii = (p.imageinfo && p.imageinfo[0]) || {};
      const ext = ii.extmetadata || {};
      const rawTitle = String(p.title || '').replace(/^File:/i, '').replace(/\.[^.]+$/, '').replace(/_/g, ' ');
      const rawAuthor = String(ext.Artist?.value || ext.Credit?.value || 'Wikimedia Commons').replace(/<[^>]*>/g, '');
      const lic = sanitizeText(ext.LicenseShortName?.value || 'CC / Public Domain', 24).toUpperCase();
      return {
        id: sanitizeText(p.pageid || rawTitle, 80),
        title: sanitizeText(rawTitle || 'Audio Track'),
        artist: sanitizeText(rawAuthor || 'Wikimedia Commons'),
        duration: 0,
        artwork: '',
        streamUrl: ii.url || '',
        license: `COMMONS · ${lic}`,
        directPlaybackAuthorized: true
      };
    })
    .filter(item => item.streamUrl && isVerifiedPartnerUrl(item.streamUrl) && /\.(ogg|oga|mp3|flac|wav)$/i.test(item.streamUrl));
}

async function queryInternetArchive(query) {
  const advQuery = `(${query}) AND mediatype:(audio) AND format:(VBR MP3) AND (licenseurl:(*creativecommons* OR *publicdomain*))`;
  const endpoint = `https://archive.org/advancedsearch.php?q=${encodeURIComponent(advQuery)}&fl[]=identifier&fl[]=title&fl[]=creator&fl[]=licenseurl&sort[]=downloads+desc&rows=12&page=1&output=json`;
  const response = await fetch(endpoint, {
    headers: { 'Accept': 'application/json' },
    referrerPolicy: 'no-referrer'
  });
  if (!response.ok) {
    throw new Error('Upstream Internet Archive API returned an error');
  }
  const data = await response.json();
  const docs = Array.isArray(data?.response?.docs) ? data.response.docs : [];
  return docs
    .filter(doc => doc && doc.identifier)
    .map(doc => ({
      id: sanitizeText(doc.identifier, 100),
      title: sanitizeText(Array.isArray(doc.title) ? doc.title[0] : doc.title || doc.identifier),
      artist: sanitizeText(Array.isArray(doc.creator) ? doc.creator[0] : doc.creator || 'Internet Archive CC'),
      duration: 0,
      artwork: `https://archive.org/services/img/${encodeURIComponent(doc.identifier)}`,
      streamUrl: '',
      directPlaybackAuthorized: true
    }));
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400'
    });
    return res.end();
  }

  if (req.method !== 'GET') {
    return sendJson(res, 405, { error: 'Method not allowed' });
  }

  if (!checkRateLimit(req.socket?.remoteAddress)) {
    return sendJson(res, 429, { error: 'Rate limit exceeded. Please wait a moment and try again.' });
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(req.url, `http://localhost:${PORT}`);
  } catch (_) {
    return sendJson(res, 400, { error: 'Malformed request URI' });
  }

  if (parsedUrl.pathname === '/api/health') {
    return sendJson(res, 200, {
      status: 'ok',
      providers: {
        audius: true,
        archive: true,
        commons: true
      }
    });
  }

  if (parsedUrl.pathname === '/api/search') {
    const provider = sanitizeText(parsedUrl.searchParams.get('provider'), 20).toLowerCase();
    const query = sanitizeText(parsedUrl.searchParams.get('q'), 100);

    if (!['audius', 'archive', 'commons'].includes(provider)) {
      return sendJson(res, 400, { error: 'Unsupported provider. Choose audius, archive, or commons.' });
    }
    if (!query) {
      return sendJson(res, 400, { error: 'Query parameter "q" is required.' });
    }

    try {
      if (provider === 'audius') {
        const results = await queryAudius(query);
        return sendJson(res, 200, { provider: 'audius', configured: true, results });
      }
      if (provider === 'commons') {
        const results = await queryWikimediaCommons(query);
        return sendJson(res, 200, { provider: 'commons', configured: true, results });
      }
      if (provider === 'archive') {
        const results = await queryInternetArchive(query);
        return sendJson(res, 200, { provider: 'archive', configured: true, results });
      }
    } catch (_) {
      return sendJson(res, 502, { error: 'Upstream provider request failed or timed out.' });
    }
  }

  return sendJson(res, 404, { error: 'Endpoint not found' });
});

if (require.main === module) {
  server.listen(PORT, '127.0.0.1', () => {
    process.stdout.write(`Audio Immersiver Privacy Gateway listening on http://127.0.0.1:${PORT}\n`);
  });
}

module.exports = { server, isVerifiedPartnerUrl };