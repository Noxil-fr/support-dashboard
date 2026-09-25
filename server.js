const express = require('express');
const axios   = require('axios');
const cors    = require('cors');
const path    = require('path');
const https   = require('https');
const fs      = require('fs');

const app        = express();
const PORT       = process.env.PORT || 3000;
const agent      = new https.Agent({ rejectUnauthorized: false });
const CONFIG_FILE = path.join(__dirname, 'config.json');

function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); }
  catch { return {}; }
}

function writeConfig(data) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2), 'utf8');
}

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Config ────────────────────────────────────────────────────────────────────
app.get('/api/config', (req, res) => {
  const file = readConfig();
  res.json({
    jira_domain:   process.env.JIRA_DOMAIN    || file.jira_domain  || '',
    jira_email:    process.env.JIRA_EMAIL     || file.jira_email   || '',
    jira_token:    process.env.JIRA_TOKEN     || file.jira_token   || '',
    jira_project:  process.env.JIRA_PROJECT   || file.jira_project || '',
    has_pin:       !!process.env.DASHBOARD_PIN,
  });
});

app.post('/api/config', (req, res) => {
  writeConfig(req.body);
  res.json({ ok: true });
});

app.post('/api/verify-pin', (req, res) => {
  const expected = process.env.DASHBOARD_PIN || '';
  if (!expected) return res.json({ ok: true });
  res.json({ ok: req.body.pin === expected });
});

const REPORTERS = [
  '62de9675831f463d28e858e5',
  '62de96759974783acc34b8bb',
  '61fa62fbf5f5b80070c782b7',
  '61f2611125edab006a2275fb',
  '6347a867188e713215502582',
  '62de96789e39d087ee5be8b9',
  '62de96799974783acc34b8bf',
  '712020:e87e8ac7-e08a-4904-b70b-5af3eb773c48',
  '712020:c9f7bfb1-1073-4069-baa2-de5b210b3108',
  '62e2375dbc2c449f3d946db2',
  '63ce4a13d73cd1e44e214942',
  '712020:64032dae-b609-4479-9505-f03cd5cd1c59',
  '712020:3e737f29-0bc6-431c-a821-9d4728579348'
];

const jqlStr  = s => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const jqlList = arr => arr.map(jqlStr).join(',');

// Jira's JQL search endpoint unreliably matches `status = "Name"` by display name
// (returns 0 results for some accented/duplicated status names), so we resolve
// names to their numeric status IDs first and filter by ID instead.
const statusCache = new Map(); // domain -> { data: [{id,name}], ts }
const STATUS_CACHE_TTL = 10 * 60 * 1000;

async function resolveStatusIds(domain, auth, headers, names) {
  let cached = statusCache.get(domain);
  if (!cached || Date.now() - cached.ts > STATUS_CACHE_TTL) {
    const r = await axios.get(`https://${domain}/rest/api/3/status`, { auth, headers, httpsAgent: agent });
    cached = { data: r.data.map(s => ({ id: s.id, name: s.name })), ts: Date.now() };
    statusCache.set(domain, cached);
  }
  const ids = [];
  names.forEach(name => {
    cached.data.filter(s => s.name === name).forEach(s => { if (!ids.includes(s.id)) ids.push(s.id); });
  });
  return ids;
}

