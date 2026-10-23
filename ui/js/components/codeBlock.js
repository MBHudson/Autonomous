// ============================================
// CODEBLOCK.JS — Expanded code container
// ============================================
//
// A fenced block inside an agent reply becomes its own always-open container:
//
//   ┌────────────────────────────────────────────┐
//   │ [logo] Python                    ⧉  ⭳      │  ← header
//   ├────────────────────────────────────────────┤
//   │ highlighted source                          │
//   └────────────────────────────────────────────┘
//
// Logo is the local SVG when we have one, otherwise a colored letter badge.

import { copyToClipboard, downloadFile } from '../utils.js?v=306';
import { metaFor, extFor, logoFor, detectLang, highlightElement } from '../langs.js?v=306';
import { highlightSyntax } from '../utils.js?v=306';

const ICON_COPY = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5V4A1.5 1.5 0 0 0 9 2.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5"/></svg>';
const ICON_DOWNLOAD = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2v7.5M8 9.5 5 6.5M8 9.5l3-3M2.5 13.5h11"/></svg>';
const ICON_CHECK = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8.5 6.5 12 13 4.5"/></svg>';

/** Build the language identity block (logo or letter badge + name). */
function buildLangChip(tag) {
  const meta = metaFor(tag);
  const chip = document.createElement('div');
  chip.className = 'code-lang';

  const logo = logoFor(tag);
  if (logo) {
    const img = document.createElement('img');
    img.className = 'code-lang-logo';
    img.src = logo;
    img.alt = '';
    img.loading = 'lazy';
    img.width = 18;
    img.height = 18;
    // No logo file for this language → letter badge instead.
    img.addEventListener('error', () => {
      img.remove();
      chip.insertBefore(buildBadge(meta), img);
    }, { once: true });
    chip.appendChild(img);
  } else {
    chip.appendChild(buildBadge(meta));
  }

  const name = document.createElement('span');
  name.className = 'code-lang-name';
  name.textContent = meta.label;
  chip.appendChild(name);

  return chip;
}

function buildBadge(meta) {
  const badge = document.createElement('span');
  badge.className = 'code-lang-badge';
  badge.textContent = meta.badge;
  // Light colors need dark ink, dark ones need light ink.
  const r = parseInt(meta.color.slice(1, 3), 16);
  const g = parseInt(meta.color.slice(3, 5), 16);
  const b = parseInt(meta.color.slice(5, 7), 16);
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  badge.style.background = meta.color;
  badge.style.color = lum > 0.6 ? '#0a0e14' : '#eaf6ff';
  return badge;
}

export class CodeBlock {
  /**
   * @param {string} code — source text
   * @param {string} lang — fence tag (may be empty; we then guess)
   * @param {Object} opts — { filename }
   */
  constructor(code, lang, opts = {}) {
    this.rawCode = String(code || '');
    this.tag = (lang || '').trim() || detectLang(this.rawCode);
    this.meta = metaFor(this.tag);
    this.filename = opts.filename || '';
  }

  render() {
    const wrap = document.createElement('div');
    wrap.className = 'code-block';
    wrap.style.setProperty('--code-accent', this.meta.color);

    // ---- header: language identity (left) + actions (right) ----
    const header = document.createElement('div');
    header.className = 'code-block-header';
    header.appendChild(buildLangChip(this.tag));

    const actions = document.createElement('div');
    actions.className = 'code-block-actions';

    const copyBtn = document.createElement('button');
    copyBtn.className = 'code-block-btn';
    copyBtn.innerHTML = ICON_COPY;
    copyBtn.title = 'Copy code';
    copyBtn.setAttribute('aria-label', 'Copy code');
    copyBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const ok = await copyToClipboard(this.rawCode);
      flash(copyBtn, ok ? ICON_CHECK : ICON_COPY);
      copyBtn.classList.toggle('is-error', !ok);
      setTimeout(() => { copyBtn.classList.remove('is-error'); }, 1200);
    });

    const dlBtn = document.createElement('button');
    dlBtn.className = 'code-block-btn';
    dlBtn.innerHTML = ICON_DOWNLOAD;
    dlBtn.title = `Download as .${extFor(this.tag)}`;
    dlBtn.setAttribute('aria-label', dlBtn.title);
    dlBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const ext = extFor(this.tag);
      downloadFile(this.rawCode, this.filename || `snippet.${ext}`, 'text/plain');
      flash(dlBtn, ICON_CHECK);
    });

    actions.appendChild(copyBtn);
    actions.appendChild(dlBtn);
    header.appendChild(actions);

    // ---- body: highlighted source ----
    const pre = document.createElement('pre');
    pre.className = 'code-block-pre';
    const code = document.createElement('code');
    code.className = `language-${this.tag}`;
    // Instant fallback paint, upgraded to Prism when it finishes loading.
    code.innerHTML = highlightSyntax(this.rawCode, this.tag);
    pre.appendChild(code);
    wrap.appendChild(header);
    wrap.appendChild(pre);

    highlightElement(code, this.tag).then(done => {
      if (done) wrap.classList.add('prism-ready');
    });

    return wrap;
  }
}

/** Briefly swap a button's icon, then put it back. */
function flash(btn, icon) {
  btn.innerHTML = icon;
  btn.classList.add('is-done');
  setTimeout(() => {
    btn.innerHTML = btn.title.startsWith('Copy') ? ICON_COPY : ICON_DOWNLOAD;
    btn.classList.remove('is-done');
  }, 1100);
}

/** Pull every fenced block out of a message body. */
export function splitFences(content) {
  const text = String(content || '');
  const parts = [];
  const re = /```([A-Za-z0-9_+#.-]*)\r?\n?([\s\S]*?)```/g;
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push({ type: 'text', content: text.slice(last, m.index) });
    parts.push({ type: 'code', lang: m[1] || '', content: m[2].replace(/\s+$/, '') });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ type: 'text', content: text.slice(last) });
  return parts.filter(p => p.content && p.content.trim());
}

export default CodeBlock;