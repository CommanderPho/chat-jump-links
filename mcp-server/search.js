'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const DEFAULT_MAX_RESULTS = 5;
const MAX_RESULTS_CAP = 20;
const SEARCH_TIMEOUT_MS = 2500;
const MAX_FILESIZE_BYTES = 2 * 1024 * 1024;
const MAX_FALLBACK_FILES = 8000;
const MAX_RG_CANDIDATES = 80;
const MAX_SNIPPET_LINES = 8;
const MAX_LINE_CHARS = 400;

const IGNORE_DIR_NAMES = new Set([
  '.git',
  '.hg',
  '.svn',
  '.cursor',
  '.venv',
  'venv',
  'node_modules',
  'dist',
  'build',
  'out',
  '__pycache__',
  '.mypy_cache',
  '.pytest_cache',
  '.tox',
  '.idea',
  '.vscode',
  'coverage',
  'target',
]);

const TEXT_EXTENSIONS = new Set([
  '.py', '.pyi', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.rs', '.go', '.java', '.kt', '.kts', '.c', '.h', '.cc', '.cpp', '.hpp',
  '.cs', '.rb', '.php', '.swift', '.md', '.json', '.toml', '.yml', '.yaml',
  '.vue', '.svelte', '.css', '.scss', '.html', '.htm', '.txt', '.sh', '.ps1',
  '.sql', '.r', '.jl', '.lua', '.zig', '.scala', '.groovy', '.xml', '.ini',
  '.cfg', '.ipynb', '.dockerfile',
]);

const ELLIPSIS_LINE = /^\s*(?:\/\/|#|--|\/\*)?\s*\.{3}(?:\s*existing code\s*\.{3})?\s*(?:\*\/)?\s*$/i;


function asArray(value) {
  if (value == null || value === '') return [];
  return Array.isArray(value) ? value : [value];
}


function toPosix(p) {
  return String(p || '').split(path.sep).join('/');
}


function normalizeSnippet(text) {
  const raw = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = raw.split('\n')
    .map((line) => line.replace(/\t/g, '    '))
    .filter((line) => !ELLIPSIS_LINE.test(line))
    .map((line) => (line.length > MAX_LINE_CHARS ? line.slice(0, MAX_LINE_CHARS) : line));
  while (lines.length && lines[0].trim() === '') lines.shift();
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  return lines.slice(0, MAX_SNIPPET_LINES);
}


function inferGlob(snippetLines) {
  const blob = snippetLines.join('\n');
  if (/\b(def|async def|classmethod|dataclass|import |from )\b/.test(blob) || blob.includes('self')) return '*.py';
  if (/\b(fn |pub |impl |mod |trait |struct )\b/.test(blob)) return '*.rs';
  if (/\b(package |func |:=)\b/.test(blob)) return '*.go';
  if (/\b(func |extension |struct |let |var |guard )\b/.test(blob) && blob.includes(':')) return '*.swift';
  if (/\b(public class|public interface|System\.)\b/.test(blob)) return '*.{java,kt,cs}';
  if (/\b(function|const |let |interface |type |export |=>)\b/.test(blob)) return '*.{ts,tsx,js,jsx}';
  return '';
}


function extractSymbol(snippetLines, explicit) {
  if (explicit && String(explicit).trim()) return String(explicit).trim();
  const blob = snippetLines.join('\n');
  const patterns = [
    /\b(?:async\s+def|def|class)\s+([A-Za-z_][A-Za-z0-9_]*)/,
    /\b(?:function|class|interface|type|enum|const|let|var)\s+([A-Za-z_][A-Za-z0-9_]*)/,
    /\b(?:fn|struct|impl|mod|trait)\s+([A-Za-z_][A-Za-z0-9_]*)/,
  ];
  for (const re of patterns) {
    const m = blob.match(re);
    if (m) return m[1];
  }
  return '';
}


function parseGlobToExts(glob) {
  if (!glob) return null;
  const m = String(glob).match(/\.\{([^}]+)\}/);
  if (m) return m[1].split(',').map((s) => '.' + s.trim().replace(/^\./, ''));
  const star = String(glob).match(/\*(\.[A-Za-z0-9]+)$/);
  if (star) return [star[1]];
  return null;
}