// ── Jira ──────────────────────────────────────────────────────────────────────
app.get('/api/bugs', async (req, res) => {
  const {
    domain, email, token, project, period, date_from, date_to, all_reporters,
    statuses, assignee_names, reporter_names, versions, fixversions
  } = req.query;

  if (!domain || !email || !token) {
    return res.status(400).json({ error: 'Paramètres manquants : domain, email, token.' });
  }

  const auth    = { username: email, password: token };
  const headers = { 'Accept': 'application/json', 'Content-Type': 'application/json' };

  try {
    const conditions = ['issuetype = Bug'];
    if (reporter_names) {
      conditions.push(`reporter IN (${jqlList(reporter_names.split(','))})`);
    } else if (all_reporters !== 'true') {
      conditions.push(`reporter IN (${REPORTERS.join(',')})`);
    }
    if (assignee_names) conditions.push(`assignee IN (${jqlList(assignee_names.split(','))})`);
    if (statuses) {
      const ids = await resolveStatusIds(domain, auth, headers, statuses.split(','));
      if (ids.length) conditions.push(`status IN (${ids.join(',')})`);
    }
    if (versions)     conditions.push(`affectedVersion IN (${jqlList(versions.split(','))})`);
    if (fixversions)  conditions.push(`fixVersion IN (${jqlList(fixversions.split(','))})`);
    if (project) conditions.push(`project = "${project}"`);
    if (date_from) {
      conditions.push(`created >= "${date_from}"`);
      if (date_to) conditions.push(`created <= "${date_to}"`);
    } else if (period) {
      const since = new Date(Date.now() - Number(period) * 24 * 60 * 60 * 1000);
      const pad = n => String(n).padStart(2, '0');
      const dateStr = `${since.getFullYear()}-${pad(since.getMonth()+1)}-${pad(since.getDate())} ${pad(since.getHours())}:${pad(since.getMinutes())}`;
      conditions.push(`created >= "${dateStr}"`);
    }
    const jql = conditions.join(' AND ') + ' ORDER BY created DESC';
    console.log('JQL:', jql);

    const url = `https://${domain}/rest/api/3/search/jql`;
    const { next_page_token } = req.query;
    const body = { jql, maxResults: 100, fields: ['summary', 'priority', 'status', 'reporter', 'assignee', 'created', 'customfield_10136', 'versions', 'fixVersions'] };
    if (next_page_token) body.nextPageToken = next_page_token;

    const response = await axios.post(url, body, { auth, headers, httpsAgent: agent });

    const issues        = response.data.issues ?? [];
    const nextPageToken = response.data.nextPageToken ?? null;
    console.log(`Jira – page chargée : ${issues.length} tickets${nextPageToken ? ', suite disponible' : ', fin'}`);
    res.json({ issues, nextPageToken, total: response.data.total ?? issues.length });
  } catch (err) {
    const status = err.response?.status || 500;
    console.error('Jira error:', status, JSON.stringify(err.response?.data));
    const message = err.response?.data?.errorMessages?.[0] || err.response?.data?.message || err.message;
    res.status(status).json({ error: message, detail: err.response?.data });
  }
});

// ── Zendesk ───────────────────────────────────────────────────────────────────
app.get('/api/zendesk', async (req, res) => {
  const { domain, email, token, period } = req.query;

  if (!domain || !email || !token) {
    return res.status(400).json({ error: 'Paramètres manquants : domain, email, token.' });
  }

  // Auth Zendesk : email/token comme identifiant
  const auth = { username: `${email}/token`, password: token };

  let query = 'type:ticket status:closed';
  if (period) {
    const since = new Date(Date.now() - Number(period) * 24 * 60 * 60 * 1000);
    query += ` solved>=${since.toISOString().slice(0, 10)}`;
  }
  console.log('Zendesk query:', query);

  try {
    // 1. Récupérer tous les tickets (pagination par curseur)
    const allTickets = [];
    let nextUrl = `https://${domain}/api/v2/search.json`;
    let firstCall = true;

    while (nextUrl && allTickets.length < 500) {
      const params = firstCall ? { query, 'page[size]': 100 } : undefined;
      const response = await axios.get(firstCall ? nextUrl : nextUrl, {
        params: firstCall ? { query, 'page[size]': 100 } : undefined,
        auth,
        headers: { 'Accept': 'application/json' },
        httpsAgent: agent
      });

      const results = response.data.results || [];
      allTickets.push(...results);
      nextUrl   = response.data.next_page || null;
      firstCall = false;

      if (!results.length) break;
    }

    console.log(`Zendesk – tickets récupérés : ${allTickets.length}`);

    // 2. Récupérer les noms des assignés (batch de 100)
    const assigneeIds = [...new Set(allTickets.map(t => t.assignee_id).filter(Boolean))];
    const userMap = {};

    for (let i = 0; i < assigneeIds.length; i += 100) {
      const batch = assigneeIds.slice(i, i + 100);
      const usersRes = await axios.get(`https://${domain}/api/v2/users/show_many.json`, {
        params: { ids: batch.join(',') },
        auth,
        headers: { 'Accept': 'application/json' },
        httpsAgent: agent
      });
      (usersRes.data.users || []).forEach(u => { userMap[u.id] = u.name; });
    }

    // 3. Compter par technicien
    const counts = {};
    allTickets.forEach(t => {
      const name = userMap[t.assignee_id] || 'Non assigné';
      counts[name] = (counts[name] || 0) + 1;
    });

    const technicians = Object.entries(counts)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);

    res.json({ technicians, total: allTickets.length });
  } catch (err) {
    const status = err.response?.status || 500;
    console.error('Zendesk error:', status, JSON.stringify(err.response?.data));
    const message = err.response?.data?.error || err.response?.data?.description || err.message;
    res.status(status).json({ error: message });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Serveur lancé sur http://localhost:${PORT}`);
});
