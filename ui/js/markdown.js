// ============================================
// MARKDOWN.JS — Small safe markdown for message prose
// ============================================
//
// Everything is HTML-escaped FIRST, then only these transformations run, so
// agent output can never inject markup into the dialog. Fenced code is handled
// by the caller (CodeBlock) and never reaches here.

import { esc } from './utils.js?v=313';

/**
 * Render markdown-ish prose into an element.
 * Supports: headings, bold, italic, inline code, links, blockquotes,
 * horizontal rules, and bullet/ordered lists.
 */
export function renderMarkdown(text) {
  const host = document.createElement('div');
  host.className = 'md-body';
  const src = esc(String(text || '')).replace(/\r\n/g, '\n');
  if (!src.trim()) return host;

  // Inline code is stashed so later passes can't rewrite its contents.
  const stash = [];
  const stashCode = html => {
    stash.push(html);
    return `\uE000CODE${stash.length - 1}\uE001`;
  };
  let work = src.replace(/`([^`\n]+)`/g, (_, c) => stashCode(`<code class="md-inline-code">${c}</code>`));

  // Links: [label](url) with an http(s) guard.
  work = work.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g,
    (_, label, url) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`);
  // Bare URLs that aren't already inside a tag.
  work = work.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g,
    (m, pre, url) => `${pre}<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`);

  // Emphasis — longest markers first so ** isn't eaten by *.
  work = work.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  work = work.replace(/__([^_\n]+)__/g, '<strong>$1</strong>');
  work = work.replace(/(^|[^*\w])\*([^*\n]+)\*(?![*\w])/g, '$1<em>$2</em>');
  work = work.replace(/(^|[^_\w])_([^_\n]+)_(?![_\w])/g, '$1<em>$2</em>');

  // Split into blocks, then handle each.
  const blocks = work.split(/\n{2,}/);
  blocks.forEach(block => {
    const lines = block.split('\n');
    const line = lines[0].trim();

    if (/^(?:---+|\*\*\*+|___+)$/.test(line)) {
      host.appendChild(document.createElement('hr'));
      return;
    }
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const h = document.createElement('h' + Math.min(heading[1].length + 2, 6));
      h.innerHTML = heading[2];
      host.appendChild(h);
      return;
    }
    if (/^&gt;\s?/.test(line) || /^>\s?/.test(line)) {
      const bq = document.createElement('blockquote');
      bq.innerHTML = lines.join('\n').replace(/^&gt;\s?/gm, '');
      host.appendChild(bq);
      return;
    }
    // Bullet list: every line starts with -, *, or •
    if (lines.length && lines.every(l => /^\s*[-*•]\s+/.test(l))) {
      const ul = document.createElement('ul');
      lines.forEach(l => {
        const li = document.createElement('li');
        li.innerHTML = l.replace(/^\s*[-*•]\s+/, '');
        ul.appendChild(li);
      });
      host.appendChild(ul);
      return;
    }
    // Ordered list
    if (lines.length && lines.every(l => /^\s*\d+[.)]\s+/.test(l))) {
      const ol = document.createElement('ol');
      lines.forEach(l => {
        const li = document.createElement('li');
        li.innerHTML = l.replace(/^\s*\d+[.)]\s+/, '');
        ol.appendChild(li);
      });
      host.appendChild(ol);
      return;
    }
    const p = document.createElement('p');
    p.innerHTML = block.replace(/\n/g, '<br>');
    host.appendChild(p);
  });

  // Put inline code back (content was escaped before stashing).
  host.innerHTML = host.innerHTML.replace(/\uE000CODE(\d+)\uE001/g, (_, i) => stash[Number(i)]);
  return host;
}

export default renderMarkdown;