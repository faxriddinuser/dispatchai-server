const express = require('express');
const cors = require('cors');
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));
const app = express();

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI || 'https://dispatchai-server-production.up.railway.app/callback';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const MAPS_KEY = process.env.GOOGLE_MAPS_API_KEY;
const SAMSARA_KEY = process.env.SAMSARA_API_KEY;
const PORT = process.env.PORT || 3000;

let tokens = {};
let serverSessions = {}; // username -> { role, ts }

app.get('/debug', (req, res) => {
  const cid = process.env.GOOGLE_CLIENT_ID || 'NOT SET';
  const secret = process.env.GOOGLE_CLIENT_SECRET || 'NOT SET';
  const anthropic = process.env.ANTHROPIC_API_KEY || 'NOT SET';
  res.json({
    client_id_set: !!process.env.GOOGLE_CLIENT_ID,
    client_id_preview: cid.slice(0,20)+'...'+cid.slice(-20),
    client_id_length: cid.length,
    client_secret_set: !!process.env.GOOGLE_CLIENT_SECRET,
    client_secret_length: secret.length,
    anthropic_key_set: !!process.env.ANTHROPIC_API_KEY,
    anthropic_key_preview: anthropic.slice(0,15)+'...',
    redirect_uri: process.env.REDIRECT_URI || 'NOT SET',
    tokens_set: !!tokens.access_token
  });
});

app.get('/auth', (req, res) => {
  if (!CLIENT_ID) return res.send('<h2 style="color:red;font-family:sans-serif;">GOOGLE_CLIENT_ID not set in Railway Variables!</h2>');
  const url = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
    client_id: CLIENT_ID, redirect_uri: REDIRECT_URI,
    response_type: 'code', scope: 'https://www.googleapis.com/auth/gmail.readonly',
    access_type: 'offline', prompt: 'consent'
  });
  res.redirect(url);
});

app.get('/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.redirect('/?error=' + encodeURIComponent(error));
  try {
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code, client_id: CLIENT_ID, client_secret: CLIENT_SECRET, redirect_uri: REDIRECT_URI, grant_type: 'authorization_code' })
    });
    const data = await r.json();
    if (data.error) return res.redirect('/?error=' + encodeURIComponent(data.error_description || data.error));
    tokens = data;
    tokens.expires_at = Date.now() + (tokens.expires_in * 1000);
    console.log('Gmail connected');
    res.redirect('/?connected=true');
  } catch(e) { res.redirect('/?error=' + encodeURIComponent(e.message)); }
});

async function getFreshToken() {
  if (!tokens.access_token) throw new Error('not_authenticated');
  if (Date.now() < (tokens.expires_at - 60000)) return tokens.access_token;
  if (!tokens.refresh_token) throw new Error('no_refresh_token');
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, refresh_token: tokens.refresh_token, grant_type: 'refresh_token' })
  });
  const data = await r.json();
  if (data.error) throw new Error(data.error);
  tokens.access_token = data.access_token;
  tokens.expires_at = Date.now() + (data.expires_in * 1000);
  return tokens.access_token;
}

app.get('/status', async (req, res) => {
  try { await getFreshToken(); res.json({ connected: true }); }
  catch(e) { res.json({ connected: false, reason: e.message }); }
});

app.get('/emails', async (req, res) => {
  try {
    const t = await getFreshToken();
    const { q = 'rate confirmation OR rate con OR load confirmation has:attachment', maxResults = 25 } = req.query;
    const r = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(q)}&maxResults=${maxResults}`, { headers: { Authorization: 'Bearer ' + t } });
    const data = await r.json();
    if (data.error) return res.status(400).json({ error: data.error.message });
    const messages = data.messages || [];
    const details = [];
    for (const msg of messages.slice(0, 30)) {
      try {
        const d = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=full`, { headers: { Authorization: 'Bearer ' + t } });
        const md = await d.json();
        const h = md.payload?.headers || [];
        const allParts = [];
        function collectParts(parts) { if (!parts) return; for (const p of parts) { allParts.push(p); if (p.parts) collectParts(p.parts); } }
        collectParts(md.payload?.parts || []);
        if (md.payload?.body?.attachmentId) allParts.push(md.payload);
        const atts = allParts.filter(p => p.filename && p.filename.length > 0 && p.body?.attachmentId && p.filename.match(/\.(pdf|doc|docx|png|jpg|jpeg)$/i)).map(p => ({ name: p.filename, id: p.body.attachmentId, mimeType: p.mimeType, msgId: msg.id }));
        details.push({ id: msg.id, from: h.find(x=>x.name==='From')?.value||'', subject: h.find(x=>x.name==='Subject')?.value||'', date: h.find(x=>x.name==='Date')?.value||'', snippet: md.snippet||'', attachments: atts });
      } catch(e) { console.error('Email fetch error:', e.message); }
    }
    res.json({ messages: details });
  } catch(e) { res.status(401).json({ error: e.message }); }
});

