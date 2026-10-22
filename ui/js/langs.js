// ============================================
// LANGS.JS — Language metadata + lazy Prism loader
// ============================================
//
// Each entry: the Prism grammar name, how we label it, the local logo file
// (may be missing → letter badge is used instead), and a brand-ish color used
// for the letter badge, the header rule, and the container accent.

export const LANG_META = {
  javascript:  { label: 'JavaScript',  logo: 'javascript',  badge: 'JS',  color: '#f7df1e' },
  js:          { label: 'JavaScript',  logo: 'javascript',  badge: 'JS',  color: '#f7df1e' },
  jsx:         { label: 'JSX',         logo: 'javascript',  badge: 'JSX', color: '#61dafb' },
  typescript:  { label: 'TypeScript',  logo: 'typescript',  badge: 'TS',  color: '#3178c6' },
  ts:          { label: 'TypeScript',  logo: 'typescript',  badge: 'TS',  color: '#3178c6' },
  tsx:         { label: 'TSX',         logo: 'typescript',  badge: 'TSX', color: '#3178c6' },
  python:      { label: 'Python',      logo: 'python',      badge: 'PY',  color: '#3776ab' },
  py:          { label: 'Python',      logo: 'python',      badge: 'PY',  color: '#3776ab' },
  html:        { label: 'HTML',        logo: 'html',        badge: '<>', color: '#e34f26' },
  markup:      { label: 'HTML',        logo: 'html',        badge: '<>', color: '#e34f26' },
  xml:         { label: 'XML',         logo: 'xml',         badge: '<>', color: '#e37933' },
  svg:         { label: 'SVG',         logo: 'xml',         badge: '<>', color: '#ffb13b' },
  css:         { label: 'CSS',         logo: 'css',         badge: '#',  color: '#1572b6' },
  scss:        { label: 'SCSS',        logo: 'scss',        badge: 'S',  color: '#c6538c' },
  sass:        { label: 'Sass',        logo: 'scss',        badge: 'S',  color: '#c6538c' },
  less:        { label: 'Less',        logo: 'scss',        badge: 'L',  color: '#1d365d' },
  bash:        { label: 'Bash',        logo: 'bash',        badge: '>_', color: '#4eaa25' },
  sh:          { label: 'Shell',       logo: 'bash',        badge: '>_', color: '#4eaa25' },
  shell:       { label: 'Shell',       logo: 'bash',        badge: '>_', color: '#4eaa25' },
  console:     { label: 'Shell',       logo: 'bash',        badge: '>_', color: '#4eaa25' },
  json:        { label: 'JSON',        logo: 'json',        badge: '{ }',color: '#e8c547' },
  jsonc:       { label: 'JSON',        logo: 'json',        badge: '{ }',color: '#e8c547' },
  yaml:        { label: 'YAML',        logo: 'yaml',        badge: 'YM', color: '#cb171e' },
  yml:         { label: 'YAML',        logo: 'yaml',        badge: 'YM', color: '#cb171e' },
  toml:        { label: 'TOML',        logo: 'ini',         badge: 'TM', color: '#9c4221' },
  ini:         { label: 'INI',         logo: 'ini',         badge: 'IN', color: '#6d8086' },
  c:           { label: 'C',           logo: 'c',           badge: 'C',  color: '#5c6bc0' },
  cpp:         { label: 'C++',         logo: 'cpp',         badge: 'C++',color: '#00599c' },
  'c++':       { label: 'C++',         logo: 'cpp',         badge: 'C++',color: '#00599c' },
  csharp:      { label: 'C#',          logo: 'csharp',      badge: 'C#', color: '#68217a' },
  cs:          { label: 'C#',          logo: 'csharp',      badge: 'C#', color: '#68217a' },
  java:        { label: 'Java',        logo: 'java',        badge: 'JV', color: '#f89820' },
  go:          { label: 'Go',          logo: 'go',          badge: 'GO', color: '#00add8' },
  golang:      { label: 'Go',          logo: 'go',          badge: 'GO', color: '#00add8' },
  rust:        { label: 'Rust',        logo: 'rust',        badge: 'RS', color: '#dea584' },
  rs:          { label: 'Rust',        logo: 'rust',        badge: 'RS', color: '#dea584' },
  ruby:        { label: 'Ruby',        logo: 'ruby',        badge: 'RB', color: '#cc342d' },
  rb:          { label: 'Ruby',        logo: 'ruby',        badge: 'RB', color: '#cc342d' },
  php:         { label: 'PHP',         logo: 'php',         badge: 'PHP',color: '#777bb4' },
  swift:       { label: 'Swift',       logo: 'swift',       badge: 'SW', color: '#fa7343' },
  kotlin:      { label: 'Kotlin',      logo: 'kotlin',      badge: 'KT', color: '#a97bff' },
  scala:       { label: 'Scala',       logo: 'scala',       badge: 'SC', color: '#dc322f' },
  dart:        { label: 'Dart',        logo: 'dart',        badge: 'DA', color: '#0175c2' },
  lua:         { label: 'Lua',         logo: 'lua',         badge: 'LU', color: '#2c2d72' },
  perl:        { label: 'Perl',        logo: 'perl',        badge: 'PL', color: '#0298c3' },
  r:           { label: 'R',           logo: 'r',           badge: 'R',  color: '#276dc3' },
  sql:         { label: 'SQL',         logo: 'sql',         badge: 'SQ', color: '#e38c00' },
  graphql:     { label: 'GraphQL',     logo: 'graphql',     badge: 'GQ', color: '#e10098' },
  diff:        { label: 'Diff',        logo: 'diff',        badge: '±',  color: '#89e051' },
  patch:       { label: 'Diff',        logo: 'diff',        badge: '±',  color: '#89e051' },
  dockerfile:  { label: 'Docker',      logo: 'docker',      badge: 'DK', color: '#2496ed' },
  docker:      { label: 'Docker',      logo: 'docker',      badge: 'DK', color: '#2496ed' },
  powershell:  { label: 'PowerShell',  logo: 'powershell',  badge: 'PS', color: '#2c72c8' },
  ps1:         { label: 'PowerShell',  logo: 'powershell',  badge: 'PS', color: '#2c72c8' },
  markdown:    { label: 'Markdown',    logo: 'markdown',    badge: 'MD', color: '#8b949e' },
  md:          { label: 'Markdown',    logo: 'markdown',    badge: 'MD', color: '#8b949e' },
  elixir:      { label: 'Elixir',      logo: 'elixir',      badge: 'EX', color: '#6e4a7e' },
  haskell:     { label: 'Haskell',     logo: 'haskell',     badge: 'HS', color: '#5d4f85' },
  text:        { label: 'Text',        logo: null,          badge: 'TXT',color: '#8b949e' },
  txt:         { label: 'Text',        logo: null,          badge: 'TXT',color: '#8b949e' },
  plaintext:   { label: 'Text',        logo: null,          badge: 'TXT',color: '#8b949e' },
};

