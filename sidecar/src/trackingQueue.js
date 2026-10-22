'use strict'
// Plans which tracking-page URLs to visit next. Pure: no browser, no network.
// seed: URLs found on the order page. discovered: URLs found on a visited track page.
// visited: Set of URLs already fetched. cap: max total pages allowed.
function planTrackingVisits(seed, discovered, visited, cap) {
  const seeds = Array.isArray(seed) ? seed : []
  const disc = Array.isArray(discovered) ? discovered : []

  // Filter out non-string or empty entries
  const validSeeds = seeds.filter(u => typeof u === 'string' && u.length > 0)
  const validDisc = disc.filter(u => typeof u === 'string' && u.length > 0)

  // Build candidates: seed first, then discovered
  const seen = new Set(visited)
  const result = []

  for (const url of validSeeds) {
    if (!seen.has(url)) {
      seen.add(url)
      result.push(url)
    }
  }
  for (const url of validDisc) {
    if (!seen.has(url)) {
      seen.add(url)
      result.push(url)
    }
  }

  // Respect cap
  const maxNew = Math.max(0, cap - visited.size)
  return result.slice(0, maxNew)
}

module.exports = { planTrackingVisits }
