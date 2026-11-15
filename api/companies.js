const { createHash } = require('node:crypto');
const { lookup } = require('node:dns/promises');
const { isIP } = require('node:net');

const TABLE = 'company_logo_cache';
const BUCKET = 'company-logo-cache';
const MAX_RESULTS = 6;
const MAX_IMAGE_BYTES = 1024 * 1024;
const SELECT_COLUMNS = [
  'id', 'name', 'normalized_name', 'verified_domain', 'external_entity_id',
  'logo_path', 'logo_url', 'logo_source', 'logo_source_url', 'logo_status', 'retrieved_at'
].join(',');
const COMPANY_TYPE_QIDS = new Set([
  'Q4830453', 'Q783794', 'Q43229', 'Q891723', 'Q18608583', 'Q27020041', 'Q167037'
]);
const COMPANY_DESCRIPTION = /\b(company|corporation|enterprise|retailer|airline|airlines|bank|manufacturer|telecommunication|telecom|utility|utilities|marketplace|insurance company|hotel chain|restaurant chain|conglomerate|business enterprise|service provider|brand)\b/i;
const BLOCKED_HOSTS = [
  'facebook.com', 'instagram.com', 'twitter.com', 'x.com', 'linkedin.com',
  'tiktok.com', 'youtube.com', 'youtu.be', 'linktr.ee', 'wikipedia.org', 'wikidata.org'
];
const inFlight = new Map();
const requestCounts = globalThis.__girCompanyRequestCounts || new Map();
globalThis.__girCompanyRequestCounts = requestCounts;

function normalizeName(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function safeQuery(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

function config() {
  const baseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
  if (!baseUrl || !serviceKey) throw new Error('Company cache is not configured');
  const parsed = new URL(baseUrl);
  if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost') {
    throw new Error('Company cache requires a secure Supabase URL');
  }
  return { baseUrl: parsed.origin, serviceKey };
}

async function databaseRequest(path, options = {}) {
  const { baseUrl, serviceKey } = config();
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      apikey: serviceKey,
      authorization: `Bearer ${serviceKey}`,
      accept: 'application/json',
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...options.headers
    },
    signal: AbortSignal.timeout(8000)
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Supabase request failed (${response.status})`);
  return text ? JSON.parse(text) : [];
}

function tablePath(filters, limit = MAX_RESULTS) {
  const params = new URLSearchParams({
    select: SELECT_COLUMNS,
    ...filters,
    order: 'name.asc',
    limit: String(limit)
  });
  return `/rest/v1/${TABLE}?${params.toString()}`;
}

async function findByDomain(domain) {
  const rows = await databaseRequest(tablePath({ verified_domain: `eq.${domain}` }, 1));
  return rows[0] || null;
}

async function findById(id) {
  const rows = await databaseRequest(tablePath({ id: `eq.${id}` }, 1));
  return rows[0] || null;
}

async function updateCacheRow(id, patch) {
  const params = new URLSearchParams({ id: `eq.${id}`, select: SELECT_COLUMNS });
  const rows = await databaseRequest(`/rest/v1/${TABLE}?${params.toString()}`, {
    method: 'PATCH',
    headers: { prefer: 'return=representation' },
    body: JSON.stringify({ ...patch, retrieved_at: new Date().toISOString() })
  });
  return rows[0] || null;
}

function publicCompany(row) {
  return {
    id: row.id,
    name: row.name,
    domain: row.verified_domain,
    logoUrl: row.logo_url || null,
    logoCacheId: row.id
  };
}

function isBlockedDomain(hostname) {
  return BLOCKED_HOSTS.some(domain => hostname === domain || hostname.endsWith(`.${domain}`));
}

function normalizeOfficialSite(value) {
  try {
    const site = new URL(value);
    if (!['https:', 'http:'].includes(site.protocol) || site.username || site.password) return null;
    const hostname = site.hostname.toLowerCase().replace(/^www\./, '');
    if (!hostname.includes('.') || isIP(hostname) || isBlockedDomain(hostname)) return null;
    return { domain: hostname, url: `https://${hostname}/` };
  } catch {
    return null;
  }
}

