'use strict';

// Pure parser for the Costco / Best Buy eGift print page. Reads strings only.
// Code and PIN are secrets: they appear only in the success result.

const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const BLOCK_TAGS = new Set(['address', 'article', 'aside', 'blockquote', 'br', 'dd', 'div', 'dl', 'dt', 'fieldset', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'li', 'main', 'nav', 'ol', 'p', 'section', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul']);

function cleanHtml(html) {
  let out = html.replace(/<!--[\s\S]*?(?:-->|$)/g, '');
  out = out.replace(/<script\b[\s\S]*?(?:<\/script\s*>|$)/gi, '');
  out = out.replace(/<style\b[\s\S]*?(?:<\/style\s*>|$)/gi, '');
  return out;
}

// Scan every tag in order. A '>' inside a quoted attribute value does not end the tag.
// Returns [{ name, closing, selfClosing, attrs, start, end }] (end is exclusive).
function scanTags(html) {
  const tags = [];
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt === -1) break;
    const m = /^<(\/?)([A-Za-z][A-Za-z0-9:-]*)/.exec(html.slice(lt, lt + 40));
    if (!m) {
      i = lt + 1;
      continue;
    }
    let j = lt + m[0].length;
    let quote = null;
    while (j < html.length) {
      const ch = html[j];
      if (quote) {
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === '>') {
        break;
      }
      j++;
    }
    if (j >= html.length) break; // tag never ends
    const attrs = html.slice(lt + m[0].length, j);
    tags.push({
      name: m[2].toLowerCase(),
      closing: m[1] === '/',
      selfClosing: /\/\s*$/.test(attrs) || VOID_TAGS.has(m[2].toLowerCase()),
      attrs,
      start: lt,
      end: j + 1,
    });
    i = j + 1;
  }
  return tags;
}

