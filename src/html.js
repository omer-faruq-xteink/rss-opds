// Tolerant HTML -> well-formed XHTML converter for feed article bodies.
// Workers have no DOM, so this is a small tokenizer with an element stack:
// unknown tags are dropped (their text is kept), dangerous tags are dropped
// with their content, void tags are self-closed and every opened tag is
// closed in the right order so the result is valid XML.

const BLOCK = new Set([
  'p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'pre',
  'table', 'tr', 'td', 'th', 'thead', 'tbody', 'tfoot', 'figure', 'figcaption', 'dl', 'dt', 'dd',
]);
const INLINE = new Set([
  'a', 'em', 'strong', 'b', 'i', 'u', 's', 'code', 'span', 'sup', 'sub', 'small',
  'cite', 'q', 'abbr', 'mark', 'del', 'ins', 'kbd', 'var', 'time',
]);
const RENAME = {
  article: 'div', section: 'div', header: 'div', footer: 'div', aside: 'div', main: 'div', nav: 'div',
  center: 'div', details: 'div', summary: 'p', strike: 's', tt: 'code', picture: 'span',
};
const DROP_WITH_CONTENT = new Set([
  'script', 'style', 'iframe', 'object', 'embed', 'video', 'audio', 'svg', 'math', 'noscript',
  'form', 'button', 'input', 'select', 'textarea', 'template', 'head', 'title', 'canvas', 'map',
]);

const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®',
  trade: '™', mdash: '—', ndash: '–', hellip: '…', laquo: '«', raquo: '»',
  ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', bull: '•', middot: '·',
  times: '×', deg: '°', euro: '€', pound: '£', yen: '¥', cent: '¢',
  sect: '§', para: '¶', frac12: '½', frac14: '¼', frac34: '¾', shy: '­',
  lsaquo: '‹', rsaquo: '›', sbquo: '‚', bdquo: '„', dagger: '†', Dagger: '‡',
  permil: '‰', prime: '′', Prime: '″', larr: '←', rarr: '→', uarr: '↑',
  darr: '↓', harr: '↔', hearts: '♥', ensp: ' ', emsp: ' ', thinsp: ' ',
  zwj: '‍', zwnj: '‌', iexcl: '¡', iquest: '¿', ccedil: 'ç', Ccedil: 'Ç',
  ouml: 'ö', Ouml: 'Ö', uuml: 'ü', Uuml: 'Ü', auml: 'ä', Auml: 'Ä',
  eacute: 'é', Eacute: 'É', egrave: 'è', agrave: 'à', aacute: 'á', iacute: 'í',
  oacute: 'ó', uacute: 'ú', ntilde: 'ñ', szlig: 'ß', acirc: 'â', icirc: 'î',
  ucirc: 'û', ocirc: 'ô', ecirc: 'ê', aring: 'å', oslash: 'ø', aelig: 'æ',
  scaron: 'š', Scaron: 'Š', inodot: 'ı', gbreve: 'ğ', Gbreve: 'Ğ', scedil: 'ş',
  Scedil: 'Ş', Idot: 'İ',
};

export function decodeEntities(s) {
  return String(s).replace(/&(#[xX][0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, body) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = hex ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '';
      if (code < 0x20 && code !== 0x9 && code !== 0xa && code !== 0xd) return '';
      return String.fromCodePoint(code);
    }
    return Object.prototype.hasOwnProperty.call(NAMED, body) ? NAMED[body] : m;
  });
}