app.get('/attachment/:msgId/:attId', async (req, res) => {
  try {
    const t = await getFreshToken();
    const r = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${req.params.msgId}/attachments/${req.params.attId}`, { headers: { Authorization: 'Bearer ' + t } });
    const data = await r.json();
    if (data.error) return res.status(400).json({ error: data.error.message });
    res.json({ data: data.data });
  } catch(e) { res.status(400).json({ error: e.message }); }
});

app.post('/extract', async (req, res) => {
  try {
    if (!ANTHROPIC_KEY) return res.status(400).json({ error: 'ANTHROPIC_API_KEY not set in Railway Variables' });
    const { b64, mimeType, emailNotes } = req.body;
    if (!b64) return res.status(400).json({ error: 'No attachment data' });
    let fixedB64 = b64.replace(/-/g, '+').replace(/_/g, '/');
    while (fixedB64.length % 4) fixedB64 += '=';
    const isImg = mimeType?.startsWith('image/');
    const docPart = isImg
      ? { type: 'image', source: { type: 'base64', media_type: mimeType, data: fixedB64 } }
      : { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: fixedB64 } };
    const EP = `Read this rate confirmation document carefully and extract ALL load information. Return ONLY valid JSON with this exact structure:
{"loadNumber":"string","broker":"string","commodity":"string or null","equipment":"string or null","rate":number or null,"emptyMiles":number or null,"loadedMiles":number or null,"totalMiles":number or null,"weight":"string or null","stops":[{"stopNumber":1,"type":"PU","company":"string","address":"string","city":"string","state":"string","zip":"string","date":"string like April 07 2026","timeWindow":"string like 08:00 or 08:00-14:00","reference":"string or null","instructions":"string or null"}],"specialInstructions":"string or null"}
Extract EVERY stop with full address, date, and time. Do not leave real data as null. Return ONLY the JSON object.`;
    const apiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 2000, system: 'You extract data from trucking rate confirmation documents. Return ONLY valid JSON.', messages: [{ role: 'user', content: [docPart, { type: 'text', text: EP }] }] })
    });
    const data = await apiRes.json();
    if (data.error) { console.error('Anthropic error:', data.error); return res.status(400).json({ error: data.error.message || JSON.stringify(data.error) }); }
    const rawText = data.content?.[0]?.text || '';
    console.log('Extraction result preview:', rawText.slice(0, 200));
    const ld = JSON.parse(rawText.replace(/```json|```/g, '').trim());
    console.log('Load extracted:', ld.loadNumber, 'stops:', ld.stops?.length);
    res.json({ load: { ...ld, emailNotes: emailNotes || '' } });
  } catch(e) { console.error('Extract error:', e.message); res.status(400).json({ error: e.message }); }
});

app.post('/extract-text', async (req, res) => {
  try {
    if (!ANTHROPIC_KEY) return res.status(400).json({ error: 'ANTHROPIC_API_KEY not set' });
    const { text, emailNotes } = req.body;
    const EP = `Extract all load info from this rate confirmation. Return ONLY valid JSON:
{"loadNumber":"string","broker":"string","commodity":"string or null","equipment":"string or null","rate":number or null,"emptyMiles":number or null,"loadedMiles":number or null,"totalMiles":number or null,"weight":"string or null","stops":[{"stopNumber":1,"type":"PU","company":"string","address":"string","city":"string","state":"string","zip":"string","date":"string","timeWindow":"string","reference":"string or null","instructions":"string or null"}],"specialInstructions":"string or null"}

Text:
${text}`;
    const apiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 2000, system: 'Extract load data. Return ONLY valid JSON.', messages: [{ role: 'user', content: EP }] })
    });
    const data = await apiRes.json();
    if (data.error) return res.status(400).json({ error: data.error.message });
    const ld = JSON.parse(data.content[0].text.replace(/```json|```/g, '').trim());
    res.json({ load: { ...ld, emailNotes: emailNotes || '' } });
  } catch(e) { res.status(400).json({ error: e.message }); }
});

app.post('/generate-message', async (req, res) => {
  try {
    if (!ANTHROPIC_KEY) return res.status(400).json({ error: 'ANTHROPIC_API_KEY not set' });
    const { load, driver, notes } = req.body;
    const stops = (load.stops || []).map((s, i) => `Stop ${i+1} (${s.type}): ${s.company}, ${s.address}, ${s.city} ${s.state} ${s.zip} — ${s.date} @ ${s.timeWindow}${s.reference?' | Ref:'+s.reference:''}${s.instructions?' | NOTE:'+s.instructions:''}`).join('\n');
    const prompt = `Generate a driver dispatch text message using the EXACT load data below. Fill in ALL real values — nothing should say TBD or remain in brackets.

Driver: ${driver.name}, Truck #${driver.truck}
Load #: ${load.loadNumber}
Broker: ${load.broker}
Rate: ${load.rate ? '$' + load.rate : 'see rate con'}
Equipment: ${load.equipment || 'Standard'}
Commodity: ${load.commodity || 'General freight'}
Loaded Miles: ${load.loadedMiles || load.totalMiles || 'see rate con'}
${notes ? 'Extra notes: ' + notes : ''}

Stops:
${stops}

Format:
Hey [Driver First Name]! 🚛

Load #: [number] | Broker: [broker name]
━━━━━━━━━━━━━━━━━━
📍 PICKUP
[Company Name]
[Full Street Address]
[City, State ZIP]
📅 [Date] at [Time]
━━━━━━━━━━━━━━━━━━
📍 DELIVERY
[Company Name]
[Full Street Address]
[City, State ZIP]
📅 [Date]: [Time Window]
━━━━━━━━━━━━━━━━━━
💰 Rate: $[amount] | 📏 [miles] loaded mi | 🚛 Truck #[truck]

🔺 Do PTI before departure
🔺 Send trailer photos to group
🔺 Scale after pickup
${notes ? '🔺 ' + notes : ''}

Drive safe! ✅

Return ONLY the message. Use real data from the stops above.`;
    const apiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 800, system: 'Generate driver dispatch messages with real load data. Never use TBD or placeholder text. Return only the message.', messages: [{ role: 'user', content: prompt }] })
    });
    const data = await apiRes.json();
    if (data.error) return res.status(400).json({ error: data.error.message });
    res.json({ message: data.content?.[0]?.text || 'Error generating message' });
  } catch(e) { res.status(400).json({ error: e.message }); }
});

// ─── GOOGLE MAPS MILES ───────────────────────────────────

// Clean and normalize city/address strings before sending to Maps API
function cleanLocation(loc) {
  if (!loc) return '';
  let s = loc.toString().trim();
  // Remove things like "Dock 14", "Gate A", warehouse instructions etc
  s = s.replace(/(dock|gate|suite|ste|apt|unit|bldg|floor|fl|rm|room)\s*[\w#-]*/gi, '').trim();
  // Fix common abbreviations
  const stateMap = {
    'AL':'Alabama','AK':'Alaska','AZ':'Arizona','AR':'Arkansas','CA':'California',
    'CO':'Colorado','CT':'Connecticut','DE':'Delaware','FL':'Florida','GA':'Georgia',
    'HI':'Hawaii','ID':'Idaho','IL':'Illinois','IN':'Indiana','IA':'Iowa',
    'KS':'Kansas','KY':'Kentucky','LA':'Louisiana','ME':'Maine','MD':'Maryland',
    'MA':'Massachusetts','MI':'Michigan','MN':'Minnesota','MS':'Mississippi','MO':'Missouri',
    'MT':'Montana','NE':'Nebraska','NV':'Nevada','NH':'New Hampshire','NJ':'New Jersey',
    'NM':'New Mexico','NY':'New York','NC':'North Carolina','ND':'North Dakota','OH':'Ohio',
    'OK':'Oklahoma','OR':'Oregon','PA':'Pennsylvania','RI':'Rhode Island','SC':'South Carolina',
    'SD':'South Dakota','TN':'Tennessee','TX':'Texas','UT':'Utah','VT':'Vermont',
    'VA':'Virginia','WA':'Washington','WV':'West Virginia','WI':'Wisconsin','WY':'Wyoming',
    'DC':'Washington DC'
  };
  // If it's just a state abbreviation, expand it
  s = s.replace(/,\s*([A-Z]{2})\s*(\d{5}(-\d{4})?)?$/, (match, st, zip) => {
    return ', ' + (stateMap[st] || st) + (zip ? ' ' + zip : '');
  });
  // Remove zip codes for cleaner geocoding
  s = s.replace(/\s+\d{5}(-\d{4})?$/, '').trim();
  // Remove extra whitespace
  s = s.replace(/\s+/g, ' ').trim();
  // Remove trailing commas
  s = s.replace(/,+$/, '').trim();
  return s;
}

// Use Google Geocoding API to resolve a fuzzy location to coordinates
async function geocodeLocation(loc) {
  const cleaned = cleanLocation(loc);
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(cleaned)}&key=${MAPS_KEY}`;
  const r = await fetch(url);
  const data = await r.json();
  if (data.status === 'OK' && data.results?.[0]) {
    const result = data.results[0];
    return {
      formatted: result.formatted_address,
      lat: result.geometry.location.lat,
      lng: result.geometry.location.lng
    };
  }
  return null;
}

// Use Claude to clean up messy location strings
async function aiCleanLocation(loc) {
  if (!ANTHROPIC_KEY) return loc;
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 50,
        system: 'Extract just the city and state from this trucking address. Return ONLY "City, ST" format. No other text.',
        messages: [{ role: 'user', content: loc }]
      })
    });
    const data = await r.json();
    return data.content?.[0]?.text?.trim() || loc;
  } catch(e) { return loc; }
}

