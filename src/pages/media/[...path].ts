import type { APIRoute } from 'astro';

export const GET: APIRoute = async ({ params, locals }) => {
  const path = params.path;
  if (!path) {
    return new Response('Not found', { status: 404 });
  }

  const env = (locals as any).runtime?.env;
  if (!env?.STORAGE) {
    return new Response('Storage not configured', { status: 500 });
  }

  const object = await env.STORAGE.get(path);
  if (!object) {
    return new Response('Not found', { status: 404 });
  }

  const headers = new Headers();
  headers.set('Content-Type', object.httpMetadata?.contentType || 'application/octet-stream');
  headers.set('Cache-Control', 'public, max-age=31536000, immutable');

  return new Response(object.body, { headers });
};