function isPublicAddress(address) {
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && (b === 18 || b === 19)));
  }
  if (isIP(address) === 6) {
    const value = address.toLowerCase();
    if (value.startsWith('::ffff:')) {
      const ipv4 = value.slice(7);
      return isIP(ipv4) === 4 && isPublicAddress(ipv4);
    }
    return !(value === '::' || value === '::1' || value.startsWith('fc') ||
      value.startsWith('fd') || value.startsWith('fe8') || value.startsWith('fe9') ||
      value.startsWith('fea') || value.startsWith('feb') || value.startsWith('ff'));
  }
  return false;
}

async function isPublicHost(hostname) {
  if (isIP(hostname)) return isPublicAddress(hostname);
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost')) return false;
  try {
    const answers = await Promise.race([
      lookup(hostname, { all: true, verbatim: true }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('DNS lookup timed out')), 1800))
    ]);
    return answers.length > 0 && answers.every(answer => isPublicAddress(answer.address));
  } catch {
    return false;
  }
}

function allowedOfficialHost(hostname, domain) {
  const host = hostname.toLowerCase().replace(/^www\./, '');
  return host === domain || host.endsWith(`.${domain}`);
}

async function fetchWithTimeout(url, init = {}, timeout = 5000) {
  return fetch(url, { ...init, signal: AbortSignal.timeout(timeout) });
}

async function fetchWikidataJson(url) {
  const response = await fetchWithTimeout(url, {
    headers: {
      accept: 'application/json',
      'user-agent': 'GetItResolvedCompanyLookup/1.0 (https://getitresolved.company; company-logo discovery)'
    }
  }, 7000);
  if (!response.ok) throw new Error(`Wikidata request failed (${response.status})`);
  return response.json();
}

function entityRelevant(entity, query) {
  const label = entity.labels?.en?.value || '';
  const aliases = (entity.aliases?.en || []).map(alias => alias.value);
  const queryName = normalizeName(query);
  const queryTokens = queryName.split(' ').filter(Boolean);
  const candidates = [label, ...aliases].map(normalizeName).filter(Boolean);
  const relevant = candidates.some(candidate => {
    const candidateTokens = new Set(candidate.split(' '));
    return candidate === queryName || candidate.startsWith(`${queryName} `) ||
      queryName.startsWith(`${candidate} `) ||
      (queryTokens.length > 0 && queryTokens.every(token => candidateTokens.has(token)));
  });
  if (!relevant) return false;

  const description = entity.descriptions?.en?.value || '';
  const instanceTypes = entity.claims?.P31 || [];
  const hasCompanyType = COMPANY_DESCRIPTION.test(description) || instanceTypes.some(claim => {
    const typeId = claim.mainsnak?.datavalue?.value?.id;
    return typeId && COMPANY_TYPE_QIDS.has(typeId);
  });
  return hasCompanyType;
}

function officialWebsite(entity) {
  const claims = entity.claims?.P856 || [];
  for (const claim of claims) {
    const value = claim.mainsnak?.datavalue?.value;
    if (typeof value !== 'string') continue;
    const normalized = normalizeOfficialSite(value);
    if (normalized) return { ...normalized, originalUrl: value };
  }
  return null;
}

function wikidataLogoFile(entity) {
  const claims = entity.claims?.P154 || [];
  for (const claim of claims) {
    const value = claim.mainsnak?.datavalue?.value;
    if (typeof value === 'string' && value.trim()) return value.replace(/^File:/i, '').trim();
  }
  return null;
}

