/**
 * DevTools Platform — Edge Content Rewriting Middleware
 *
 * Drop this file into your Cloudflare Pages project at:
 *   functions/_middleware.ts
 *
 * It intercepts HTML responses at the edge, fetches published content
 * overrides from the DevTools Platform API, and rewrites the HTML before
 * it reaches the browser. This eliminates flash of original content and
 * ensures search engines see the updated content.
 *
 * Configure the two constants below, deploy, and you're done.
 */

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

interface StyleRule {
  selector: string;
  declarations: string;
}

// ============================================================
// HTMLRewriter HANDLERS
// ============================================================

/** Replaces text content of matched elements */
class TextHandler implements HTMLRewriterElementContentHandlers {
  constructor(private value: string) {}
  element(element: Element) {
    element.setInnerContent(this.value, { html: false });
  }
}

/** Replaces inner HTML of matched elements */
class HtmlHandler implements HTMLRewriterElementContentHandlers {
  constructor(private value: string) {}
  element(element: Element) {
    element.setInnerContent(this.value, { html: true });
  }
}

/** Sets src attribute on <img> elements */
class ImageSrcHandler implements HTMLRewriterElementContentHandlers {
  constructor(private value: string) {}
  element(element: Element) {
    if (element.tagName === 'img') {
      element.setAttribute('src', this.value);
      element.removeAttribute('srcset');
    }
  }
}

/** Injects meta tags and style block into <head> */
class HeadHandler implements HTMLRewriterElementContentHandlers {
  constructor(
    private styleContent: string,
    private hasClientFallback: boolean,
  ) {}
  element(element: Element) {
    // Signal to embed.js that edge rewriting is active
    element.prepend('<meta name="devtools-edge-rewrite" content="true">', {
      html: true,
    });

    // If some overrides need client-side handling (moves, complex selectors),
    // tell embed.js to still run for those
    if (this.hasClientFallback) {
      element.prepend('<meta name="devtools-edge-partial" content="true">', {
        html: true,
      });
    }

    // Inject CSS overrides as a <style> tag
    if (this.styleContent) {
      element.append(
        `<style data-devtools-overrides>\n${this.styleContent}\n</style>`,
        { html: true },
      );
    }
  }
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
        // For non-img elements, apply as background-image via CSS.
        // The :not(img) prevents this from affecting <img> tags (handled by ImageSrcHandler).
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

/** Check if a selector is a simple [data-content="..."] attribute selector */
function isDataContentSelector(selector: string): boolean {
  return /^\[data-content=/.test(selector);
}

/**
 * Check if a selector uses features that HTMLRewriter cannot handle.
 * HTMLRewriter supports: tag, .class, #id, [attr], [attr="val"]
 * It does NOT support: combinators (>, +, ~, space), :nth-of-type, :not(), etc.
 */
function isComplexSelector(selector: string): boolean {
  return /[>+~ ]|:nth|:not|:first|:last|:has/.test(selector);
}

// ============================================================
// MAIN MIDDLEWARE
// ============================================================

export const onRequest: PagesFunction = async (context) => {
  const response = await context.next();

  // Only rewrite HTML responses
  const contentType = response.headers.get('Content-Type') || '';
  if (!contentType.includes('text/html')) {
    return response;
  }

  // Determine the page path
  const url = new URL(context.request.url);
  const pagePath = url.pathname;

  // Fetch overrides (cached at edge)
  const overrides = await fetchOverrides(pagePath);
  if (!overrides.length) return response;

  // Classify overrides
  let hasClientFallback = false;

  // Build style rules (handles css, background, and image-as-background)
  const styleContent = buildStyleRules(overrides);

  // Build HTMLRewriter chain
  let rewriter = new HTMLRewriter();

  // Register per-element handlers for data-content overrides
  for (const override of overrides) {
    if (override.type === 'move') {
      hasClientFallback = true;
      continue;
    }

    if (override.type === 'css' || override.type === 'background') {
      // Handled via style injection — already in styleContent
      continue;
    }

    if (override.type === 'image') {
      // Style injection covers the background-image case for all selectors.
      // For <img> elements with [data-content], also set the src attribute.
      if (isDataContentSelector(override.selector)) {
        rewriter = rewriter.on(
          override.selector,
          new ImageSrcHandler(override.value as string),
        );
      }
      continue;
    }

    // text and html overrides
    if (override.type === 'text' || override.type === 'html') {
      if (isDataContentSelector(override.selector)) {
        const Handler =
          override.type === 'text' ? TextHandler : HtmlHandler;
        rewriter = rewriter.on(
          override.selector,
          new Handler(override.value as string),
        );
      } else if (isComplexSelector(override.selector)) {
        // Complex selector — cannot handle at edge, let embed.js do it
        hasClientFallback = true;
      } else {
        // Simple selector (e.g., #id, .class) — HTMLRewriter can handle it
        const Handler =
          override.type === 'text' ? TextHandler : HtmlHandler;
        rewriter = rewriter.on(
          override.selector,
          new Handler(override.value as string),
        );
      }
    }
  }

  // Head handler: inject meta tags + style block
  rewriter = rewriter.on(
    'head',
    new HeadHandler(styleContent, hasClientFallback),
  );

  return rewriter.transform(response);
};