/** File extension used for the download button. */
const EXT = {
  javascript: 'js', js: 'js', jsx: 'jsx', typescript: 'ts', ts: 'ts', tsx: 'tsx',
  python: 'py', py: 'py', html: 'html', markup: 'html', xml: 'xml', svg: 'svg',
  css: 'css', scss: 'scss', sass: 'sass', less: 'less', bash: 'sh', sh: 'sh',
  shell: 'sh', console: 'txt', json: 'json', jsonc: 'json', yaml: 'yml', yml: 'yml',
  toml: 'toml', ini: 'ini', c: 'c', cpp: 'cpp', 'c++': 'cpp', csharp: 'cs', cs: 'cs',
  java: 'java', go: 'go', golang: 'go', rust: 'rs', rs: 'rs', ruby: 'rb', rb: 'rb',
  php: 'php', swift: 'swift', kotlin: 'kt', scala: 'scala', dart: 'dart', lua: 'lua',
  perl: 'pl', r: 'r', sql: 'sql', graphql: 'graphql', diff: 'diff', patch: 'diff',
  dockerfile: 'dockerfile', docker: 'dockerfile', powershell: 'ps1', ps1: 'ps1',
  markdown: 'md', md: 'md', elixir: 'ex', haskell: 'hs',
};

const DEFAULT_META = { label: 'Code', logo: null, badge: '··', color: '#00e5ff' };

/** Normalize a fence tag to our metadata key. */
export function langKey(tag) {
  return String(tag || '').trim().toLowerCase().split(/[\s:]/)[0];
}

/** Metadata for a language tag, always returns something renderable. */
export function metaFor(tag) {
  const key = langKey(tag);
  return LANG_META[key] || { ...DEFAULT_META, label: key ? key.toUpperCase() : 'CODE' };
}

/** Download extension for a language tag. */
export function extFor(tag) {
  return EXT[langKey(tag)] || 'txt';
}

/**
 * Guess the language from the code itself (used when a fence has no tag).
 * Same idea as the reference project: cheap, ordered heuristics.
 */