function isIgnoredDirName(name) {
  return IGNORE_DIR_NAMES.has(name);
}


function isAbsDir(p) {
  try {
    if (!p || !path.isAbsolute(p)) return false;
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}


function uniqueStrings(items) {
  const out = [];
  const seen = new Set();
  for (const item of items) {
    const key = path.resolve(String(item));
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}


function fileUriToPath(uri) {
  if (!uri || typeof uri !== 'string') return null;
  if (!uri.startsWith('file:')) return uri;
  let parsed;
  try {
    parsed = new URL(uri);
  } catch {
    return null;
  }
  let p = decodeURIComponent(parsed.pathname || '');
  if (os.platform() === 'win32' && /^\/[A-Za-z]:/.test(p)) p = p.slice(1);
  return p;
}


function resolveWorkspaceRoots({ workspaceRoots, mcpRoots, pluginRoot }) {
  const fromArgs = asArray(workspaceRoots).map(String).filter(isAbsDir);
  if (fromArgs.length) return uniqueStrings(fromArgs);
  if (workspaceRoots != null && asArray(workspaceRoots).length > 0) return [];

  const fromMcp = asArray(mcpRoots)
    .map((entry) => (typeof entry === 'string' ? entry : entry && entry.uri))
    .map(fileUriToPath)
    .filter(isAbsDir);
  if (fromMcp.length) return uniqueStrings(fromMcp);

  const envCandidates = [
    process.env.CURSOR_WORKSPACE,
    process.env.CURSOR_PROJECT_DIR,
    process.env.VSCODE_CWD,
    process.env.PWD,
  ].filter(Boolean);
  const fromEnv = envCandidates.filter((p) => {
    if (!isAbsDir(p)) return false;
    if (pluginRoot && path.resolve(p) === path.resolve(pluginRoot)) return false;
    return true;
  });
  if (fromEnv.length) return uniqueStrings(fromEnv);

  const cwd = process.cwd();
  if (pluginRoot && path.resolve(cwd) === path.resolve(pluginRoot)) return [];
  if (isAbsDir(cwd)) return [path.resolve(cwd)];
  return [];
}


function toCitationPath(absPath, root, collidingRel) {
  const rel = path.relative(root, absPath);
  const posixRel = toPosix(rel);
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
    if (collidingRel && collidingRel.has(posixRel)) {
      return `${path.basename(root)}/${posixRel}`;
    }
    return posixRel;
  }
  return toPosix(absPath);
}


function scoreMatch({ exact, fuzzy, uniqueFile, hintPathHit, hintSymbolHit, testPath }) {
  let score = exact ? 1.0 : (fuzzy ? 0.85 : 0.6);
  if (uniqueFile) score += 0.1;
  if (hintPathHit) score += 0.1;
  if (hintSymbolHit) score += 0.05;
  if (testPath) score -= 0.05;
  if (score > 1) score = 1;
  if (score < 0) score = 0;
  return Math.round(score * 100) / 100;
}


function isTestPath(relPath) {
  const p = toPosix(relPath).toLowerCase();
  return /(^|\/)(tests?|__tests__|spec)(\/|$)/.test(p) || /\.(spec|test)\.[^.]+$/.test(p);
}


function hintPathHit(absPath, relPath, hintPath) {
  if (!hintPath) return false;
  const hint = toPosix(hintPath).toLowerCase();
  const abs = toPosix(absPath).toLowerCase();
  const rel = toPosix(relPath).toLowerCase();
  const base = path.basename(hintPath).toLowerCase();
  return abs.includes(hint) || rel.includes(hint) || rel.endsWith(base) || abs.endsWith(base);
}


function confirmMultiline(absPath, startLine, snippetLines) {
  let content;
  try {
    const stat = fs.statSync(absPath);
    if (stat.size > MAX_FILESIZE_BYTES) return null;
    content = fs.readFileSync(absPath, 'utf8');
  } catch {
    return null;
  }
  if (content.includes('\0')) return null;
  const fileLines = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const idx = startLine - 1;
  if (idx < 0 || idx >= fileLines.length) return null;

  let exact = true;
  let matched = 0;
  for (let i = 0; i < snippetLines.length; i += 1) {
    const want = snippetLines[i];
    const got = fileLines[idx + i];
    if (got == null) break;
    if (got === want) {
      matched += 1;
      continue;
    }
    if (got.trim() === want.trim()) {
      matched += 1;
      exact = false;
      continue;
    }
    break;
  }
  if (matched < 1) return null;
  const body = fileLines.slice(idx, idx + matched).join('\n');
  return { matched, exact, fuzzy: !exact && matched === snippetLines.length, body, endLine: startLine + matched - 1 };
}


function findRgBinary() {
  const bundled = process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'Programs', 'cursor', 'resources', 'app', 'node_modules', '@vscode', 'ripgrep', 'bin', process.platform === 'win32' ? 'rg.exe' : 'rg')
    : null;
  const candidates = [
    process.env.RIPGREP_PATH,
    process.platform === 'win32' ? 'rg.exe' : 'rg',
    'rg',
    bundled,
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      if (candidate.includes(path.sep) || candidate.includes('/')) {
        if (fs.existsSync(candidate)) return candidate;
      } else {
        return candidate;
      }
    } catch {
      continue;
    }
  }
  return 'rg';
}


