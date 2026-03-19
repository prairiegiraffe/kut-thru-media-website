import type { APIRoute } from 'astro';

export const GET: APIRoute = async ({ params, request, locals }) => {
  const path = params.path;
  if (!path) {
    return new Response('Not found', { status: 404 });
  }

  const env = (locals as any).runtime?.env;
  if (!env?.STORAGE) {
    return new Response('Storage not configured', { status: 500 });
  }

  const range = request.headers.get('Range');

  // For range requests, use R2's built-in range support
  const object = await env.STORAGE.get(path, range ? {
    range: { suffix: undefined, offset: undefined, length: undefined, ...parseRange(range) },
  } : undefined);

  if (!object) {
    return new Response('Not found', { status: 404 });
  }

  const headers = new Headers();
  const contentType = object.httpMetadata?.contentType || 'application/octet-stream';
  headers.set('Content-Type', contentType);
  headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  headers.set('Accept-Ranges', 'bytes');

  if (range && object.range) {
    const r = object.range as { offset: number; length: number };
    const size = object.size;
    headers.set('Content-Range', `bytes ${r.offset}-${r.offset + r.length - 1}/${size}`);
    headers.set('Content-Length', String(r.length));
    return new Response(object.body, { status: 206, headers });
  }

  headers.set('Content-Length', String(object.size));
  return new Response(object.body, { headers });
};

function parseRange(range: string): { offset: number; length?: number } | undefined {
  const match = range.match(/bytes=(\d+)-(\d*)/);
  if (!match) return undefined;
  const offset = parseInt(match[1], 10);
  if (match[2]) {
    const end = parseInt(match[2], 10);
    return { offset, length: end - offset + 1 };
  }
  return { offset };
}
