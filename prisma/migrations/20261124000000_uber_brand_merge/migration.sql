-- Uber and Uber Eats gift cards are the same card: store one brand name.
-- Matches lib/giftBrand.ts canonicalGiftBrand, which new and edited cards go through.
UPDATE "GiftCard" SET "merchant" = 'Uber Eats'
WHERE lower(trim("merchant")) IN ('uber', 'uber eats', 'ubereats', 'uber gift card', 'uber eats gift card', 'uber gc', 'uber eats gc');