async function calcMilesBetween(origin, destination) {
  // Try direct Distance Matrix first
  const tryDistanceMatrix = async (orig, dest) => {
    const url = `https://maps.googleapis.com/maps/api/distancematrix/json?` +
      `origins=${encodeURIComponent(orig)}&destinations=${encodeURIComponent(dest)}` +
      `&units=imperial&mode=driving&key=${MAPS_KEY}`;
    const r = await fetch(url);
    const data = await r.json();
    if (data.status !== 'OK') return null;
    const el = data.rows?.[0]?.elements?.[0];
    if (!el || el.status !== 'OK') return null;
    const miles = Math.round(el.distance.value * 0.000621371);
    const secs = el.duration.value;
    return { miles, driveTime: Math.floor(secs/3600) + 'h ' + Math.floor((secs%3600)/60) + 'm' };
  };

  // Step 1: Try as-is
  let result = await tryDistanceMatrix(origin, destination);
  if (result) { console.log(`Direct match: ${origin} → ${destination} = ${result.miles} mi`); return result; }

  // Step 2: Clean location strings and retry
  const cleanOrig = cleanLocation(origin);
  const cleanDest = cleanLocation(destination);
  console.log(`Cleaned: "${cleanOrig}" → "${cleanDest}"`);
  result = await tryDistanceMatrix(cleanOrig, cleanDest);
  if (result) { return result; }

  // Step 3: Geocode both locations to get precise coordinates
  console.log('Trying geocoding...');
  const [geoOrig, geoDest] = await Promise.all([geocodeLocation(origin), geocodeLocation(destination)]);
  if (geoOrig && geoDest) {
    const coordOrig = `${geoOrig.lat},${geoOrig.lng}`;
    const coordDest = `${geoDest.lat},${geoDest.lng}`;
    result = await tryDistanceMatrix(coordOrig, coordDest);
    if (result) {
      console.log(`Geocoded: ${geoOrig.formatted} → ${geoDest.formatted} = ${result.miles} mi`);
      result.resolvedOrigin = geoOrig.formatted;
      result.resolvedDest = geoDest.formatted;
      return result;
    }
  }

  // Step 4: Use Claude to extract clean city/state then retry
  console.log('Trying AI cleanup...');
  const [aiOrig, aiDest] = await Promise.all([aiCleanLocation(origin), aiCleanLocation(destination)]);
  console.log(`AI cleaned: "${aiOrig}" → "${aiDest}"`);
  result = await tryDistanceMatrix(aiOrig, aiDest);
  if (result) { result.resolvedOrigin = aiOrig; result.resolvedDest = aiDest; return result; }

  return null;
}

