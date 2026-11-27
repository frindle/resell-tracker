// The checked-in config, validated once when first imported (a deploy ships a
// new file, so it never changes while the server runs). Imported as JSON so the
// standalone build bundles it; not covered by the node tests (the '@/' alias).
import raw from '@/config/scrape-config.json';
import { loadScrapeConfig } from '@/lib/scrapeConfig';

export const loadedScrapeConfig = loadScrapeConfig(raw);

/** The version the commands poll advertises, or null when the file is invalid. */
export const scrapeConfigVersion: number | null = loadedScrapeConfig.ok ? loadedScrapeConfig.config.version : null;