async function discoverEntities(query) {
  const searchUrl = new URL('https://www.wikidata.org/w/api.php');
  searchUrl.search = new URLSearchParams({
    action: 'wbsearchentities',
    search: query,
    language: 'en',
    uselang: 'en',
    type: 'item',
    limit: '12',
    format: 'json'
  }).toString();
  const searchResult = await fetchWikidataJson(searchUrl.toString());
  const searchItems = Array.isArray(searchResult.search) ? searchResult.search : [];
  const ids = searchItems.map(item => item.id).filter(id => /^Q\d+$/.test(id)).slice(0, 12);
  if (!ids.length) return [];

  const entityUrl = new URL('https://www.wikidata.org/w/api.php');
  entityUrl.search = new URLSearchParams({
    action: 'wbgetentities',
    ids: ids.join('|'),
    props: 'labels|aliases|descriptions|claims',
    languages: 'en',
    format: 'json'
  }).toString();
  const entityResult = await fetchWikidataJson(entityUrl.toString());
  const entities = entityResult.entities || {};
  const results = [];
  for (const item of searchItems) {
    const entity = entities[item.id];
    if (!entity || !entityRelevant(entity, query)) continue;
    const website = officialWebsite(entity);
    if (!website) continue;
    const name = entity.labels?.en?.value || item.label;
    if (!name) continue;
    results.push({
      externalEntityId: entity.id,
      name: String(name).slice(0, 120),
      normalizedName: normalizeName(name),
      domain: website.domain,
      websiteUrl: website.url,
      sourceWebsiteUrl: website.originalUrl,
      logoFile: wikidataLogoFile(entity)
    });
    if (results.length >= MAX_RESULTS) break;
  }
  return results;
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function attributesFromTag(tag) {
  const attributes = {};
  const pattern = /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
  let match;
  while ((match = pattern.exec(tag))) {
    attributes[match[1].toLowerCase()] = decodeHtml(match[2] ?? match[3] ?? match[4] ?? '');
  }
  return attributes;
}

function collectLogoValues(value, output = []) {
  if (typeof value === 'string' && /^https?:\/\//i.test(value)) output.push(value);
  else if (Array.isArray(value)) value.forEach(item => collectLogoValues(item, output));
  else if (value && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value)) {
      if (['url', 'contentUrl', '@id'].includes(key)) collectLogoValues(nested, output);
      else if (key === 'logo') collectLogoValues(nested, output);
    }
  }
  return output;
}

function siteLogoCandidates(html, pageUrl, domain) {
  const prioritized = [];
  const icons = [];
  const jsonLdPattern = /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let jsonMatch;
  while ((jsonMatch = jsonLdPattern.exec(html))) {
    try {
      const data = JSON.parse(jsonMatch[1]);
      for (const value of collectLogoValues(data)) prioritized.push({ url: value, source: 'official-site-logo' });
    } catch { /* Ignore malformed site metadata. */ }
  }

  const tagPattern = /<(?:meta|link|img)\b[^>]*>/gi;
  let tagMatch;
  while ((tagMatch = tagPattern.exec(html))) {
    const tag = tagMatch[0];
    const attributes = attributesFromTag(tag);
    const rel = (attributes.rel || '').toLowerCase();
    const property = (attributes.property || attributes.name || attributes.itemprop || '').toLowerCase();
    const value = attributes.content || attributes.href || attributes.src;
    if (!value) continue;
    const isLogo = property.includes('logo') || rel.includes('logo') || /logo/i.test(attributes.alt || '');
    const isIcon = /icon|apple-touch/i.test(rel);
    const isBrandedImage = /logo|brand/i.test(value);
    if (isLogo || isBrandedImage) prioritized.push({ url: value, source: 'official-site-logo' });
    else if (isIcon) icons.push({ url: value, source: 'official-site-icon' });
  }

  const result = [];
  for (const item of [...prioritized, ...icons]) {
    try {
      const parsed = new URL(item.url, pageUrl);
      if (parsed.protocol !== 'https:' || !allowedOfficialHost(parsed.hostname, domain)) continue;
      if (!result.some(existing => existing.url === parsed.toString())) result.push({ ...item, url: parsed.toString() });
    } catch { /* Ignore invalid or cross-domain logo links. */ }
  }
  return result.slice(0, 5);
}

