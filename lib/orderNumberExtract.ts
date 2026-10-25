function extractOrderNumbers(texts: string[]): string[] {
  const results: string[] = [];
  const seen = new Set<string>();

  for (const text of texts) {
    // Amazon style: \b\d{3}-\d{7}-\d{7}\b
    const amazonMatch = text.match(/\b(\d{3}-\d{7}-\d{7})\b/);
    if (amazonMatch && !seen.has(amazonMatch[1])) {
      seen.add(amazonMatch[1]);
      results.push(amazonMatch[1]);
    }

    // Labeled style: "order" (case-insensitive) optionally followed by "#", "no.", "number" or ":", then a token of 4+ chars
    const labeledMatch = text.match(/order\s*(?:#|no\.?|number)?\s*:?\s*#?\s*([A-Za-z0-9\-]{4,})/i);
    if (labeledMatch) {
      const token = labeledMatch[1];
      // Must contain at least one digit
      if (/\d/.test(token)) {
        const normalized = token.replace(/[\s-]/g, '');
        if (!seen.has(normalized)) {
          seen.add(normalized);
          results.push(token);
        }
      }
    }
  }

  return results;
}

function normalize(s: string): string {
  return s.replace(/[\s\-]/g, '').toUpperCase();
}

function pickOrderForNumbers(candidates: string[], orders: {id:number, orderNumber:string|null}[]): number|null {
  const normalizedCandidates = candidates.map(normalize).filter(n => n.length > 0);
  if (normalizedCandidates.length === 0) return null;

  const matchedIds = new Set<number>();

  for (const candidate of normalizedCandidates) {
    for (const order of orders) {
      if (order.orderNumber == null) continue;
      const normalizedOrder = normalize(order.orderNumber);
      if (normalizedOrder.length === 0) continue;
      if (normalizedOrder === candidate) {
        matchedIds.add(order.id);
      }
    }
  }

  if (matchedIds.size === 1) {
    return [...matchedIds][0];
  }

  return null;
}

export { extractOrderNumbers, pickOrderForNumbers };
