#!/usr/bin/env node
// Worktree Janitor sidecar — zero dependencies, Node >= 22.
//
// Discovers the repos your agents work in (agents.list via the hub bus),
// enumerates their git worktrees, and serves the pane UI + a small JSON API:
//   GET  /health         → ok
//   GET  /               → the pane (ui/index.html)
//   GET  /api/worktrees  → [{ repo, worktrees: [...] }]
//   POST /api/prune      → { path, force?, deleteBranch? } — remove a worktree
//
// Safety: only LINKED worktrees the janitor itself enumerated in the last
// scan can be pruned (the primary checkout is excluded by construction),
// dirty ones require force, and branch deletion only happens when merged.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { connect } = require('./wks.js');

const DIR = __dirname;
const manifest = JSON.parse(fs.readFileSync(path.join(DIR, 'plugin.json'), 'utf8'));
const PORT = Number(process.env.PORT || (manifest.server && manifest.server.port) || 9210);

function log(msg) { console.log('[' + manifest.id + '] ' + msg); }

// The workspacer plugin SDK (vendored wks.js): connect to the hub bus (scoped
// token, reconnect loop) and expose call(); this janitor only calls agents.list.
const wks = connect({ source: manifest.id });
wks.onStatus((c) => { if (c) log('bus connected'); });

// ── git plumbing ─────────────────────────────────────────────────────────────
function git(cwd, args) {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', cwd, ...args], { timeout: 15000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => (err ? reject(new Error((stderr || err.message).trim())) : resolve(stdout)));
  });
}
const gitOk = (cwd, args) => git(cwd, args).then((o) => o.trim()).catch(() => null);

async function repoRoot(dir) {
  return gitOk(dir, ['rev-parse', '--show-toplevel']);
}

async function defaultBranch(root) {
  const ref = await gitOk(root, ['symbolic-ref', 'refs/remotes/origin/HEAD']);
  if (ref) return ref.replace('refs/remotes/origin/', '');
  for (const b of ['main', 'master']) {
    if (await gitOk(root, ['rev-parse', '--verify', 'refs/heads/' + b])) return b;
  }
  return null;
}

/** Parse `git worktree list --porcelain`: entries separated by blank lines. */
function parseWorktrees(porcelain) {
  const out = [];
  for (const block of porcelain.split('\n\n')) {
    const wt = {};
    for (const line of block.split('\n')) {
      if (line.startsWith('worktree ')) wt.path = line.slice(9);
      else if (line.startsWith('branch ')) wt.branch = line.slice(7).replace('refs/heads/', '');
      else if (line === 'detached') wt.detached = true;
      else if (line.startsWith('HEAD ')) wt.head = line.slice(5);
      else if (line.startsWith('prunable')) wt.prunable = true;
      else if (line === 'locked') wt.locked = true;
    }
    if (wt.path) out.push(wt);
  }
  return out;
}

// Last full scan — the prune allowlist. path → { root, branch, dirty, merged }
let lastScan = new Map();

async function scan() {
  // Repos = unique git roots of every known agent cwd (live and stopped —
  // stopped agents' worktrees are exactly the ones needing cleanup).
  let agents = [];
  try { agents = (await wks.call('agents.list')) || []; } catch (e) { log('agents.list failed: ' + e.message); }
  const roots = new Set();
  for (const a of agents) {
    const cwd = a && (a.cwd || a.liveCwd);
    if (!cwd) continue;
    const root = await repoRoot(cwd);
    if (root) {
      // A worktree's root IS the worktree — resolve to the main repo via the
      // common dir so all of a repo's worktrees group under one card.
      const common = await gitOk(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
      const mainRoot = common ? path.dirname(common.split('\n')[0]) : root;
      roots.add(mainRoot);
    }
  }

  const result = [];
  const allow = new Map();
  for (const root of [...roots].sort()) {
    const porcelain = await gitOk(root, ['worktree', 'list', '--porcelain']);
    if (!porcelain) continue;
    const all = parseWorktrees(porcelain);
    const primary = all[0]; // git lists the primary first
    const linked = all.slice(1);
    const def = await defaultBranch(root);
    const merged = new Set(
      def
        ? ((await gitOk(root, ['branch', '--merged', def, '--format=%(refname:short)'])) || '')
            .split('\n').map((s) => s.trim()).filter(Boolean)
        : [],
    );
    const worktrees = [];
    for (const wt of linked) {
      const dirty = wt.prunable ? 0
        : ((await gitOk(wt.path, ['status', '--porcelain'])) || '').split('\n').filter(Boolean).length;
      const lastCommit = wt.prunable ? null
        : await gitOk(wt.path, ['log', '-1', '--format=%ct|%s']);
      const [epoch, subject] = (lastCommit || '|').split('|');
      const agentsHere = agents
        .filter((a) => (a.cwd || '') === wt.path || (a.liveCwd || '') === wt.path)
        .map((a) => a.name || a.sessionId || 'agent');
      const rec = {
        path: wt.path,
        branch: wt.detached ? null : wt.branch || null,
        detached: !!wt.detached,
        locked: !!wt.locked,
        prunable: !!wt.prunable,
        dirty,
        merged: !!(wt.branch && merged.has(wt.branch)),
        lastCommitEpoch: epoch ? Number(epoch) : null,
        lastCommitSubject: subject || '',
        agents: agentsHere,
      };
      worktrees.push(rec);
      allow.set(wt.path, { root, branch: rec.branch, dirty, merged: rec.merged });
    }
    result.push({ repo: root, defaultBranch: def, primary: primary ? primary.path : root, worktrees });
  }
  lastScan = allow;
  return result;
}

async function prune(body) {
  const { path: wtPath, force, deleteBranch } = body || {};
  const known = lastScan.get(wtPath);
  if (!known) throw new Error('unknown worktree — rescan first');
  if (known.dirty > 0 && !force) throw new Error('worktree has uncommitted changes — force required');
  const args = ['worktree', 'remove'];
  if (force) args.push('--force');
  args.push(wtPath);
  await git(known.root, args);
  let branchRemoved = false;
  if (deleteBranch && known.branch && known.merged) {
    // -d (not -D): merged-only by construction, and git double-checks.
    await git(known.root, ['branch', '-d', known.branch]).then(() => { branchRemoved = true; })
      .catch((e) => log('branch delete skipped: ' + e.message));
  }
  lastScan.delete(wtPath);
  log('pruned ' + wtPath + (branchRemoved ? ' (+branch ' + known.branch + ')' : ''));
  return { ok: true, branchRemoved };
}

// ── HTTP ─────────────────────────────────────────────────────────────────────
const UI = fs.readFileSync(path.join(DIR, 'ui', 'index.html'));
const server = http.createServer(async (req, res) => {
  const send = (code, body, type) => {
    res.writeHead(code, { 'content-type': type || 'application/json' });
    res.end(type ? body : JSON.stringify(body));
  };
  try {
    if (req.method === 'GET' && req.url === '/health') return send(200, { ok: true });
    if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/?')))
      return send(200, UI, 'text/html; charset=utf-8');
    if (req.method === 'GET' && req.url === '/api/worktrees') return send(200, await scan());
    if (req.method === 'POST' && req.url === '/api/prune') {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', async () => {
        try { send(200, await prune(JSON.parse(raw || '{}'))); }
        catch (e) { send(400, { error: e.message }); }
      });
      return;
    }
    send(404, { error: 'not found' });
  } catch (e) {
    send(500, { error: e.message });
  }
});
server.listen(PORT, '127.0.0.1', () => log('listening on ' + PORT));