app.post('/miles', async (req, res) => {
  try {
    if (!MAPS_KEY) return res.status(400).json({ error: 'GOOGLE_MAPS_API_KEY not set in Railway Variables' });
    const { origin, destination } = req.body;
    if (!origin || !destination) return res.status(400).json({ error: 'origin and destination required' });

    console.log(`Miles request: "${origin}" → "${destination}"`);
    const result = await calcMilesBetween(origin, destination);

    if (!result) {
      return res.status(400).json({ error: `Could not find route: "${origin}" → "${destination}". Try using City, State format (e.g. "Chicago, IL")` });
    }

    res.json({ ...result, origin, destination });
  } catch(e) {
    console.error('Miles error:', e.message);
    res.status(400).json({ error: e.message });
  }
});

// ─── MULTI-STOP MILES ─────────────────────────────────────
app.post('/miles/route', async (req, res) => {
  try {
    if (!MAPS_KEY) return res.status(400).json({ error: 'GOOGLE_MAPS_API_KEY not set' });
    const { stops } = req.body;
    if (!stops || stops.length < 2) return res.status(400).json({ error: 'Need at least 2 stops' });

    let totalMiles = 0;
    const legs = [];

    for (let i = 0; i < stops.length - 1; i++) {
      const result = await calcMilesBetween(stops[i], stops[i+1]);
      if (result) {
        totalMiles += result.miles;
        legs.push({ from: stops[i], to: stops[i+1], miles: result.miles, driveTime: result.driveTime });
      }
    }

    // Calculate total drive time from total miles (avg 55mph)
    const totalHours = Math.floor(totalMiles / 55);
    const totalMins = Math.round((totalMiles % 55) / 55 * 60);
    res.json({ totalMiles, driveTime: totalHours + 'h ' + totalMins + 'm', legs });
  } catch(e) {
    res.status(400).json({ error: e.message });
  }
});

