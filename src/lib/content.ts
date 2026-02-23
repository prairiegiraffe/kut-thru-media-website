import contentData from '../data/content.json';

type ContentData = {
  version: number;
  lastModified: string;
  pages: Record<string, Record<string, string>>;
};

/**
 * Returns a content getter for a specific page.
 * Reads overrides from content.json, falls back to the provided default.
 *
 * Usage:
 *   const c = getContent('index');
 *   c('hero-bg', 'https://fallback-url.com/image.jpg')
 */
export function getContent(page: string) {
  const data = contentData as ContentData;
  const pageData = data.pages?.[page] || {};
  return (key: string, fallback: string): string => pageData[key] ?? fallback;
}
