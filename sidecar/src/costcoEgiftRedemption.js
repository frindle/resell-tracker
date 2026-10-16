'use strict';

// Pure parser for the Costco eGift redemption page. Reads strings only.

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

function hasClassToken(attrs, token) {
  const value = getAttr(attrs, 'class');
  return value !== null && value.split(/\s+/).includes(token);
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

function classPred(token, tagName) {
  return (tag) => (!tagName || tag.name === tagName) && hasClassToken(tag.attrs, token);
}

function findElementByClass(fragment, token) {
  const el = findElement(fragment, classPred(token));
  return el ? fragment.slice(el.innerStart, el.innerEnd) : null;
}

function removeElementByClass(fragment, token) {
  const el = findElement(fragment, classPred(token));
  return el ? fragment.slice(0, el.openTag.start) + fragment.slice(el.outerEnd) : fragment;
}

// Inner HTML of every <section> carrying the class token `order-item`, in document order.
function findCards(html) {
  const cards = [];
  let from = 0;
  for (;;) {
    const rest = html.slice(from);
    const el = findElement(rest, classPred('order-item', 'section'));
    if (!el) break;
    cards.push(rest.slice(el.innerStart, el.innerEnd));
    from += el.outerEnd;
  }
  return cards;
}

function hasAlert(html) {
  const el = findElement(html, (tag) => tag.name === 'div' && hasClassToken(tag.attrs, 'ui-message') && getAttr(tag.attrs, 'role') === 'alert');
  return el !== null && textOf(html.slice(el.innerStart, el.innerEnd)) !== '';
}

function readCounter(text) {
  const m = /(\d+)\s+of\s+(\d+)/.exec(text);
  return m ? { n: Number(m[1]), m: Number(m[2]) } : null;
}

function normLabel(s) {
  return s.trim().toLowerCase();
}

// True iff a button / link / input in the fragment has a label equal to openLabel.
function hasOpenControl(actions, openLabel) {
  const want = normLabel(openLabel);
  if (want === 'send gift') return false;
  const tags = scanTags(actions);
  for (let k = 0; k < tags.length; k++) {
    const tag = tags[k];
    if (tag.closing) continue;
    let label = null;
    if (tag.name === 'input') {
      const value = getAttr(tag.attrs, 'value');
      label = value === null ? null : decodeEntities(value);
    } else if (tag.name === 'button' || tag.name === 'a') {
      const el = findElement(actions.slice(tag.start), (t) => t.start === 0);
      if (el) label = textOf(actions.slice(tag.start + el.innerStart, tag.start + el.innerEnd));
    }
    if (label === null) continue;
    const norm = normLabel(label);
    if (norm !== 'send gift' && norm === want) return true;
  }
  return false;
}

function parseRedemptionPage(html, cfg) {
  try {
    if (typeof html !== 'string' || !cfg || typeof cfg !== 'object' || Array.isArray(cfg) || typeof cfg.openLabel !== 'string') {
      return { ok: false, reason: 'invalid-input' };
    }
    const cleaned = cleanHtml(html);
    const fragments = findCards(cleaned);
    if (fragments.length === 0) {
      return { ok: false, reason: hasAlert(cleaned) ? 'alert' : 'no-cards' };
    }

    let total = null;
    const cards = [];
    for (let k = 0; k < fragments.length; k++) {
      const fragment = fragments[k];
      const titleHtml = findElementByClass(fragment, 'order-item-title');
      const actionsHtml = findElementByClass(fragment, 'order-item-actions');
      const body = removeElementByClass(removeElementByClass(fragment, 'order-item-title'), 'order-item-actions');
      const counter = readCounter(textOf(body));
      if (counter && total === null) total = counter.m;
      cards.push({
        index: counter ? counter.n : k + 1,
        title: titleHtml === null ? '' : textOf(titleHtml),
        canOpen: actionsHtml !== null && hasOpenControl(actionsHtml, cfg.openLabel),
      });
    }

    let orderNumber = null;
    const om = /Order Number:\s*([A-Za-z0-9-]+)/.exec(textOf(cleaned));
    if (om) {
      const prefix = cfg.orderPrefix;
      if (!(typeof prefix === 'string' && prefix !== '' && !om[1].startsWith(prefix))) orderNumber = om[1];
    }

    return { ok: true, orderNumber, total: total === null ? cards.length : total, cards };
  } catch (e) {
    return { ok: false, reason: 'invalid-input' };
  }
}

module.exports = { parseRedemptionPage };
