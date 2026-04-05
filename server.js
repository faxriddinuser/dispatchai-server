const express = require('express');
const cors = require('cors');
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));
const path = require('path');
const app = express();

app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.static('public'));

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI || 'https://dispatchai-server-production.up.railway.app/callback';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const PORT = process.env.PORT || 3000;

let tokens = {};

app.get('/auth', (req, res) => {
  const url = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
    client_id: CLIENT_ID, redirect_uri: REDIRECT_URI,
    response_type: 'code', scope: 'https://www.googleapis.com/auth/gmail.readonly',
    access_type: 'offline', prompt: 'consent'
  });
  res.redirect(url);
});

app.get('/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.redirect('/?error=' + error);
  try {
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code, client_id: CLIENT_ID, client_secret: CLIENT_SECRET, redirect_uri: REDIRECT_URI, grant_type: 'authorization_code' })
    });
    tokens = await r.json();
    tokens.expires_at = Date.now() + (tokens.expires_in * 1000);
    res.redirect('/?connected=true');
  } catch(e) { res.redirect('/?error=' + e.message); }
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
    const { q = 'rate confirmation OR rate con has:attachment', maxResults = 25 } = req.query;
    const r = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(q)}&maxResults=${maxResults}`, { headers: { Authorization: 'Bearer ' + t } });
    const data = await r.json();
    if (data.error) return res.status(400).json(data);
    const messages = data.messages || [];
    const details = [];
    for (const msg of messages.slice(0,30)) {
      try {
        const d = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`, { headers: { Authorization: 'Bearer ' + t } });
        const md = await d.json();
        const h = md.payload?.headers || [];
        const parts = md.payload?.parts || [];
        const atts = parts.filter(p => p.filename && p.filename.match(/\.(pdf|doc|docx|png|jpg|jpeg)$/i)).map(p => ({ name: p.filename, id: p.body?.attachmentId, mimeType: p.mimeType, msgId: msg.id }));
        details.push({ id: msg.id, from: h.find(x=>x.name==='From')?.value||'', subject: h.find(x=>x.name==='Subject')?.value||'', date: h.find(x=>x.name==='Date')?.value||'', snippet: md.snippet||'', attachments: atts });
      } catch(e) {}
    }
    res.json({ messages: details });
  } catch(e) { res.status(401).json({ error: e.message }); }
});

app.get('/attachment/:msgId/:attId', async (req, res) => {
  try {
    const t = await getFreshToken();
    const r = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${req.params.msgId}/attachments/${req.params.attId}`, { headers: { Authorization: 'Bearer ' + t } });
    const data = await r.json();
    res.json({ data: data.data });
  } catch(e) { res.status(400).json({ error: e.message }); }
});

app.post('/extract', async (req, res) => {
  try {
    const { b64, mimeType, emailNotes } = req.body;
    const isImg = mimeType?.startsWith('image/');
    const part = isImg ? { type:'image', source:{ type:'base64', media_type:mimeType, data:b64 } } : { type:'document', source:{ type:'base64', media_type:'application/pdf', data:b64 } };
    const EP = `Extract load info from this rate confirmation. Return ONLY valid JSON: {"loadNumber":"string","broker":"string","commodity":null,"equipment":null,"rate":null,"emptyMiles":null,"loadedMiles":null,"totalMiles":null,"weight":null,"stops":[{"stopNumber":1,"type":"PU","company":"string","address":"string","city":"string","state":"string","zip":"string","date":"string","timeWindow":"string","reference":null,"instructions":null}],"specialInstructions":null}`;
    const apiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 1200, system: 'Extract load data from rate confirmations. Return ONLY valid JSON.', messages: [{ role:'user', content:[part,{type:'text',text:EP}] }] })
    });
    const data = await apiRes.json();
    const ld = JSON.parse(data.content[0].text.replace(/```json|```/g,'').trim());
    res.json({ load: { ...ld, emailNotes: emailNotes||'' } });
  } catch(e) { res.status(400).json({ error: e.message }); }
});

app.post('/extract-text', async (req, res) => {
  try {
    const { text, emailNotes } = req.body;
    const EP = `Extract load info. Return ONLY valid JSON: {"loadNumber":"string","broker":"string","commodity":null,"equipment":null,"rate":null,"emptyMiles":null,"loadedMiles":null,"totalMiles":null,"weight":null,"stops":[{"stopNumber":1,"type":"PU","company":"string","address":"string","city":"string","state":"string","zip":"string","date":"string","timeWindow":"string","reference":null,"instructions":null}],"specialInstructions":null}`;
    const apiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 1200, system: 'Extract load data. Return ONLY valid JSON.', messages: [{ role:'user', content: EP+'\n\n'+text }] })
    });
    const data = await apiRes.json();
    const ld = JSON.parse(data.content[0].text.replace(/```json|```/g,'').trim());
    res.json({ load: { ...ld, emailNotes: emailNotes||'' } });
  } catch(e) { res.status(400).json({ error: e.message }); }
});

app.post('/generate-message', async (req, res) => {
  try {
    const { load, driver, notes } = req.body;
    const stops = (load.stops||[]).map((s,i)=>`Stop ${i+1} (${s.type}): ${s.company}, ${s.address}, ${s.city} ${s.state} ${s.zip} — ${s.date} @ ${s.timeWindow}${s.reference?' Ref:'+s.reference:''}${s.instructions?' NOTE:'+s.instructions:''}`).join('\n');
    const prompt = `Generate a driver dispatch text message:\nDriver: ${driver.name}, Truck #${driver.truck}\nLoad #: ${load.loadNumber} | Broker: ${load.broker} | Rate: ${load.rate?'$'+load.rate:'see rate con'}\nMiles: ${load.loadedMiles||'?'} loaded\n\nStops:\n${stops}\n${notes?'Extra: '+notes:''}\n\nFormat:\nHey [First Name]! 🚛\nLoad #: [num] | Broker: [name]\n━━━━━━━━━━━━━━━━━━\n📍 PICKUP\n[Company]\n[Full Address]\n📅 [Date] at [Time]\n━━━━━━━━━━━━━━━━━━\n📍 DELIVERY\n[Company]\n[Full Address]\n📅 [Date]: [Window]\n━━━━━━━━━━━━━━━━━━\n💰 Rate: $[amount] | 📏 [n] mi loaded | 🚛 #[truck]\n\n🔺 Do PTI before departure\n🔺 Send trailer photos to group\n🔺 Scale after pickup\n${notes?'🔺 '+notes:''}\nDrive safe! ✅\n\nReturn ONLY the message.`;
    const apiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 700, system: 'Generate driver dispatch messages. Return only the message text.', messages: [{ role:'user', content: prompt }] })
    });
    const data = await apiRes.json();
    res.json({ message: data.content?.[0]?.text || 'Error generating message' });
  } catch(e) { res.status(400).json({ error: e.message }); }
});

app.listen(PORT, () => console.log(`DispatchAI running on port ${PORT}`));
