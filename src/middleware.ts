/**
 * DevTools Platform — Astro Edge Content Rewriting Middleware
 *
 * For Astro sites on Cloudflare Pages, add this to your existing
 * src/middleware.ts file. If you don't have one, create it.
 *
 * IMPORTANT: Astro generates a _worker.js file which causes Cloudflare
 * to ignore the functions/ directory entirely. That's why this middleware
 * must be integrated into Astro's own middleware system instead of using
 * functions/_middleware.ts.
 *
 * Configure the two constants below, deploy, and you're done.
 */

import { defineMiddleware, sequence } from 'astro:middleware';

// ============================================================
// CONFIGURATION
// ============================================================
const DEVTOOLS_PROJECT_KEY = 'proj_em8foyyu';
const DEVTOOLS_PLATFORM_URL = 'https://devtools.prairiegiraffe.com';
const CACHE_TTL_SECONDS = 300; // 5 minutes

// ============================================================
// TYPES
// ============================================================

interface ContentOverride {
  selector: string;
  type: string;
  value: any;
}

// ============================================================
// OVERRIDE FETCHING (WITH EDGE CACHING)
// ============================================================

async function fetchOverrides(pagePath: string): Promise<ContentOverride[]> {
  try {
    const apiUrl = `${DEVTOOLS_PLATFORM_URL}/api/projects/${DEVTOOLS_PROJECT_KEY}/content?page=${encodeURIComponent(pagePath)}`;
    const response = await fetch(apiUrl, {
      cf: { cacheTtl: CACHE_TTL_SECONDS, cacheEverything: true },
    } as RequestInit);
    if (!response.ok) return [];
    const data: any = await response.json();
    if (!data.success || !data.data?.overrides?.length) return [];
    return data.data.overrides;
  } catch {
    return [];
  }
}

// ============================================================
// STYLE RULE GENERATION
// ============================================================

function buildStyleRules(overrides: ContentOverride[]): string {
  const rules: string[] = [];

  for (const override of overrides) {
    switch (override.type) {
      case 'css':
        if (typeof override.value === 'object' && override.value !== null) {
          const decls = Object.entries(override.value)
            .map(([prop, val]) => `${prop}: ${val} !important`)
            .join('; ');
          rules.push(`${override.selector} { ${decls}; }`);
        }
        break;

      case 'background':
        rules.push(
          `${override.selector} { background-image: url(${override.value}) !important; }`,
        );
        break;

      case 'image':
        rules.push(
          `${override.selector}:not(img) { background-image: url(${override.value}) !important; }`,
        );
        break;
    }
  }

  return rules.join('\n');
}

// ============================================================
// HELPERS
// ============================================================

function isDataContentSelector(selector: string): boolean {
  return /^\[data-content=/.test(selector);
}

function isComplexSelector(selector: string): boolean {
  return /[>+~ ]|:nth|:not|:first|:last|:has/.test(selector);
}

// ============================================================
// HTML STRING REWRITING (for Astro middleware)
// ============================================================

/**
 * Since Astro middleware works with Response objects (not HTMLRewriter),
 * we read the full HTML string and do text-based replacements.
 *
 * For [data-content] selectors, we find matching elements and replace
 * their inner content. For style injection, we append to <head>.
 */
function rewriteHtml(html: string, overrides: ContentOverride[]): string {
  let result = html;
  let hasClientFallback = false;

  // Build style block
  const styleContent = buildStyleRules(overrides);

  for (const override of overrides) {
    if (override.type === 'move') {
      hasClientFallback = true;
      continue;
    }

    if (override.type === 'css' || override.type === 'background') {
      continue; // Handled via style injection
    }

    if (override.type === 'image' && isDataContentSelector(override.selector)) {
      // Extract the data-content value from the selector
      const match = override.selector.match(/\[data-content=["']?([^"'\]]+)["']?\]/);
      if (match) {
        const key = match[1];
        // Replace src attribute on matching img elements
        const imgRegex = new RegExp(
          `(<(?:img)\\s[^>]*data-content=["']${escapeRegex(key)}["'][^>]*\\s)src=["'][^"']*["']`,
          'gi'
        );
        result = result.replace(imgRegex, `$1src="${escapeHtml(override.value)}"`);
        // Also remove srcset if present
        const srcsetRegex = new RegExp(
          `(<(?:img)\\s[^>]*data-content=["']${escapeRegex(key)}["'][^>]*)\\s+srcset=["'][^"']*["']`,
          'gi'
        );
        result = result.replace(srcsetRegex, '$1');
      }
      continue;
    }

    if (override.type === 'text' || override.type === 'html') {
      if (isDataContentSelector(override.selector)) {
        const match = override.selector.match(/\[data-content=["']?([^"'\]]+)["']?\]/);
        if (match) {
          const key = match[1];
          const value = override.type === 'text' ? escapeHtml(override.value) : override.value;
          // Replace inner content of elements with matching data-content attribute
          // Matches: <tag data-content="key" ...>old content</tag>
          const regex = new RegExp(
            `(<[a-z][a-z0-9]*\\s[^>]*data-content=["']${escapeRegex(key)}["'][^>]*>)([\\s\\S]*?)(<\\/[a-z][a-z0-9]*>)`,
            'gi'
          );
          result = result.replace(regex, `$1${value}$3`);
        }
      } else if (isComplexSelector(override.selector)) {
        hasClientFallback = true;
      }
      // Simple selectors (.class, #id) are hard to reliably match via regex,
      // so we let embed.js handle them via client fallback
    }
  }

  // Inject meta tag + style block into <head>
  const metaTags = '<meta name="devtools-edge-rewrite" content="true">\n' +
    (hasClientFallback ? '<meta name="devtools-edge-partial" content="true">\n' : '');
  const styleTag = styleContent ? `<style data-devtools-overrides>\n${styleContent}\n</style>\n` : '';

  result = result.replace('</head>', `${metaTags}${styleTag}</head>`);

  return result;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ============================================================
// DEVTOOLS MIDDLEWARE
// ============================================================

const devtoolsMiddleware = defineMiddleware(async (context, next) => {
  const response = await next();

  // Only rewrite HTML responses
  const contentType = response.headers.get('Content-Type') || '';
  if (!contentType.includes('text/html')) {
    return response;
  }

  const pagePath = context.url.pathname;

  // Fetch overrides (cached at edge)
  const overrides = await fetchOverrides(pagePath);
  if (!overrides.length) return response;

  // Read the HTML, rewrite it, return a new response
  const html = await response.text();
  const rewritten = rewriteHtml(html, overrides);

  return new Response(rewritten, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
});

// ============================================================
// EXPORT
// ============================================================

export const onRequest = devtoolsMiddleware;
