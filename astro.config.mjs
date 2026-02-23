// @ts-check
import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';
import { readdir, stat, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, relative, extname } from 'node:path';

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.svg', '.gif', '.avif']);

/** Vite plugin that serves editor API routes during dev */
function editorApiPlugin() {
  return {
    name: 'editor-api',
    configureServer(server) {
      // GET /api/images — scan image folders
      server.middlewares.use('/api/images', async (req, res) => {
        if (req.method !== 'GET') { res.statusCode = 405; res.end(); return; }
        try {
          const folders = await scanImages(join(process.cwd(), 'public', 'assets', 'images'), '/assets/images');
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ folders }));
        } catch (e) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: String(e) }));
        }
      });

      // GET/POST /api/content — read/write content.json
      server.middlewares.use('/api/content', async (req, res) => {
        const contentPath = join(process.cwd(), 'src', 'data', 'content.json');
        if (req.method === 'GET') {
          try {
            const raw = await readFile(contentPath, 'utf-8');
            res.setHeader('Content-Type', 'application/json');
            res.end(raw);
          } catch {
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ version: 1, lastModified: '', pages: {} }));
          }
        } else if (req.method === 'POST') {
          let body = '';
          req.on('data', chunk => body += chunk);
          req.on('end', async () => {
            try {
              const data = JSON.parse(body);
              data.lastModified = new Date().toISOString();
              await writeFile(contentPath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ success: true }));
            } catch (e) {
              res.statusCode = 500;
              res.end(JSON.stringify({ error: String(e) }));
            }
          });
        } else {
          res.statusCode = 405; res.end();
        }
      });

      // POST /api/upload — upload images
      server.middlewares.use('/api/upload', async (req, res) => {
        if (req.method !== 'POST') { res.statusCode = 405; res.end(); return; }
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', async () => {
          try {
            const buffer = Buffer.concat(chunks);
            const boundary = req.headers['content-type']?.split('boundary=')[1];
            if (!boundary) { res.statusCode = 400; res.end(JSON.stringify({ error: 'No boundary' })); return; }

            // Simple multipart parser
            const parts = parseMultipart(buffer, boundary);
            const filePart = parts.find(p => p.name === 'file');
            const folderPart = parts.find(p => p.name === 'folder');

            if (!filePart || !filePart.filename) {
              res.statusCode = 400;
              res.end(JSON.stringify({ error: 'No file provided' }));
              return;
            }

            const ext = extname(filePart.filename).toLowerCase();
            const baseName = filePart.filename.replace(ext, '')
              .replace(/[^a-zA-Z0-9_-]/g, '-').replace(/-+/g, '-').toLowerCase();
            const filename = baseName + ext;
            const subfolder = folderPart?.data?.toString()?.trim() || '';
            const uploadDir = join(process.cwd(), 'public', 'assets', 'images', 'client');
            const targetDir = subfolder ? join(uploadDir, subfolder) : uploadDir;
            await mkdir(targetDir, { recursive: true });
            await writeFile(join(targetDir, filename), filePart.data);
            const webPath = subfolder
              ? `/assets/images/client/${subfolder}/${filename}`
              : `/assets/images/client/${filename}`;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ success: true, path: webPath, filename }));
          } catch (e) {
            res.statusCode = 500;
            res.end(JSON.stringify({ error: String(e) }));
          }
        });
      });
    }
  };
}

async function scanImages(dir, webPrefix) {
  const folders = [];
  async function walk(currentDir, folderName) {
    let entries;
    try { entries = await readdir(currentDir, { withFileTypes: true }); } catch { return; }
    const images = [];
    for (const entry of entries) {
      const fullPath = join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath, folderName ? `${folderName}/${entry.name}` : entry.name);
      } else if (entry.isFile() && IMAGE_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
        const relativePath = relative(dir, fullPath);
        const fileInfo = await stat(fullPath);
        images.push({ filename: entry.name, path: `${webPrefix}/${relativePath}`, size: fileInfo.size });
      }
    }
    if (images.length > 0) folders.push({ name: folderName || '(root)', images });
  }
  await walk(dir, '');
  folders.sort((a, b) => a.name.localeCompare(b.name));
  return folders;
}

function parseMultipart(buffer, boundary) {
  const parts = [];
  const boundaryBuf = Buffer.from('--' + boundary);
  let pos = 0;
  while (pos < buffer.length) {
    const start = buffer.indexOf(boundaryBuf, pos);
    if (start === -1) break;
    const end = buffer.indexOf(boundaryBuf, start + boundaryBuf.length);
    if (end === -1) break;
    const part = buffer.slice(start + boundaryBuf.length, end);
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd === -1) { pos = end; continue; }
    const headerStr = part.slice(0, headerEnd).toString();
    const data = part.slice(headerEnd + 4, part.length - 2); // trim trailing \r\n
    const nameMatch = headerStr.match(/name="([^"]+)"/);
    const filenameMatch = headerStr.match(/filename="([^"]+)"/);
    if (nameMatch) {
      parts.push({ name: nameMatch[1], filename: filenameMatch?.[1], data });
    }
    pos = end;
  }
  return parts;
}

// https://astro.build/config
export default defineConfig({
  vite: {
    plugins: [tailwindcss(), editorApiPlugin()]
  }
});
