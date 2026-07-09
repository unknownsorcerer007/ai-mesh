# AI Mesh — Supabase Deployment Guide

## Option 1: Supabase + Railway (Recommended)

Supabase sirf database ke liye, server Railway pe.

### Step 1: Supabase Setup

1. [supabase.com](https://supabase.com) pe project banao
2. SQL Editor mein ye run karo:

```sql
-- AI Mesh Schema for Supabase (Postgres)

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  hash_id TEXT UNIQUE NOT NULL,
  public_key TEXT NOT NULL,
  github_id TEXT,
  github_username TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  invite_code TEXT UNIQUE NOT NULL,
  admin_id TEXT NOT NULL REFERENCES users(id),
  max_members INTEGER DEFAULT 0,
  group_type TEXT DEFAULT 'team' CHECK(group_type IN ('team', 'project', 'open')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS group_members (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT DEFAULT 'member' CHECK(role IN ('admin', 'member')),
  joined_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(group_id, user_id)
);

CREATE TABLE IF NOT EXISTS join_requests (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'rejected')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(group_id, user_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  sender_id TEXT NOT NULL REFERENCES users(id),
  sender_ai TEXT,
  message_type TEXT DEFAULT 'text' CHECK(message_type IN ('text', 'code', 'alert', 'system')),
  content TEXT NOT NULL,
  metadata JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  delivered_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS pending_messages (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  recipient_id TEXT NOT NULL REFERENCES users(id),
  status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'delivered', 'expired')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_messages_group ON messages(group_id, created_at);
CREATE INDEX IF NOT EXISTS idx_pending_recipient ON pending_messages(recipient_id, status);
CREATE INDEX IF NOT EXISTS idx_pending_expires ON pending_messages(expires_at);
CREATE INDEX IF NOT EXISTS idx_group_members_user ON group_members(user_id);
CREATE INDEX IF NOT EXISTS idx_join_requests_group ON join_requests(group_id, status);

-- Auto-cleanup: delete expired pending messages
CREATE OR REPLACE FUNCTION cleanup_expired_messages()
RETURNS void AS $$
BEGIN
  DELETE FROM pending_messages WHERE expires_at < NOW();
  DELETE FROM messages WHERE delivered_at IS NOT NULL AND delivered_at < NOW() - INTERVAL '1 hour';
END;
$$ LANGUAGE plpgsql;

-- Enable Realtime for messages (for WebSocket subscriptions)
ALTER PUBLICATION supabase_realtime ADD TABLE messages;
ALTER PUBLICATION supabase_realtime ADD TABLE join_requests;
```

3. Settings → API mein ye values copy karo:
   - `Project URL` → `SUPABASE_URL`
   - `anon key` → `SUPABASE_ANON_KEY`
   - `service_role key` → `SUPABASE_SERVICE_KEY`

### Step 2: Railway Deployment

1. [railway.app](https://railway.app) pe project banao
2. GitHub repo connect karo
3. Environment variables set karo:

```env
PORT=3737
NODE_ENV=production
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_KEY=eyJ...
GITHUB_CLIENT_ID=your-github-client-id
GITHUB_CLIENT_SECRET=your-github-client-secret
GITHUB_CALLBACK_URL=https://your-app.railway.app/auth/github/callback
SESSION_SECRET=random-32-char-string
MESSAGE_HOLD_MS=604800000
```

4. Deploy! Railway auto-detects Node.js aur `npm start` chalaata hai.

### Step 3: GitHub OAuth App

1. [github.com/settings/developers](https://github.com/settings/developers)
2. New OAuth App:
   - Application name: `AI Mesh`
   - Homepage URL: `https://your-app.railway.app`
   - Callback URL: `https://your-app.railway.app/auth/github/callback`
3. Client ID aur Secret copy karo

---

## Option 2: Supabase Edge Functions (Advanced)

Agar serverless chahiye to Edge Functions use karo. Lekin:
- WebSocket kaam nahi karega (Edge Functions stateless hain)
- HTTP polling se kaam karna padega
- Code Deno-compatible banana padega

### Edge Function Example:

```typescript
// supabase/functions/mesh/index.ts
import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

serve(async (req) => {
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_KEY')!
  )

  const { method, url } = req
  const path = new URL(url).pathname

  if (method === 'GET' && path === '/health') {
    return new Response(JSON.stringify({ status: 'ok' }), {
      headers: { 'Content-Type': 'application/json' }
    })
  }

  // Add more routes...

  return new Response('Not Found', { status: 404 })
})
```

---

## Option 3: VPS (Cheapest)

Agar ₹500/month VPS milta hai (Hetzner, DigitalOcean):

```bash
# SSH into VPS
git clone <your-repo> && cd ai-mesh
npm install && npm run build

# Install PM2 for process management
npm install -g pm2
pm2 start dist/index.js --name ai-mesh
pm2 save
pm2 startup

# Nginx reverse proxy
apt install nginx
cat > /etc/nginx/sites-available/ai-mesh << 'EOF'
server {
    listen 80;
    server_name your-domain.com;
    
    location / {
        proxy_pass http://127.0.0.1:3737;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
    }
}
EOF
ln -s /etc/nginx/sites-available/ai-mesh /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
```

---

## Live Testing

Deploy ke baad:

```bash
# 1. Health check
curl https://your-app.railway.app/health

# 2. Open in browser (GitHub OAuth)
open https://your-app.railway.app/auth/github

# 3. Connect MCP (in OpenClaw)
openclaw mcp set ai-mesh '{"url":"https://your-app.railway.app/mcp","transport":"streamable-http"}'

# 4. Test WebSocket
wscat -c "wss://your-app.railway.app/ws?token=YOUR_TOKEN"
```
