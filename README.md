# DispatchAI Gmail Server

Backend server that connects DispatchAI to your Gmail inbox.

## Deploy to Railway (Free)

### Step 1 — Upload to GitHub
1. Go to github.com → New repository → name it `dispatchai-server`
2. Upload all these files (server.js, package.json, railway.json, .gitignore)

### Step 2 — Deploy on Railway
1. Go to railway.app → Login with GitHub
2. Click "New Project" → "Deploy from GitHub repo"
3. Select your `dispatchai-server` repo
4. Railway will auto-detect and deploy it

### Step 3 — Set Environment Variables in Railway
In your Railway project → Variables tab, add these:

| Variable | Value |
|----------|-------|
| GOOGLE_CLIENT_ID | your_client_id.apps.googleusercontent.com |
| GOOGLE_CLIENT_SECRET | your_client_secret |
| REDIRECT_URI | https://YOUR-APP-NAME.railway.app/callback |

### Step 4 — Update Google Cloud Console
Add your Railway URL to authorized redirect URIs:
- Go to Google Cloud Console → Clients → DispatchAI Web
- Add: `https://YOUR-APP-NAME.railway.app/callback`
- Save

### Step 5 — Connect Gmail
1. Visit `https://YOUR-APP-NAME.railway.app`
2. Click "Connect Gmail"
3. Sign in with your Google account
4. Copy your Railway server URL
5. Paste it into the DispatchAI widget

## API Endpoints

- `GET /` — Home page with connection status
- `GET /auth` — Start Gmail OAuth flow
- `GET /callback` — OAuth callback (auto-handled)
- `GET /status` — Check if Gmail is connected
- `GET /emails?q=rate+confirmation&maxResults=25` — Fetch emails
- `GET /attachment/:msgId/:attId` — Download attachment