async function readLimitedBody(response, maxBytes) {
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of response.body || []) {
    const bytes = Buffer.from(chunk);
    totalBytes += bytes.length;
    if (totalBytes > maxBytes) return null;
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, totalBytes);
}

async function fetchOfficialHtml(domain, pageUrl) {
  if (!await isPublicHost(domain)) return null;
  let currentUrl = pageUrl;
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    const parsed = new URL(currentUrl);
    if (parsed.protocol !== 'https:' || !allowedOfficialHost(parsed.hostname, domain) || !await isPublicHost(parsed.hostname)) return null;
    let response;
    try {
      response = await fetchWithTimeout(currentUrl, {
        headers: { accept: 'text/html,application/xhtml+xml;q=0.9' },
        redirect: 'manual'
      }, 4500);
    } catch {
      return null;
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location) return null;
      try {
        currentUrl = new URL(location, currentUrl).toString();
      } catch {
        return null;
      }
      continue;
    }
    if (!response.ok || !/text\/html|application\/xhtml\+xml/i.test(response.headers.get('content-type') || '')) return null;
    const length = Number(response.headers.get('content-length') || 0);
    if (length > 1024 * 1024) return null;
    const bytes = await readLimitedBody(response, 1024 * 1024);
    if (!bytes) return null;
    return { html: bytes.toString('utf8'), pageUrl: currentUrl };
  }
  return null;
}

function detectImageType(bytes, header = '') {
  const contentType = header.split(';')[0].trim().toLowerCase();
  const allowed = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml', 'image/x-icon']);
  let detected = null;
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) detected = 'image/png';
  else if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) detected = 'image/jpeg';
  else if (bytes.length >= 6 && (bytes.subarray(0, 6).toString() === 'GIF87a' || bytes.subarray(0, 6).toString() === 'GIF89a')) detected = 'image/gif';
  else if (bytes.length >= 12 && bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') detected = 'image/webp';
  else if (bytes.length >= 4 && bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 1 && bytes[3] === 0) detected = 'image/x-icon';
  else {
    const text = bytes.subarray(0, Math.min(bytes.length, 5000)).toString('utf8').replace(/^\uFEFF/, '').trimStart();
    if (/<svg\b/i.test(text) && !/<script\b|<foreignObject\b|<image\b|<iframe\b|<audio\b|<video\b|\bon[a-z]+\s*=|javascript:|<!ENTITY|url\s*\(|(?:href|src)\s*=\s*["']\s*(?:https?:|\/\/|data:)/i.test(text)) detected = 'image/svg+xml';
  }
  if (!detected || (contentType && !allowed.has(contentType) && contentType !== 'application/octet-stream')) return null;
  return detected;
}

async function downloadImage(url, isAllowedHost) {
  let currentUrl = url;
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    let parsed;
    try { parsed = new URL(currentUrl); } catch { return null; }
    if (parsed.protocol !== 'https:' || !isAllowedHost(parsed.hostname) || !await isPublicHost(parsed.hostname)) return null;

    let response;
    try {
      response = await fetchWithTimeout(currentUrl, {
        headers: { accept: 'image/avif,image/webp,image/png,image/svg+xml,image/*;q=0.8' },
        redirect: 'manual'
      }, 5000);
    } catch {
      return null;
    }

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location) return null;
      try { currentUrl = new URL(location, currentUrl).toString(); } catch { return null; }
      continue;
    }
    if (!response.ok) return null;

    const declaredLength = Number(response.headers.get('content-length') || 0);
    if (declaredLength > MAX_IMAGE_BYTES) return null;
    const bytes = await readLimitedBody(response, MAX_IMAGE_BYTES);
    if (!bytes || bytes.length < 80) return null;
    const contentType = detectImageType(bytes, response.headers.get('content-type') || '');
    if (!contentType) return null;
    return { bytes, contentType, sourceUrl: parsed.toString() };
  }
  return null;
}