export function detectLang(code) {
  const s = String(code || '');
  if (!s.trim()) return 'text';
  if (/^\s*[\[{]/.test(s) && /:\s*["'\d]/.test(s) && !/^\s*[<]/.test(s)) return 'json';
  if (/^\s*<\?xml|^\s*<!DOCTYPE|^\s*<svg/i.test(s)) return 'xml';
  if (/^\s*</.test(s) && /<\/?[a-z][\w-]*/i.test(s)) return 'html';
  if (/#!\s*\/(bin|usr\/bin)\/(ba)?sh/.test(s)) return 'bash';
  if (/^\s*(npm|yarn|pnpm|git|curl|apt|pip|docker|sudo|cd|export|echo|if|for|while)\s/m.test(s)
      && !/\bfunction\b|=>|;\s*$/.test(s.split('\n')[0] || '')) return 'bash';
  if (/^\s*(SELECT|INSERT|UPDATE|DELETE|CREATE TABLE|ALTER TABLE|WITH)\b/i.test(s)) return 'sql';
  if (/^\s*[\w.-]+\s*:\s*[\w"'-[].*$/m.test(s) && !/[{};]/.test(s)) return 'yaml';
  if (/^\s*(def|class|import|from|print)\s.*:|^\s*@(?:app|route|.*)\.route/m.test(s)) return 'python';
  if (/^\s*(package|import)\s+[\w.]+;/m.test(s)) return 'java';
  if (/^\s*(package|using|namespace)\s+/m.test(s) && /;/m.test(s)) return 'csharp';
  if (/^\s*(fn|let\s+mut|impl|use\s+std)/m.test(s)) return 'rust';
  if (/^\s*func\s+\w+\(.*\)\s*\{/m.test(s)) return 'go';
  if (/^\s*#include\s*<|^int\s+main\s*\(/m.test(s)) return 'cpp';
  if (/^\s*(const|let|var|function|export|async)\s/m.test(s)) return 'javascript';
  if (/^[+-]{3} |^@@ /m.test(s)) return 'diff';
  return 'text';
}

/** Local asset base, resolved relative to this module (portable). */
const ASSET_BASE = new URL('../img/', import.meta.url).href;
const VENDOR_BASE = new URL('../vendor/prism/', import.meta.url).href;

/** Local logo URL for a language, or null when we have no file for it. */
export function logoFor(tag) {
  const meta = metaFor(tag);
  return meta.logo ? `${ASSET_BASE}lang/${meta.logo}.svg` : null;
}

/**
 * Component files must load in dependency order (Prism grammars extend each
 * other). We only ship the ones we actually reference, in a safe order.
 */
const PRISM_LOAD_ORDER = [
  'markup', 'css', 'clike', 'javascript',   // bundled in prism.min.js too
  'bash', 'c', 'cpp', 'csharp', 'java', 'go', 'kotlin', 'ruby', 'crystal',
  'dart', 'solidity', 'scala', 'python', 'yaml', 'toml', 'sql', 'php',
  'markdown', 'diff', 'docker', 'lua', 'perl', 'r', 'haskell', 'elixir',
  'erlang', 'nim', 'less', 'scss', 'sass', 'ini', 'graphql', 'powershell',
  'typescript', 'jsx', 'tsx',
];

let corePromise = null;
const loaded = new Set();
const pending = new Set();
let chain = Promise.resolve();

function injectScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.async = false;
    s.onload = () => resolve(true);
    s.onerror = () => reject(new Error('Failed to load ' + src));
    document.head.appendChild(s);
  });
}

/** Load prism.min.js once. Resolves to the Prism object or null. */
function ensureCore() {
  if (corePromise) return corePromise;
  corePromise = (async () => {
    const bust = `?v=${document.documentElement.dataset.build || '1'}`;
    if (!window.Prism) await injectScript(`${VENDOR_BASE}prism.min.js${bust}`);
    if (!window.Prism) throw new Error('Prism missing after core load');
    // Grammars bundled inside prism.min.js already.
    loaded.add('markup'); loaded.add('css'); loaded.add('clike'); loaded.add('javascript');
    if (typeof window.Prism.manual === 'undefined') window.Prism.manual = true;
    return window.Prism;
  })().catch(err => {
    console.warn('Prism unavailable, using fallback highlighter:', err.message);
    return null;
  });
  return corePromise;
}

/**
 * Load Prism plus whatever grammars these languages need. Repeat calls with
 * new languages fetch only what is still missing, in dependency order.
 */
export function loadPrism(tags = []) {
  tags.map(langKey).forEach(k => pending.add(k));
  if (pending.size === 0) pending.add('javascript');

  // Queue grammar work behind whatever is already in flight so scripts stay
  // ordered (a grammar must not load before the one it extends).
  chain = chain.then(async () => {
    const prism = await ensureCore();
    if (!prism) return null;
    const bust = `?v=${document.documentElement.dataset.build || '1'}`;
    for (const name of PRISM_LOAD_ORDER) {
      if (!pending.has(name) || loaded.has(name)) continue;
      pending.delete(name);
      try {
        await injectScript(`${VENDOR_BASE}components/prism-${name}.min.js${bust}`);
        loaded.add(name);
      } catch {
        // Grammar file missing — Prism just won't know this language.
      }
    }
    return window.Prism || null;
  });

  return chain;
}

/**
 * Highlight one <code> element. No-ops (and returns false) when Prism is
 * missing or doesn't know the language, so callers keep plain text.
 */
export async function highlightElement(codeEl, tag) {
  const key = langKey(tag);
  const prism = await loadPrism([key]);
  if (!prism || !prism.languages[key]) return false;
  try {
    const grammar = prism.languages[key];
    const text = codeEl.textContent || '';
    codeEl.innerHTML = prism.highlight(text, grammar, key);
    return true;
  } catch {
    return false;
  }
}