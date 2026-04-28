const EXTRACTION_PROMPT = `Analyseer de meegestuurde documenten en extraheer de volgende informatie als JSON.
Vul alleen in wat je met zekerheid kunt afleiden uit de documenten.
Laat velden leeg ("" of []) als de informatie niet aanwezig is.
Geef ALLEEN de JSON terug, geen uitleg, geen markdown code blocks.

BELANGRIJK voor het veld "merktermen" (entiteiten):
Dit zijn GEEN slogans, merkwaarden of interne termen.
Dit zijn brede zoek-entiteiten waar de merkassociatie van de organisatie op gebouwd wordt.

HARDE EISEN:
- MAXIMAAL 10 merktermen (liever 6–8 sterke dan 10 middelmatige)
- MAXIMAAL 3 woorden per term
- Elke term moet op ELKE pagina van deze klant passen — niet slechts op één specifieke pagina

Gebruik de "elke pagina"-test: past de term op zowel de homepage, een dienstpagina over onderwerp A, als een artikel over onderwerp B? Zo ja: merkterm. Zo nee: weglaten (die zijn te specifiek en horen in de contentstrategie, niet in de merktermen).

Voorbeeld letselschade advocaat:
  ✓ "letselschade", "smartengeld berekenen", "schadevergoeding" — breed inzetbaar, passen op elke pagina
  ✗ "whiplash vergoeding", "verkeersongeval advocaat" — te pagina-specifiek, wel SEO-relevant maar geen merkterm

Voorbeeld boekhouder:
  ✓ "boekhouder zzp", "administratie uitbesteden", "online boekhouden" — brede merkassociatie
  ✗ "btw aangifte 2026", "ZZP jaarrekening" — te specifiek/tijdelijk

{
  "CLIENT_NAME": "officiële naam van de organisatie",
  "AANSPREEKVORM": "je/jij of u — kies exact één van deze twee",
  "TAAL": "taalcode van de content: nl-NL of en-GB of en-US of de-DE — kies exact één",
  "DOELMARKT": "B2B of B2C of Beide — kies exact één op basis van de doelgroep",
  "LEESNIVEAU": "B1 of B2 of C1 — kies exact één op basis van de complexiteit van de teksten",
  "ZINSSTRUCTUUR": "kort en scanbaar of gevarieerd of uitgebreid — kies exact één",
  "TOON_OMSCHRIJVING": "beknopte omschrijving van de gewenste schrijftoon",
  "TOON_VERMIJDEN": "te vermijden toon of stijl",
  "JARGON_BELEID": "minimaal of branche-specifiek of ruim — kies exact één",
  "MERKWAARDEN_LIJST": "kommagescheiden merkwaarden",
  "verboden": ["woord1", "woord2"],
  "externe_bronnen": ["externe bron of website die geciteerd mag worden"],
  "guardrails": [{"gedrag": "wat de agent absoluut niet mag doen of zeggen", "reden": "waarom dit verboden is"}],
  "DOELGROEP_ROL": "functietitel of rol van de doelgroep",
  "DOELGROEP_SECTOR": "sector of branche van de doelgroep",
  "DOELGROEP_NIVEAU": "kennisniveau: beginner of gevorderd of expert",
  "DOELGROEP_VOCABULAIRE": "hoe de doelgroep hun problemen in eigen woorden beschrijft",
  "DOELGROEP_WANTROUWEN": "wat de doelgroep niet zomaar gelooft zonder bewijs",
  "zorgen": ["primaire zorg 1", "primaire zorg 2"],
  "uitkomsten": ["kernuitkomst 1", "kernuitkomst 2", "kernuitkomst 3"],
  "strategie": ["redactioneel principe 1", "redactioneel principe 2"],
  "pijlers": [{"naam": "pijlernaam", "desc": "hoe dit terugkomt in toon of inhoud (één zin)"}],
  "producten": [{"naam": "productnaam", "desc": "kernfunctie of voornaamste voordeel", "url": "relatieve of absolute URL indien bekend"}],
  "merktermen": [{"term": "brede merkterm (max 3 woorden, passend op elke pagina)", "uitleg": "waarom dit een merkterm is en niet een pagina-specifieke zoekterm"}],
  "intakevragen": {
    "dienstpagina": ["aanvullende vraag specifiek voor dit type pagina bij deze klant"],
    "productpagina": ["aanvullende vraag specifiek voor dit type pagina bij deze klant"],
    "artikelpagina": ["aanvullende vraag specifiek voor dit type pagina bij deze klant"],
    "case": ["aanvullende vraag specifiek voor dit type pagina bij deze klant"],
    "social-proof": ["aanvullende vraag specifiek voor dit type pagina bij deze klant"]
  }
}

BELANGRIJK voor "intakevragen":
Zoek in de documenten naar checklists, instructies, vereiste informatie of vragen die gesteld moeten worden vóór het schrijven van een bepaald paginatype.
Laat een type leeg ([]) als er geen specifieke instructies voor zijn gevonden.
Verzin GEEN vragen — extraheer alleen wat expliciet in de documenten staat.`;