async function discoverLogo(candidate, previousSourceUrl = null) {
  if (candidate.logoFile) {
    const commonsUrl = `https://commons.wikimedia.org/wiki/Special:Redirect/file/${encodeURIComponent(candidate.logoFile)}`;
    const image = await downloadImage(commonsUrl, host => host === 'commons.wikimedia.org' || host === 'upload.wikimedia.org');
    if (image && image.sourceUrl !== previousSourceUrl) return { ...image, source: 'wikidata-logo' };
  }

  const page = await fetchOfficialHtml(candidate.domain, candidate.websiteUrl);
  if (page) {
    for (const option of siteLogoCandidates(page.html, page.pageUrl, candidate.domain)) {
      if (option.url === previousSourceUrl) continue;
      const image = await downloadImage(option.url, host => allowedOfficialHost(host, candidate.domain));
      if (image) return { ...image, source: option.source };
    }
  }

  const faviconUrl = new URL('/favicon.ico', candidate.websiteUrl).toString();
  if (faviconUrl !== previousSourceUrl) {
    const image = await downloadImage(faviconUrl, host => allowedOfficialHost(host, candidate.domain));
    if (image) return { ...image, source: 'official-site-favicon' };
  }
  return null;
}

function extensionFor(contentType) {
  return {
    'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp',
    'image/gif': 'gif', 'image/svg+xml': 'svg', 'image/x-icon': 'ico'
  }[contentType];
}

function storageObjectPath(domain, extension) {
  const digest = createHash('sha256').update(domain).digest('hex').slice(0, 32);
  return `${digest}.${extension}`;
}

function encodeStoragePath(value) {
  return value.split('/').map(part => encodeURIComponent(part)).join('/');
}

async function uploadLogo(path, asset) {
  const { baseUrl, serviceKey } = config();
  const response = await fetch(`${baseUrl}/storage/v1/object/${BUCKET}/${encodeStoragePath(path)}`, {
    method: 'POST',
    headers: {
      apikey: serviceKey,
      authorization: `Bearer ${serviceKey}`,
      'content-type': asset.contentType,
      'cache-control': 'public, max-age=31536000, immutable',
      'x-upsert': 'true'
    },
    body: asset.bytes,
    signal: AbortSignal.timeout(9000)
  });
  if (!response.ok) throw new Error(`Logo storage failed (${response.status})`);
  return `${baseUrl}/storage/v1/object/public/${BUCKET}/${encodeStoragePath(path)}`;
}

async function removeLogo(path) {
  if (!path) return;
  const { baseUrl, serviceKey } = config();
  await fetch(`${baseUrl}/storage/v1/object/${BUCKET}/${encodeStoragePath(path)}`, {
    method: 'DELETE',
    headers: { apikey: serviceKey, authorization: `Bearer ${serviceKey}` },
    signal: AbortSignal.timeout(5000)
  }).catch(() => {});
}

async function upsertCompany(candidate) {
  const params = new URLSearchParams({ on_conflict: 'verified_domain', select: SELECT_COLUMNS });
  const response = await databaseRequest(`/rest/v1/${TABLE}?${params.toString()}`, {
    method: 'POST',
    headers: { prefer: 'resolution=ignore-duplicates,return=representation' },
    body: JSON.stringify({
      name: candidate.name,
      normalized_name: candidate.normalizedName,
      verified_domain: candidate.domain,
      external_entity_id: candidate.externalEntityId,
      logo_source: 'unavailable',
      logo_status: 'unavailable'
    })
  });
  if (response[0]) return { row: response[0], inserted: true };
  return { row: await findByDomain(candidate.domain), inserted: false };
}