// ─── SAMSARA GPS ─────────────────────────────────────────
async function samsaraGet(path) {
  const r = await fetch('https://api.samsara.com' + path, {
    headers: { 'Authorization': 'Bearer ' + SAMSARA_KEY, 'Content-Type': 'application/json' }
  });
  if (!r.ok) {
    const err = await r.text();
    throw new Error('Samsara API error ' + r.status + ': ' + err.slice(0,200));
  }
  return r.json();
}

// Get all vehicles with live locations — handles pagination
app.get('/samsara/vehicles', async (req, res) => {
  try {
    if (!SAMSARA_KEY) return res.status(400).json({ error: 'SAMSARA_API_KEY not set in Railway Variables' });

    // Fetch ALL vehicles with pagination
    let allVehicles = [];
    let cursor = null;
    let page = 0;

    do {
      const url = '/fleet/vehicles/locations?limit=512' + (cursor ? '&after=' + cursor : '');
      const data = await samsaraGet(url);
      const batch = data.data || [];
      allVehicles = allVehicles.concat(batch);
      cursor = data.pagination?.endCursor;
      const hasMore = data.pagination?.hasNextPage;
      page++;
      console.log(`Samsara page ${page}: ${batch.length} vehicles (total so far: ${allVehicles.length})`);
      if (!hasMore || page > 20) break; // safety limit
    } while (cursor);

    const result = allVehicles.map(v => {
      const loc = v.location || {};
      const name = (v.name || '').trim();
      const numMatches = name.match(/\d+/g) || [];
      const truckNum = numMatches.sort((a,b) => b.length - a.length)[0] || name;
      const addr = loc.reverseGeo?.formattedLocation || '';
      const { city, state } = parseCityState(addr);

      return {
        id: v.id,
        name: name,
        truckNum: truckNum,
        allNums: numMatches,
        lat: loc.latitude,
        lng: loc.longitude,
        speed: loc.speedMilesPerHour || 0,
        heading: loc.heading || 0,
        address: addr,
        city: city,
        state: state,
        location: city && state ? city + ', ' + state : (city || state || ''),
        updatedAt: loc.time || new Date().toISOString(),
        moving: (loc.speedMilesPerHour || 0) > 2,
      };
    });

    console.log(`Samsara: ${result.length} total vehicles fetched across ${page} pages`);
    res.json({ vehicles: result, count: result.length, pages: page, fetchedAt: new Date().toISOString() });
  } catch(e) {
    console.error('Samsara error:', e.message);
    res.status(400).json({ error: e.message });
  }
});

