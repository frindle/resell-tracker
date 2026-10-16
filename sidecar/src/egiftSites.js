'use strict';

// SITES: per-site parser config for eGift scrapers.
const SITES = {
  costco: {
    host: 'www.memberedelivery.com',
    openLabel: 'Access eGift',
    orderPrefix: null,
    code: 'Code:',
    pin: null,
    merchant: null,
  },
  bestbuy: {
    host: 'specialtyegc.bestbuy.com',
    openLabel: 'View',
    orderPrefix: 'BBY01-',
    code: 'Card Number:',
    pin: 'PIN:',
    merchant: null,
  },
};

/**
 * Map a host string or URL to a site key.
 * Returns 'costco' | 'bestbuy' | null.
 * Non-string → null.
 * If the string contains '/' or ':' it is treated as a URL:
 *   parsed with new URL (failure → null);
 *   must be https: with no username/password;
 *   hostname is compared.
 * Otherwise the lowercased string itself is the host.
 * The host must EQUAL a site's host exactly (case-insensitive).
 */
function siteForHost(input) {
  if (input === null || input === undefined || typeof input !== 'string') {
    return null;
  }

  let host;

  // If the string contains '/' or ':', treat it as a URL.
  if (input.indexOf('/') !== -1 || input.indexOf(':') !== -1) {
    let parsed;
    try {
      parsed = new URL(input);
    } catch (_) {
      return null;
    }
    // Must be https:
    if (parsed.protocol !== 'https:') {
      return null;
    }
    // Must have no username/password.
    if (parsed.username !== '' || parsed.password !== '') {
      return null;
    }
    host = parsed.hostname.toLowerCase();
  } else {
    host = input.toLowerCase();
  }

  // Match against each site's host (case-insensitive).
  for (const key of Object.keys(SITES)) {
    if (host === SITES[key].host.toLowerCase()) {
      return key;
    }
  }

  return null;
}

/**
 * Determine whether text indicates electronic delivery.
 * True iff text is a string containing the phrase
 *   "electronic delivery" or "delivery via email"
 * (case-insensitive) as a whole phrase:
 *   - not preceded by a word char or '-'
 *   - not followed by a word char
 * Non-string → false.
 */
function isElectronicDelivery(text) {
  if (typeof text !== 'string') {
    return false;
  }

  // Whole-phrase match: not preceded by word char or hyphen,
  // not followed by a word char.
  var pattern = /(?<![a-zA-Z0-9\-])(electronic delivery|delivery via email)(?![a-zA-Z0-9])/i;

  return pattern.test(text);
}

module.exports = { SITES: SITES, siteForHost: siteForHost, isElectronicDelivery: isElectronicDelivery };