async function cacheCandidate(candidate) {
  return singleFlight(`domain:${candidate.domain}`, async () => {
    const existing = await findByDomain(candidate.domain);
    if (existing) return existing.logo_status === 'broken' ? repairRow(existing) : existing;

    const { row, inserted } = await upsertCompany(candidate);
    if (!row || !inserted) return row;
    let asset = null;
    try { asset = await discoverLogo(candidate); } catch { asset = null; }
    if (!asset) {
      return await updateCacheRow(row.id, { logo_source: 'unavailable', logo_source_url: null, logo_path: null, logo_url: null, logo_status: 'unavailable' }) || row;
    }

    const path = storageObjectPath(candidate.domain, extensionFor(asset.contentType));
    try {
      const logoUrl = await uploadLogo(path, asset);
      return await updateCacheRow(row.id, {
        logo_path: path,
        logo_url: logoUrl,
        logo_source: asset.source,
        logo_source_url: asset.sourceUrl,
        logo_status: 'cached'
      }) || { ...row, logo_path: path, logo_url: logoUrl, logo_status: 'cached' };
    } catch {
      await removeLogo(path);
      return await updateCacheRow(row.id, { logo_source: 'unavailable', logo_source_url: null, logo_path: null, logo_url: null, logo_status: 'unavailable' }) || row;
    }
  });
}

async function candidateFromRow(row) {
  let entity = null;
  if (row.external_entity_id && /^Q\d+$/.test(row.external_entity_id)) {
    const url = new URL('https://www.wikidata.org/w/api.php');
    url.search = new URLSearchParams({
      action: 'wbgetentities', ids: row.external_entity_id,
      props: 'labels|aliases|descriptions|claims', languages: 'en', format: 'json'
    }).toString();
    const data = await fetchWikidataJson(url.toString());
    entity = data.entities?.[row.external_entity_id] || null;
  } else {
    const candidates = await discoverEntities(row.name);
    return candidates.find(candidate => candidate.domain === row.verified_domain) || null;
  }
  if (!entity) return null;
  const website = officialWebsite(entity);
  if (!website || website.domain !== row.verified_domain) return null;
  return {
    externalEntityId: entity.id,
    name: entity.labels?.en?.value || row.name,
    normalizedName: row.normalized_name,
    domain: row.verified_domain,
    websiteUrl: website.url,
    sourceWebsiteUrl: website.originalUrl,
    logoFile: wikidataLogoFile(entity)
  };
}

async function repairRow(row) {
  return singleFlight(`repair:${row.id}`, async () => {
    await updateCacheRow(row.id, { logo_status: 'broken' });
    let candidate = null;
    try { candidate = await candidateFromRow(row); } catch { candidate = null; }
    if (!candidate) {
      await removeLogo(row.logo_path);
      return await updateCacheRow(row.id, {
        logo_path: null, logo_url: null, logo_source: 'unavailable',
        logo_source_url: null, logo_status: 'unavailable'
      }) || { ...row, logo_url: null, logo_status: 'unavailable' };
    }

    let asset = null;
    try { asset = await discoverLogo(candidate, row.logo_source_url); } catch { asset = null; }
    if (!asset) {
      await removeLogo(row.logo_path);
      return await updateCacheRow(row.id, {
        external_entity_id: candidate.externalEntityId,
        logo_path: null, logo_url: null, logo_source: 'unavailable',
        logo_source_url: null, logo_status: 'unavailable'
      }) || { ...row, logo_url: null, logo_status: 'unavailable' };
    }

    const path = storageObjectPath(candidate.domain, extensionFor(asset.contentType));
    try {
      const logoUrl = await uploadLogo(path, asset);
      return await updateCacheRow(row.id, {
        external_entity_id: candidate.externalEntityId,
        logo_path: path, logo_url: logoUrl,
        logo_source: asset.source, logo_source_url: asset.sourceUrl,
        logo_status: 'cached'
      }) || { ...row, logo_path: path, logo_url: logoUrl, logo_status: 'cached' };
    } catch {
      await removeLogo(path);
      return await updateCacheRow(row.id, {
        logo_path: null, logo_url: null, logo_source: 'unavailable',
        logo_source_url: null, logo_status: 'unavailable'
      }) || { ...row, logo_url: null, logo_status: 'unavailable' };
    }
  });
}