// XML-escape text and strip control characters XML 1.0 forbids.
export function escapeXml(s) {
  return String(s ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function parseAttrs(s) {
  const attrs = {};
  const re = /([^\s=\/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let m;
  while ((m = re.exec(s))) {
    attrs[m[1].toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  }
  return attrs;
}

function safeHref(url) {
  if (!url) return null;
  const u = url.trim();
  return /^(https?:|mailto:)/i.test(u) ? u : null;
}

/**
 * Convert feed HTML into an XHTML fragment suitable for an EPUB body.
 * @param {string} html
 * @param {object} [opts]
 * @param {(src: string, alt: string) => (string|null)} [opts.image] maps an image URL to the
 *        src to write (e.g. "images/1.jpg"); return null to drop the image.
 * @param {string} [opts.baseUrl] resolves relative links against this URL.
 * @returns {string}
 */
export function htmlToXhtml(html, opts = {}) {
  const src = String(html || '');
  const out = [];
  const stack = []; // element names
  const n = src.length;
  let i = 0;

  const top = () => (stack.length ? stack[stack.length - 1] : null);
  const emitClose = (name) => out.push(`</${name}>`);
  const popTo = (name) => {
    const idx = stack.lastIndexOf(name);
    if (idx === -1) return false;
    while (stack.length > idx) emitClose(stack.pop());
    return true;
  };
  const closeP = () => { if (top() === 'p') { stack.pop(); emitClose('p'); } };
  const ensureContainer = () => {
    if (stack.length === 0) { stack.push('p'); out.push('<p>'); }
  };
  const resolve = (u) => {
    if (!u) return u;
    if (u.startsWith('//')) return 'https:' + u;
    if (opts.baseUrl && !/^[a-z][a-z0-9+.-]*:/i.test(u)) {
      try { return new URL(u, opts.baseUrl).toString(); } catch { return u; }
    }
    return u;
  };
  const emitText = (raw) => {
    if (!raw) return;
    if (stack.length === 0 && raw.trim() === '') return; // stray whitespace at body level
    ensureContainer();
    out.push(escapeXml(decodeEntities(raw)));
  };

  while (i < n) {
    const lt = src.indexOf('<', i);
    if (lt === -1) { emitText(src.slice(i)); break; }
    if (lt > i) emitText(src.slice(i, lt));

    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4);
      i = end === -1 ? n : end + 3;
      continue;
    }
    if (src[lt + 1] === '!' || src[lt + 1] === '?') {
      const end = src.indexOf('>', lt);
      i = end === -1 ? n : end + 1;
      continue;
    }
    const tm = /^<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)/.exec(src.slice(lt, lt + 40));
    if (!tm) { emitText('<'); i = lt + 1; continue; }

    // Find the end of the tag, honouring quoted attribute values.
    let j = lt + tm[0].length;
    let quote = null;
    while (j < n) {
      const ch = src[j];
      if (quote) { if (ch === quote) quote = null; }
      else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '>') break;
      j++;
    }
    const inner = src.slice(lt + tm[0].length, Math.min(j, n));
    i = Math.min(n, j + 1);

    const closing = tm[1] === '/';
    let name = tm[2].toLowerCase();
    if (name.includes(':')) name = name.split(':').pop();
    if (RENAME[name]) name = RENAME[name];

    if (closing) {
      if (BLOCK.has(name) || INLINE.has(name)) popTo(name);
      continue;
    }
    if (DROP_WITH_CONTENT.has(name)) {
      const re = new RegExp(`</${name}\\s*>`, 'ig');
      re.lastIndex = i;
      const m = re.exec(src);
      i = m ? m.index + m[0].length : n;
      continue;
    }

    if (name === 'img') {
      const attrs = parseAttrs(inner);
      const s = resolve(attrs.src || attrs['data-src'] || '');
      const alt = (attrs.alt || '').trim();
      const mapped = opts.image && safeHref(s) ? opts.image(s, alt) : null;
      if (mapped) {
        ensureContainer();
        out.push(`<img src="${escapeXml(mapped)}" alt="${escapeXml(alt)}"/>`);
      } else if (alt) {
        ensureContainer();
        out.push(`<span class="img-alt">[${escapeXml(alt)}]</span>`);
      }
      continue;
    }
    if (name === 'br') { ensureContainer(); out.push('<br/>'); continue; }
    if (name === 'hr') { closeP(); out.push('<hr/>'); continue; }

    if (BLOCK.has(name)) {
      if (name === 'li') { if (!popTo('li')) closeP(); }
      else if (name === 'tr') { if (!popTo('tr')) closeP(); }
      else if (name === 'td' || name === 'th') { if (!popTo('td') && !popTo('th')) closeP(); }
      else if (name === 'dt' || name === 'dd') { if (!popTo('dt') && !popTo('dd')) closeP(); }
      else closeP();
      stack.push(name);
      out.push(`<${name}>`);
      continue;
    }
    if (!INLINE.has(name)) continue; // unknown tag: drop it, keep its content

    ensureContainer();
    if (name === 'a') {
      if (stack.includes('a')) { stack.push('span'); out.push('<span>'); continue; }
      const href = safeHref(resolve(parseAttrs(inner).href));
      stack.push('a');
      out.push(href ? `<a href="${escapeXml(href)}">` : '<a>');
      continue;
    }
    stack.push(name);
    out.push(`<${name}>`);
  }
  while (stack.length) emitClose(stack.pop());
  return out.join('').replace(/<p>\s*<\/p>/g, '');
}

/** Plain-text excerpt of an HTML string (for OPDS summaries). */
export function textExcerpt(html, max = 400) {
  const t = decodeEntities(
    String(html || '')
      .replace(/<(script|style)[\s\S]*?<\/\1\s*>/gi, ' ')
      .replace(/<br\s*\/?>|<\/p>|<\/div>|<\/li>|<\/h[1-6]>/gi, ' ')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/\s+/g, ' ')
    .trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const sp = cut.lastIndexOf(' ');
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut) + '…';
}