function decodeEntities(text) {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function textOf(fragment) {
  let out = '';
  let pos = 0;
  for (const tag of scanTags(fragment)) {
    out += fragment.slice(pos, tag.start);
    out += BLOCK_TAGS.has(tag.name) ? ' ' : '';
    pos = tag.end;
  }
  out += fragment.slice(pos);
  return decodeEntities(out).replace(/\s+/g, ' ').trim();
}

function getAttr(attrs, name) {
  const re = new RegExp('(?:^|\\s)' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s"\'>]+))', 'i');
  const m = re.exec(attrs);
  if (!m) return null;
  return m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3];
}

// Find the first element whose open tag satisfies pred(tag). Returns
// { openTag, innerStart, innerEnd, outerEnd } or null (also null when never closed).
function findElement(fragment, pred) {
  const tags = scanTags(fragment);
  for (let k = 0; k < tags.length; k++) {
    const open = tags[k];
    if (open.closing || !pred(open)) continue;
    if (open.selfClosing) continue;
    let depth = 1;
    for (let n = k + 1; n < tags.length; n++) {
      const t = tags[n];
      if (t.name !== open.name || t.selfClosing) continue;
      depth += t.closing ? -1 : 1;
      if (depth === 0) {
        return { openTag: open, innerStart: open.end, innerEnd: t.start, outerEnd: t.end };
      }
    }
    return null;
  }
  return null;
}

const BLOCK_NAMES = new Set(['td', 'th', 'div', 'p']);
const NESTED_NAMES = new Set(['td', 'th', 'table', 'tr', 'div', 'p']);

// Leaf blocks (td, th, div, p without nested td|th|table|tr|div|p), in document order.
// Each is { tag, html, text, start, end }. The returned array also carries
// `rowEnds`: the positions of every </tr>, so callers can tell whether two blocks share a row.
function leafBlocks(html) {
  const tags = scanTags(html);
  const blocks = [];
  for (let k = 0; k < tags.length; k++) {
    const open = tags[k];
    if (open.closing || open.selfClosing || !BLOCK_NAMES.has(open.name)) continue;
    let depth = 1;
    let closeIdx = -1;
    let leaf = true;
    for (let n = k + 1; n < tags.length; n++) {
      const t = tags[n];
      if (t.name === open.name && !t.selfClosing) {
        depth += t.closing ? -1 : 1;
        if (depth === 0) {
          closeIdx = n;
          break;
        }
      }
      if (!t.closing && NESTED_NAMES.has(t.name)) leaf = false;
    }
    if (closeIdx === -1 || !leaf) continue;
    const inner = html.slice(open.end, tags[closeIdx].start);
    blocks.push({ tag: open.name, html: inner, text: textOf(inner), start: open.start, end: tags[closeIdx].end });
  }
  blocks.rowEnds = tags.filter((t) => t.closing && t.name === 'tr').map((t) => t.start);
  return blocks;
}

// Inner HTML of the first <span> in the fragment (its own matching close), or null.
function firstSpanText(fragment) {
  const el = findElement(fragment, (tag) => tag.name === 'span');
  return el ? textOf(fragment.slice(el.innerStart, el.innerEnd)) : null;
}

// DISTINCT values for a label (see rules 1-3 in the task contract).
function lookupField(blocks, label, plain) {
  const values = [];
  if (typeof label !== 'string' || label === '') return values;
  const want = label.toLowerCase();
  const rowEnds = blocks.rowEnds || [];
  for (let k = 0; k < blocks.length; k++) {
    const block = blocks[k];
    if (!block.text.toLowerCase().startsWith(want)) continue;
    const rest = block.text.slice(label.length).trim();
    let value = firstSpanText(block.html); // rule 1
    if (!value && (block.tag === 'td' || block.tag === 'th') && rest === '') {
      // rule 2: first span of the next cell in the same row
      const next = blocks[k + 1];
      const sameRow = next && !rowEnds.some((pos) => pos >= block.end && pos <= next.start);
      if (next && (next.tag === 'td' || next.tag === 'th') && sameRow) value = firstSpanText(next.html);
    }
    if (!value && plain === true) value = rest; // rule 3
    if (value && !values.includes(value)) values.push(value);
  }
  return values;
}

function parsePrintPage(html, cfg) {
  try {
    if (typeof html !== 'string' || !cfg || typeof cfg !== 'object' || Array.isArray(cfg) || typeof cfg.code !== 'string') {
      return { ok: false, reason: 'invalid-input' };
    }
    const cleaned = cleanHtml(html);

    // Pager: element id="wdt-page-counter" reading "N of M".
    const pagerEl = findElement(cleaned, (tag) => getAttr(tag.attrs, 'id') === 'wdt-page-counter');
    const pager = pagerEl ? /^(\d+)\s+of\s+(\d+)$/.exec(textOf(cleaned.slice(pagerEl.innerStart, pagerEl.innerEnd))) : null;
    const index = pager ? Number(pager[1]) : 0;
    const total = pager ? Number(pager[2]) : 0;
    if (!pager || index < 1 || index > total) return { ok: false, reason: 'no-pager' };
    const hasNext = scanTags(cleaned).some((tag) => {
      const id = getAttr(tag.attrs, 'id');
      return !tag.closing && tag.name === 'input' && id !== null && id.endsWith('wdt-nav-next');
    });

    const blocks = leafBlocks(cleaned);
    const codes = lookupField(blocks, cfg.code, false);
    if (codes.length === 0) return { ok: false, reason: 'no-code' };
    if (codes.length > 1) return { ok: false, reason: 'ambiguous-code' };

    let pin = null;
    if (typeof cfg.pin === 'string') {
      const pins = lookupField(blocks, cfg.pin, true);
      if (pins.length === 0) return { ok: false, reason: 'no-pin' };
      if (pins.length > 1) return { ok: false, reason: 'ambiguous-pin' };
      pin = pins[0];
    }

    // Title: first <h2> after the element id="print-content-section" begins.
    let title = '';
    const section = scanTags(cleaned).find((tag) => !tag.closing && getAttr(tag.attrs, 'id') === 'print-content-section');
    if (section) {
      const after = cleaned.slice(section.end);
      const h2 = findElement(after, (tag) => tag.name === 'h2');
      if (h2) title = textOf(after.slice(h2.innerStart, h2.innerEnd));
    }

    return { ok: true, index, total, done: index === total || !hasNext, code: codes[0], pin, title };
  } catch (e) {
    return { ok: false, reason: 'invalid-input' };
  }
}

module.exports = { parsePrintPage };