function runRg(rgBin, root, needle, glob) {
  return new Promise((resolve) => {
    const args = [
      '--json',
      '--fixed-strings',
      '--no-heading',
      '--max-filesize', '2M',
      '--glob', '!**/node_modules/**',
      '--glob', '!**/.git/**',
      '--glob', '!**/dist/**',
      '--glob', '!**/build/**',
      '--glob', '!**/__pycache__/**',
      '--glob', '!**/.venv/**',
      '--glob', '!**/venv/**',
      '--glob', '!**/.cursor/**',
      '--glob', '!**/*.min.js',
      '--glob', '!**/*.map',
    ];
    if (glob) args.push('--glob', glob);
    args.push('--', needle, '.');

    const child = spawn(rgBin, args, {
      cwd: root,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let settled = false;
    const finish = (hits, error) => {
      if (settled) return;
      settled = true;
      resolve({ hits, error });
    };

    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      finish(parseRgJson(stdout, root), 'timeout');
    }, SEARCH_TIMEOUT_MS);

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.on('error', (err) => {
      clearTimeout(timer);
      finish([], err.code === 'ENOENT' ? 'rg-missing' : String(err.message || err));
    });
    child.on('close', () => {
      clearTimeout(timer);
      finish(parseRgJson(stdout, root), null);
    });
  });
}


function parseRgJson(stdout, root) {
  const hits = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.type !== 'match' || !msg.data) continue;
    const rel = (msg.data.path && (msg.data.path.text || msg.data.path)) || '';
    const lineNumber = msg.data.line_number;
    if (!rel || !lineNumber) continue;
    const absPath = path.isAbsolute(rel) ? rel : path.resolve(root, rel);
    hits.push({ absPath, startLine: lineNumber, root });
    if (hits.length >= MAX_RG_CANDIDATES) break;
  }
  return hits;
}


