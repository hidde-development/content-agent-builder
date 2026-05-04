const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

async function fetchText(url) {
  const resp = await fetch(url, {
    headers: {
      'User-Agent': BROWSER_UA,
      'Accept': 'application/xml,text/xml,text/plain,*/*',
      'Accept-Language': 'nl,en;q=0.8',
    },
    redirect: 'follow',
  });
  if (!resp.ok) throw new Error('HTTP ' + resp.status + ' op ' + url);
  return await resp.text();
}

async function tryFetchSitemap(urls) {
  const errors = [];
  for (const u of urls) {
    try {
      const text = await fetchText(u);
      if (text.includes('<urlset') || text.includes('<sitemapindex')) {
        return { xml: text, fetchedUrl: u };
      }
      errors.push('Geen sitemap-XML op ' + u);
    } catch (err) {
      errors.push(err.message);
    }
  }
  return { error: errors.join(' · ') };
}

async function parseRobotsTxt(text) {
  return text
    .split('\n')
    .map(l => l.trim())
    .filter(l => /^sitemap:/i.test(l))
    .map(l => l.replace(/^sitemap:\s*/i, '').trim())
    .filter(Boolean);
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { url } = req.body || {};
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'Geef een URL mee.' });
  }

  let target;
  try {
    target = new URL(url);
  } catch {
    return res.status(400).json({ error: 'Ongeldige URL.' });
  }

  if (!/^https?:$/.test(target.protocol)) {
    return res.status(400).json({ error: 'Alleen http(s) URLs zijn toegestaan.' });
  }

  // Blokkeer private/loopback IP-ranges (SSRF-preventie).
  const hostname = target.hostname;
  const privatePattern = /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|169\.254\.|::1$|localhost$)/i;
  if (privatePattern.test(hostname)) {
    return res.status(400).json({ error: 'Interne of lokale adressen zijn niet toegestaan.' });
  }

  const origin = target.origin;
  const isRobotsTxt = /robots\.txt$/i.test(target.pathname);
  const isXml = /\.xml$/i.test(target.pathname);

  const collectedErrors = [];

  // Stap 1: als het een robots.txt is, lees Sitemap: directive
  if (isRobotsTxt) {
    try {
      const robots = await fetchText(target.href);
      const sitemapUrls = await parseRobotsTxt(robots);
      if (sitemapUrls.length) {
        const result = await tryFetchSitemap(sitemapUrls);
        if (result.xml) return finalize(res, result);
        collectedErrors.push('Sitemap-URLs uit robots.txt: ' + result.error);
      } else {
        collectedErrors.push('Geen Sitemap: directive gevonden in robots.txt');
      }
    } catch (err) {
      collectedErrors.push('robots.txt niet ophalbaar: ' + err.message);
    }
  }

  // Stap 2: als het een directe XML-URL is, probeer die
  if (isXml) {
    const result = await tryFetchSitemap([target.href]);
    if (result.xml) return finalize(res, result);
    collectedErrors.push(result.error);
  }

  // Stap 3: robots.txt op root proberen (tenzij dat al stap 1 was)
  if (!isRobotsTxt) {
    try {
      const robots = await fetchText(origin + '/robots.txt');
      const sitemapUrls = await parseRobotsTxt(robots);
      if (sitemapUrls.length) {
        const result = await tryFetchSitemap(sitemapUrls);
        if (result.xml) return finalize(res, result);
        collectedErrors.push('Via robots.txt gevonden URLs: ' + result.error);
      }
    } catch {}
  }

  // Stap 4: bekende standaardlocaties
  const candidates = [
    origin + '/sitemap.xml',
    origin + '/sitemap_index.xml',
    origin + '/wp-sitemap.xml',
    origin + '/sitemap-index.xml',
    origin + '/sitemap/sitemap.xml',
  ];
  const result = await tryFetchSitemap(candidates);
  if (result.xml) return finalize(res, result);
  collectedErrors.push(result.error);

  return res.status(404).json({
    error: 'Kon geen sitemap vinden. Laatste pogingen: ' + collectedErrors.join(' | '),
  });
};

async function finalize(res, result) {
  let xml = result.xml;

  // Als sitemap-index: haal eerste child-sitemaps en combineer
  if (xml.includes('<sitemapindex')) {
    const childMatches = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1].trim()).slice(0, 5);
    const parts = [];
    for (const child of childMatches) {
      try {
        parts.push(await fetchText(child));
      } catch {}
    }
    if (parts.length) xml = parts.join('\n');
  }

  return res.status(200).json({ xml, fetchedUrl: result.fetchedUrl });
}
