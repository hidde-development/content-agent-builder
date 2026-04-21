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

  // Veiligheid: alleen http/https, geen interne adressen
  if (!/^https?:$/.test(target.protocol)) {
    return res.status(400).json({ error: 'Alleen http(s) URLs zijn toegestaan.' });
  }

  // Probeer in volgorde: exacte URL → /sitemap.xml → /sitemap_index.xml
  const candidates = [target.href];
  if (!target.pathname.endsWith('.xml')) {
    const base = target.origin;
    candidates.push(base + '/sitemap.xml', base + '/sitemap_index.xml');
  }

  let xml = null;
  let fetchedUrl = null;
  let lastErr = null;

  for (const c of candidates) {
    try {
      const resp = await fetch(c, {
        headers: { 'User-Agent': 'Goldfizh-Content-Agent-Builder/1.0' },
        redirect: 'follow',
      });
      if (!resp.ok) { lastErr = 'HTTP ' + resp.status + ' op ' + c; continue; }
      const text = await resp.text();
      if (text.includes('<urlset') || text.includes('<sitemapindex')) {
        xml = text;
        fetchedUrl = c;
        break;
      }
      lastErr = 'Geen sitemap-XML gevonden op ' + c;
    } catch (err) {
      lastErr = err.message;
    }
  }

  if (!xml) {
    return res.status(404).json({ error: 'Kon geen sitemap vinden. Laatste fout: ' + (lastErr || 'onbekend') });
  }

  // Als sitemap-index: haal eerste child-sitemap en combineer
  if (xml.includes('<sitemapindex')) {
    const childMatches = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1].trim()).slice(0, 5);
    const parts = [];
    for (const child of childMatches) {
      try {
        const r = await fetch(child, { headers: { 'User-Agent': 'Goldfizh-Content-Agent-Builder/1.0' } });
        if (r.ok) parts.push(await r.text());
      } catch {}
    }
    xml = parts.length ? parts.join('\n') : xml;
  }

  return res.status(200).json({ xml, fetchedUrl });
};