function walkFallback(root, needle, glob, deadline) {
  const hits = [];
  const exts = parseGlobToExts(glob);
  let scanned = 0;

  const stack = [root];
  while (stack.length && Date.now() < deadline && scanned < MAX_FALLBACK_FILES && hits.length < MAX_RG_CANDIDATES) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (Date.now() >= deadline || scanned >= MAX_FALLBACK_FILES || hits.length >= MAX_RG_CANDIDATES) break;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!isIgnoredDirName(entry.name) && !entry.name.startsWith('.')) stack.push(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (exts) {
        if (!exts.includes(ext)) continue;
      } else if (ext && !TEXT_EXTENSIONS.has(ext)) {
        continue;
      }
      scanned += 1;
      let content;
      try {
        const stat = fs.statSync(abs);
        if (stat.size > MAX_FILESIZE_BYTES) continue;
        content = fs.readFileSync(abs, 'utf8');
      } catch {
        continue;
      }
      if (content.includes('\0')) continue;
      const lines = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
      for (let i = 0; i < lines.length; i += 1) {
        if (lines[i].includes(needle) || lines[i].trim() === needle.trim()) {
          hits.push({ absPath: abs, startLine: i + 1, root });
          if (hits.length >= MAX_RG_CANDIDATES) break;
        }
      }
    }
  }
  return { hits, scanned };
}


async function collectHits(roots, needle, glob) {
  const rgBin = findRgBinary();
  let engine = 'rg';
  let partial = false;
  let filesScannedNote = 'rg';
  const all = [];

  for (const root of roots) {
    const rgResult = await runRg(rgBin, root, needle, glob);
    if (rgResult.error === 'rg-missing') {
      engine = 'walk';
      break;
    }
    if (rgResult.error === 'timeout') partial = true;
    all.push(...rgResult.hits);
  }

  if (engine === 'walk') {
    const deadline = Date.now() + SEARCH_TIMEOUT_MS;
    let scanned = 0;
    for (const root of roots) {
      const walked = walkFallback(root, needle, glob, deadline);
      scanned += walked.scanned;
      all.push(...walked.hits);
    }
    filesScannedNote = `walk (${scanned} files)`;
    if (Date.now() >= deadline) partial = true;
  }

  return { hits: all, engine, partial, filesScannedNote };
}


function rankHits(hits, snippetLines, hintPath, hintSymbol) {
  const byFile = new Map();
  for (const hit of hits) {
    const key = path.resolve(hit.absPath);
    if (!byFile.has(key)) byFile.set(key, []);
    byFile.get(key).push(hit);
  }
  const uniqueFile = byFile.size === 1;

  const relCounts = new Map();
  for (const hit of hits) {
    const rel = toPosix(path.relative(hit.root, hit.absPath));
    relCounts.set(rel, (relCounts.get(rel) || 0) + 1);
  }
  const collidingRel = new Set([...relCounts.entries()].filter(([, n]) => n > 1).map(([rel]) => rel));

  const ranked = [];
  const seenRanges = new Set();
  for (const hit of hits) {
    const confirmed = confirmMultiline(hit.absPath, hit.startLine, snippetLines);
    if (!confirmed) continue;
    const rel = toPosix(path.relative(hit.root, hit.absPath));
    const key = `${path.resolve(hit.absPath)}:${confirmed.endLine}:${hit.startLine}`;
    if (seenRanges.has(key)) continue;
    seenRanges.add(key);
    const filepath = toCitationPath(hit.absPath, hit.root, collidingRel);
    const symbolHit = hintSymbol && confirmed.body.includes(hintSymbol);
    const score = scoreMatch({
      exact: confirmed.exact && confirmed.matched === snippetLines.length,
      fuzzy: confirmed.fuzzy,
      uniqueFile,
      hintPathHit: hintPathHit(hit.absPath, rel, hintPath),
      hintSymbolHit: Boolean(symbolHit),
      testPath: isTestPath(rel),
    });
    ranked.push({
      filepath,
      startLine: hit.startLine,
      endLine: confirmed.endLine,
      score,
      reason: confirmed.exact && confirmed.matched === snippetLines.length
        ? (uniqueFile ? 'exact unique match' : 'exact match')
        : (confirmed.fuzzy ? 'whitespace-tolerant match' : 'partial first-line match'),
      citation_fence_header: `${hit.startLine}:${confirmed.endLine}:${filepath}`,
      body: confirmed.body,
      workspace_root: hit.root,
      absolute_path: hit.absPath,
    });
  }

  ranked.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.filepath < b.filepath) return -1;
    if (a.filepath > b.filepath) return 1;
    return a.startLine - b.startLine;
  });
  return ranked;
}


