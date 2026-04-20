const EXTRACTION_PROMPT = `Analyseer de meegestuurde documenten en extraheer de volgende informatie als JSON.
Vul alleen in wat je met zekerheid kunt afleiden uit de documenten.
Laat velden leeg ("" of []) als de informatie niet aanwezig is.
Geef ALLEEN de JSON terug, geen uitleg, geen markdown code blocks.

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
  "merktermen": [{"term": "merkterm of zoekzin", "uitleg": "hoe of wanneer inzetten"}]
}`;

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

  for (const file of files) {
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
      // Plain text or markdown
      content.push({
        type: 'text',
        text: `--- Bestand: ${file.name} ---\n${file.data}`,
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
        max_tokens: 2048,
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

  // Extract JSON from response (Claude might wrap it in backticks)
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return res.status(500).json({ error: 'Kon geen gegevens extraheren uit de documenten' });
  }

  try {
    const fields = JSON.parse(jsonMatch[0]);
    return res.status(200).json({ fields });
  } catch {
    return res.status(500).json({ error: 'Onverwacht formaat van de API-respons' });
  }

  } catch (err) {
    return res.status(500).json({ error: 'Serverfout: ' + err.message });
  }
};