// Get single vehicle stats (trip history etc)
app.get('/samsara/vehicle/:id', async (req, res) => {
  try {
    if (!SAMSARA_KEY) return res.status(400).json({ error: 'SAMSARA_API_KEY not set' });
    const data = await samsaraGet('/fleet/vehicles/' + req.params.id);
    res.json(data);
  } catch(e) {
    res.status(400).json({ error: e.message });
  }
});

// Debug endpoint — show ALL vehicles and their names for matching
app.get('/samsara/debug', async (req, res) => {
  try {
    if (!SAMSARA_KEY) return res.json({ error: 'SAMSARA_API_KEY not set', keySet: false });

    // Fetch all with pagination
    let all = [];
    let cursor = null;
    let page = 0;
    do {
      const url = '/fleet/vehicles/locations?limit=512' + (cursor ? '&after=' + cursor : '');
      const data = await samsaraGet(url);
      const batch = data.data || [];
      all = all.concat(batch);
      cursor = data.pagination?.endCursor;
      const hasMore = data.pagination?.hasNextPage;
      page++;
      if (!hasMore || page > 20) break;
    } while (cursor);

    res.json({
      connected: true,
      keyPreview: SAMSARA_KEY.slice(0,15) + '...',
      totalVehicles: all.length,
      pages: page,
      vehicles: all.map(v => ({
        id: v.id,
        name: v.name,
        numbersInName: (v.name || '').match(/\d+/g) || [],
        location: v.location?.reverseGeo?.formattedLocation || 'No location',
        speed: v.location?.speedMilesPerHour || 0,
      }))
    });
  } catch(e) {
    res.json({ connected: false, error: e.message });
  }
});

function parseCityState(addr) {
  if (!addr) return { city: '', state: '' };
  let parts = addr.split(',').map(p => p.trim()).filter(Boolean);
  // Remove trailing zip code
  if (parts.length > 0 && /^\d{5}(-\d{4})?$/.test(parts[parts.length-1].split(' ')[0])) {
    parts.pop();
  }
  if (parts.length === 0) return { city: '', state: '' };
  // Last part should now be state (possibly "ST ZIPCODE")
  const lastPart = parts[parts.length - 1];
  const stateMatch = lastPart.match(/^([A-Z]{2})/);
  if (stateMatch) {
    return {
      state: stateMatch[1],
      city: parts.length >= 2 ? parts[parts.length - 2] : ''
    };
  }
  return { city: parts[parts.length - 1], state: '' };
}

function extractCity(addr) { return parseCityState(addr).city; }
function extractState(addr) { return parseCityState(addr).state; }

app.get('/health', (req, res) => res.json({ status: 'ok' }));

// Debug endpoint to test Maps API directly
app.get('/debug-maps', async (req, res) => {
  try {
    if (!MAPS_KEY) return res.json({ error: 'GOOGLE_MAPS_API_KEY not set', vars: Object.keys(process.env).filter(k=>k.includes('GOOGLE')) });
    const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=Chicago,IL&destinations=Atlanta,GA&units=imperial&key=${MAPS_KEY}`;
    const r = await fetch(url);
    const data = await r.json();
    res.json({ 
      keyPreview: MAPS_KEY.slice(0,10) + '...',
      status: data.status,
      errorMessage: data.error_message,
      rows: data.rows,
      originAddresses: data.origin_addresses,
      destinationAddresses: data.destination_addresses,
    });
  } catch(e) {
    res.json({ error: e.message });
  }
});

// Session endpoints
app.post('/session/save', (req, res) => {
  const { username, role } = req.body;
  if (!username) return res.status(400).json({ error: 'No username' });
  serverSessions[username] = { role, ts: Date.now() };
  res.json({ ok: true });
});

app.get('/session/check/:username', (req, res) => {
  const s = serverSessions[req.params.username];
  if (!s) return res.json({ valid: false });
  // 24 hour expiry
  if (Date.now() - s.ts > 24 * 60 * 60 * 1000) {
    delete serverSessions[req.params.username];
    return res.json({ valid: false });
  }
  res.json({ valid: true, role: s.role });
});

app.post('/session/clear/:username', (req, res) => {
  delete serverSessions[req.params.username];
  res.json({ ok: true });
});

app.listen(PORT, () => console.log(`DispatchAI server running on port ${PORT}`));
