const express = require('express');
const cors = require('cors');
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));
const app = express();

app.use(cors({ origin: '*', methods: ['GET','POST','OPTIONS'], allowedHeaders: ['Content-Type','Authorization'] }));
app.use(express.json());

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI || 'https://your-app.railway.app/callback';
const PORT = process.env.PORT || 3000;

let tokens = {};

// ─── AUTH ───────────────────────────────────────────────
app.get('/auth', (req, res) => {
  const url = `https://accounts.google.com/o/oauth2/v2/auth?` +
    new URLSearchParams({
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      response_type: 'code',
      scope: 'https://www.googleapis.com/auth/gmail.readonly',
      access_type: 'offline',
      prompt: 'consent'
    });
  res.redirect(url);
});

app.get('/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.send(`<h2>Auth failed: ${error}</h2>`);
  try {
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code, client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
        redirect_uri: REDIRECT_URI, grant_type: 'authorization_code'
      })
    });
    tokens = await r.json();
    tokens.expires_at = Date.now() + (tokens.expires_in * 1000);
    res.send(`
      <html><body style="font-family:sans-serif;background:#1a1f2e;color:#f0f2f8;padding:40px;text-align:center;">
        <h1 style="color:#4ade80;">✅ Gmail Connected!</h1>
        <p style="color:#9ca3af;">You can close this tab and go back to DispatchAI.</p>
        <script>window.opener && window.opener.postMessage({type:'gmail_connected'},'*'); setTimeout(()=>window.close(),2000);</script>
      </body></html>
    `);
  } catch(e) {
    res.send(`<h2 style="color:red;">Error: ${e.message}</h2>`);
  }
});

// ─── REFRESH TOKEN ──────────────────────────────────────
async function ensureFreshToken() {
  if (!tokens.access_token) throw new Error('Not authenticated — visit /auth first');
  if (Date.now() < tokens.expires_at - 60000) return tokens.access_token;
  if (!tokens.refresh_token) throw new Error('No refresh token — visit /auth again');
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
      refresh_token: tokens.refresh_token, grant_type: 'refresh_token'
    })
  });
  const data = await r.json();
  tokens.access_token = data.access_token;
  tokens.expires_at = Date.now() + (data.expires_in * 1000);
  return tokens.access_token;
}

// ─── STATUS ─────────────────────────────────────────────
app.get('/status', async (req, res) => {
  try {
    const t = await ensureFreshToken();
    res.json({ connected: true, expires_at: tokens.expires_at });
  } catch(e) {
    res.json({ connected: false, message: e.message });
  }
});

// ─── EMAILS ─────────────────────────────────────────────
app.get('/emails', async (req, res) => {
  try {
    const t = await ensureFreshToken();
    const { q = 'rate confirmation OR rate con has:attachment', maxResults = 25 } = req.query;
    const r = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(q)}&maxResults=${maxResults}`,
      { headers: { Authorization: 'Bearer ' + t } }
    );
    const data = await r.json();
    if (data.error) return res.status(400).json(data);

    const messages = data.messages || [];
    const details = [];
    for (const msg of messages.slice(0, 30)) {
      try {
        const d = await fetch(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
          { headers: { Authorization: 'Bearer ' + t } }
        );
        const md = await d.json();
        const headers = md.payload?.headers || [];
        const parts = md.payload?.parts || [];
        const atts = parts
          .filter(p => p.filename && p.filename.match(/\.(pdf|doc|docx|png|jpg|jpeg)$/i))
          .map(p => ({ name: p.filename, id: p.body?.attachmentId, mimeType: p.mimeType, msgId: msg.id }));
        details.push({
          id: msg.id,
          from: headers.find(h=>h.name==='From')?.value || '',
          subject: headers.find(h=>h.name==='Subject')?.value || '',
          date: headers.find(h=>h.name==='Date')?.value || '',
          snippet: md.snippet || '',
          attachments: atts
        });
      } catch(e) {}
    }
    res.json({ messages: details });
  } catch(e) {
    res.status(401).json({ error: e.message });
  }
});

// ─── ATTACHMENT ──────────────────────────────────────────
app.get('/attachment/:msgId/:attId', async (req, res) => {
  try {
    const t = await ensureFreshToken();
    const { msgId, attId } = req.params;
    const r = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msgId}/attachments/${attId}`,
      { headers: { Authorization: 'Bearer ' + t } }
    );
    const data = await r.json();
    res.json({ data: data.data });
  } catch(e) {
    res.status(400).json({ error: e.message });
  }
});

// ─── HOME ────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.send(`
    <html><body style="font-family:sans-serif;background:#1a1f2e;color:#f0f2f8;padding:40px;max-width:600px;margin:0 auto;">
      <h1 style="color:#f4a935;">DispatchAI Gmail Server</h1>
      <p style="color:#9ca3af;">Status: <span style="color:#4ade80;">Running</span></p>
      <hr style="border-color:#374151;margin:20px 0;">
      <h3>Setup Steps:</h3>
      <ol style="color:#d1d5db;line-height:2;">
        <li>Click <a href="/auth" style="color:#f4a935;">Connect Gmail</a> to authorize</li>
        <li>Check <a href="/status" style="color:#f4a935;">/status</a> to verify connection</li>
        <li>Copy this server URL into the DispatchAI widget</li>
      </ol>
      <a href="/auth" style="display:inline-block;background:#f4a935;color:#111;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700;margin-top:16px;">Connect Gmail →</a>
    </body></html>
  `);
});

app.listen(PORT, () => console.log(`DispatchAI server running on port ${PORT}`));