function formatCitationText(result) {
  const preview = (result.query && result.query.snippet_preview) || '';
  if (!result.best) {
    return [
      'No workspace match for this snippet. Do not invent a citation fence.',
      preview ? `Query preview: ${preview}` : '',
      result.partial ? 'Search timed out (partial).' : '',
    ].filter(Boolean).join('\n');
  }

  const fence = '```' + result.best.citation_fence_header + '\n' + result.best.body + '\n```';
  const lines = [
    'Use this citation (do not change the header). Clicking it jumps to the file and highlights the range.',
    '',
    `Jump to code: ${result.best.filepath}:${result.best.startLine}-${result.best.endLine}`,
    '',
    fence,
    '',
    `unique: ${result.unique}`,
    `score: ${result.best.score}`,
    `reason: ${result.best.reason}`,
  ];
  if (!result.unique && result.matches.length > 1) {
    lines.push('', 'Other candidates:');
    for (const match of result.matches.slice(1)) {
      lines.push(`- ${match.filepath}:${match.startLine}-${match.endLine} (score ${match.score})`);
    }
  }
  if (result.partial) lines.push('', 'Search timed out; results may be partial.');
  return lines.join('\n');
}


async function searchWorkspace(options) {
  const snippetLines = normalizeSnippet(options.snippet);
  const maxResults = Math.min(Math.max(Number(options.max_results) || DEFAULT_MAX_RESULTS, 1), MAX_RESULTS_CAP);
  const pluginRoot = options.pluginRoot || process.env.CHAT_JUMP_LINKS_PLUGIN_ROOT || '';
  const roots = resolveWorkspaceRoots({
    workspaceRoots: options.workspace_roots,
    mcpRoots: options.mcpRoots,
    pluginRoot,
  });

  if (!snippetLines.length || !snippetLines[0].trim()) {
    return {
      unique: false,
      best: null,
      matches: [],
      query: { snippet_preview: '', files_scanned_note: 'empty snippet' },
      error: 'snippet is empty after normalizing ellipsis placeholders',
    };
  }

  if (!roots.length) {
    return {
      unique: false,
      best: null,
      matches: [],
      query: { snippet_preview: snippetLines[0].trim().slice(0, 120), files_scanned_note: 'no workspace roots' },
      error: 'No workspace roots. Pass workspace_roots as absolute folder paths from this session.',
    };
  }

  const glob = options.glob || inferGlob(snippetLines);
  const hintSymbol = extractSymbol(snippetLines, options.hint_symbol);
  const needle = snippetLines[0].trim() ? snippetLines[0] : snippetLines[0];
  const { hits, engine, partial, filesScannedNote } = await collectHits(roots, needle, glob);
  const ranked = rankHits(hits, snippetLines, options.hint_path || '', hintSymbol).slice(0, maxResults);
  const best = ranked[0] || null;
  const unique = Boolean(best) && ranked.filter((m) => m.score >= (best.score - 0.05)).length === 1;

  return {
    unique,
    best,
    matches: ranked,
    partial,
    query: {
      snippet_preview: snippetLines[0].trim().slice(0, 120),
      files_scanned_note: `${filesScannedNote}; engine=${engine}`,
      glob: glob || null,
      hint_symbol: hintSymbol || null,
      roots,
    },
  };
}


module.exports = {
  searchWorkspace,
  formatCitationText,
  normalizeSnippet,
  inferGlob,
  extractSymbol,
  resolveWorkspaceRoots,
  toCitationPath,
  scoreMatch,
  ELLIPSIS_LINE,
};