async function cachedRowsForQuery(query) {
  const normalized = normalizeName(query);
  const exact = await databaseRequest(tablePath({ normalized_name: `eq.${normalized}` }, MAX_RESULTS));
  if (exact.length) return exact;
  const partial = normalized.replace(/[,*%_]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!partial) return [];
  return databaseRequest(tablePath({ normalized_name: `ilike.*${partial}*` }, MAX_RESULTS));
}

async function searchCompanies(query) {
  const cached = await cachedRowsForQuery(query);
  if (cached.length) {
    const rows = await Promise.all(cached.map(row => row.logo_status === 'broken' ? repairRow(row) : row));
    return { companies: rows.filter(Boolean).map(publicCompany), cache: 'hit' };
  }

  const candidates = await discoverEntities(query);
  if (!candidates.length) return { companies: [], cache: 'miss' };
  const rows = await Promise.all(candidates.map(cacheCandidate));
  const uniqueRows = [...new Map(rows.filter(Boolean).map(row => [row.id, row])).values()];
  return { companies: uniqueRows.map(publicCompany), cache: 'discovered' };
}

function singleFlight(key, operation) {
  const current = inFlight.get(key);
  if (current) return current;
  const promise = Promise.resolve().then(operation).finally(() => inFlight.delete(key));
  inFlight.set(key, promise);
  return promise;
}

function withinRateLimit(req) {
  const now = Date.now();
  const ip = String(req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
  const bucket = requestCounts.get(ip) || { count: 0, resetAt: now + 60_000 };
  if (now > bucket.resetAt) {
    bucket.count = 0;
    bucket.resetAt = now + 60_000;
  }
  bucket.count += 1;
  requestCounts.set(ip, bucket);
  if (requestCounts.size > 1000) {
    for (const [key, entry] of requestCounts) if (now > entry.resetAt) requestCounts.delete(key);
  }
  return bucket.count <= 45;
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') return JSON.parse(req.body || '{}');
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 4096) throw new Error('Request is too large');
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks).toString('utf8');
  return body ? JSON.parse(body) : {};
}

function sendJson(res, statusCode, payload, cacheState = null) {
  res.statusCode = statusCode;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('x-content-type-options', 'nosniff');
  if (cacheState) res.setHeader('x-company-cache', cacheState);
  res.end(JSON.stringify(payload));
}

async function handleSearch(query) {
  return singleFlight(`query:${normalizeName(query)}`, () => searchCompanies(query));
}

async function handleRepair(body) {
  const id = String(body?.id || '');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return { status: 400, body: { error: 'Invalid company reference.' } };
  }
  const row = await findById(id);
  if (!row) return { status: 404, body: { error: 'Company cache entry was not found.' } };
  const repaired = await repairRow(row);
  return { status: 200, body: { company: publicCompany(repaired) } };
}

async function handler(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed.' });
  if (!withinRateLimit(req)) return sendJson(res, 429, { error: 'Too many searches. Please try again shortly.' });

  let body;
  try { body = await readBody(req); } catch {
    return sendJson(res, 400, { error: 'Invalid search request.' });
  }
  const action = body?.action;

  try {
    if (action === 'repair') {
      const result = await handleRepair(body);
      return sendJson(res, result.status, result.body);
    }
    if (action !== 'search') return sendJson(res, 400, { error: 'Unsupported company search action.' });
    const query = safeQuery(body?.query);
    if (query.length < 2) return sendJson(res, 200, { companies: [] }, 'miss');
    const result = await handleSearch(query);
    return sendJson(res, 200, { companies: result.companies }, result.cache);
  } catch {
    return sendJson(res, 503, { error: 'Company search is temporarily unavailable.' });
  }
}

module.exports = handler;
module.exports.config = {
  maxDuration: 30,
  api: { bodyParser: { sizeLimit: '4kb' } }
};