module.exports = async function handler(req, res) {
  try {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { accessCode, files, verify } = req.body || {};

  // Validate access code
  const expectedCode = process.env.ACCESS_CODE;
  if (expectedCode && accessCode !== expectedCode) {
    return res.status(401).json({ error: 'Ongeldige toegangscode' });
  }

  // Just verifying the code, no files needed
  if (verify) {
    return res.status(200).json({ ok: true });
  }

  if (!files || files.length === 0) {
    return res.status(400).json({ error: 'Geen bestanden meegestuurd' });
  }

  // Build message content for Claude
  const content = [];
  const MAX_TEXT_PER_FILE = 80000; // ~20K tokens — voorkomt Vercel 60s-timeout op grote MD/TXT

  for (const file of files) {
    // Skip XML/sitemaps server-side als ze toch zijn doorgekomen — dragen niet bij aan brand-extractie
    if (file.name && file.name.toLowerCase().endsWith('.xml')) continue;

    if (file.mediaType === 'application/pdf') {
      content.push({
        type: 'document',
        source: {
          type: 'base64',
          media_type: 'application/pdf',
          data: file.data,
        },
        title: file.name,
      });
    } else {
      let text = String(file.data || '');
      let truncatedNote = '';
      if (text.length > MAX_TEXT_PER_FILE) {
        text = text.slice(0, MAX_TEXT_PER_FILE);
        truncatedNote = `\n\n[…afgekapt op ${MAX_TEXT_PER_FILE} tekens — origineel was ${file.data.length}]`;
      }
      content.push({
        type: 'text',
        text: `--- Bestand: ${file.name} ---\n${text}${truncatedNote}`,
      });
    }
  }

  content.push({ type: 'text', text: EXTRACTION_PROMPT });

  // Call Anthropic API
  let apiResponse;
  try {
    apiResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.Claude,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 8192,
        messages: [{ role: 'user', content }],
      }),
    });
  } catch (err) {
    return res.status(500).json({ error: 'Kon de Anthropic API niet bereiken' });
  }

  if (!apiResponse.ok) {
    const text = await apiResponse.text();
    return res.status(500).json({ error: 'Anthropic API fout: ' + text });
  }

  const data = await apiResponse.json();
  const text = data.content?.[0]?.text || '';
  const stopReason = data.stop_reason || '';

  // Probeer JSON op meerdere manieren te extraheren (Claude kan wrappers toevoegen)
  const candidates = [];
  // 1. Probeer ```json ... ``` code block
  const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) candidates.push(codeBlockMatch[1].trim());
  // 2. Probeer greedy { ... } match
  const greedyMatch = text.match(/\{[\s\S]*\}/);
  if (greedyMatch) candidates.push(greedyMatch[0]);
  // 3. De ruwe tekst zelf (als Claude pure JSON teruggaf)
  candidates.push(text.trim());

  if (!candidates.length) {
    return res.status(500).json({
      error: 'Kon geen gegevens extraheren uit de documenten',
      stopReason,
      preview: text.slice(0, 300),
    });
  }

  let fields = null;
  let lastErr = null;
  for (const cand of candidates) {
    try {
      fields = JSON.parse(cand);
      break;
    } catch (err) {
      lastErr = err;
      // Probeer trailing commas te strippen (veelvoorkomende Claude-fout)
      try {
        const cleaned = cand.replace(/,\s*([}\]])/g, '$1');
        fields = JSON.parse(cleaned);
        break;
      } catch {}
    }
  }

  if (fields) {
    return res.status(200).json({ fields });
  }

  if (stopReason === 'max_tokens') {
    return res.status(500).json({
      error: 'Response afgekapt (max_tokens bereikt). Upload minder of kleinere documenten, of splits de intake.',
      stopReason,
    });
  }

  return res.status(500).json({
    error: 'Onverwacht formaat van de API-respons: ' + (lastErr ? lastErr.message : 'onbekend'),
    stopReason,
    preview: (candidates[0] || text).slice(0, 500) + '…',
  });

  } catch (err) {
    return res.status(500).json({ error: 'Serverfout: ' + err.message });
  }
};
