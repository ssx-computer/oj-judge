import { Hono } from 'hono';
import { AppType } from '../types';
import { authMiddleware, optionalAuthMiddleware } from '../middleware/auth';

const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const MAX_IMAGE_SIZE = 5 * 1024 * 1024; // 5MB
const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB
const SAFE_FILENAME_RE = /[^a-zA-Z0-9._-]/g;

// 校验图片文件真实内容(magic bytes),防止伪造 MIME 上传非图片/SVG 脚本
function verifyImageSignature(buffer: ArrayBuffer): boolean {
  const bytes = new Uint8Array(buffer.slice(0, 16));
  // JPEG: FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return true;
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return true;
  // GIF: 47 49 46 38 ("GIF8")
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return true;
  // WebP: "RIFF" .... "WEBP"
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return true;
  return false;
}

/**
 * Sanitize a filename to prevent path traversal and header injection.
 * Keeps only safe characters and limits length.
 */
function sanitizeFilename(name: string): string {
  // Remove path separators and control characters
  let safe = name.replace(/[/\\:*?"<>|]/g, '_').replace(/\0/g, '');
  // Remove any remaining unsafe characters
  safe = safe.replace(SAFE_FILENAME_RE, '_');
  // Limit length to prevent abuse
  if (safe.length > 200) {
    const ext = safe.lastIndexOf('.');
    if (ext > 0) {
      safe = safe.substring(0, 100) + safe.substring(ext);
    } else {
      safe = safe.substring(0, 200);
    }
  }
  return safe || 'unnamed';
}

/**
 * Escape a filename for use in Content-Disposition header value (quoted string).
 */
function escapeContentDispositionFilename(name: string): string {
  // RFC 5987: remove characters that cannot appear in a quoted string
  return name.replace(/["\\\r\n]/g, ' ').trim();
}

// Base64 encode that handles large buffers without stack overflow
function encodeBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunks: string[] = [];
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
    chunks.push(String.fromCharCode(...chunk));
  }
  return btoa(chunks.join(''));
}

const uploads = new Hono<AppType>();

// Upload image
uploads.post('/image', authMiddleware, async (c) => {
  const user = c.get('user');

  // Check if image upload is enabled (upload_admin and super admin can bypass)
  const hasUploadAdmin = user.role === 'admin' || user.role === 'super_admin' || user.userId === 1 || (user.permissions || []).includes('upload_admin');
  let imageUploadEnabled = true;
  try {
    const row: any = await c.env.DB.prepare("SELECT value FROM settings WHERE key = 'image_upload_enabled'").first();
    if (row && row.value === 'false') imageUploadEnabled = false;
  } catch { /* ignore */ }

  if (!imageUploadEnabled && !hasUploadAdmin) {
    return c.json({ success: false, error: { message: 'Image upload is disabled', code: 'FORBIDDEN' } }, 403);
  }

  const body = await c.req.parseBody();
  const file = body['file'];

  if (!file || !(file instanceof File)) {
    return c.json({ success: false, error: { message: 'No file provided', code: 'BAD_REQUEST' } }, 400);
  }

  if (!ALLOWED_IMAGE_TYPES.includes(file.type)) {
    return c.json({ success: false, error: { message: 'Invalid image type. Allowed: jpg, png, gif, webp', code: 'BAD_REQUEST' } }, 400);
  }

  if (file.size > MAX_IMAGE_SIZE) {
    return c.json({ success: false, error: { message: 'Image too large (max 5MB)', code: 'BAD_REQUEST' } }, 400);
  }

  // 校验文件真实内容(防止伪造 MIME 上传 SVG 等非白名单图片)
  const sigBuffer = await file.arrayBuffer();
  if (!verifyImageSignature(sigBuffer)) {
    return c.json({ success: false, error: { message: 'File content does not match an allowed image type', code: 'BAD_REQUEST' } }, 400);
  }

  const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const ext = file.name.split('.').pop() || 'png';
  const filename = `${dateStr}_${user.userId}.${ext}`;
  const githubPath = `uploads/image/${user.userId}/${filename}`;

  // Upload to GitHub
  const arrayBuffer = await file.arrayBuffer();
  const content = encodeBase64(arrayBuffer);

  const githubResponse = await fetch(
    `https://api.github.com/repos/${c.env.JUDGE_REPO}/contents/${githubPath}`,
    {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${c.env.GITHUB_TOKEN}`,
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'OJ-System',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        message: `Upload image: ${file.name}`,
        content,
      }),
    }
  );

  if (!githubResponse.ok) {
    const errText = await githubResponse.text();
    console.error('GitHub upload failed:', githubResponse.status, errText);
    return c.json({ success: false, error: { message: 'Failed to upload image', code: 'INTERNAL_ERROR' } }, 500);
  }

  // Save to database
  const result = await c.env.DB.prepare(
    'INSERT INTO uploads (user_id, filename, original_name, file_type, mime_type, size_bytes, github_path) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).bind(user.userId, filename, file.name, 'image', file.type, file.size, githubPath).run();

  const uploadId = result.meta.last_row_id;

  // Use proxy URL since GitHub repo is private
  const url = `/api/v1/uploads/download/${uploadId}`;

  return c.json({
    success: true,
    data: {
      id: uploadId,
      url,
      filename,
      original_name: file.name,
      file_type: 'image',
      size_bytes: file.size,
    },
  });
});

// Upload file
uploads.post('/file', authMiddleware, async (c) => {
  const user = c.get('user');

  // Check if file upload is enabled (upload_admin and super admin can bypass)
  const hasUploadAdmin = user.role === 'admin' || user.role === 'super_admin' || user.userId === 1 || (user.permissions || []).includes('upload_admin');
  let uploadEnabled = true;
  try {
    const row: any = await c.env.DB.prepare("SELECT value FROM settings WHERE key = 'upload_enabled'").first();
    if (row && row.value === 'false') uploadEnabled = false;
  } catch { /* ignore */ }

  if (!uploadEnabled && !hasUploadAdmin) {
    return c.json({ success: false, error: { message: 'File upload is disabled', code: 'FORBIDDEN' } }, 403);
  }

  const body = await c.req.parseBody();
  const file = body['file'];
  // 是否公开(默认公开,保持与已上传文件一致);false/0 表示私有,仅本人或 upload_admin 可下载
  const isPublic = body['is_public'] === undefined ? 1 : (body['is_public'] === 'false' || body['is_public'] === '0' ? 0 : 1);

  if (!file || !(file instanceof File)) {
    return c.json({ success: false, error: { message: 'No file provided', code: 'BAD_REQUEST' } }, 400);
  }

  if (file.size > MAX_FILE_SIZE) {
    return c.json({ success: false, error: { message: 'File too large (max 20MB)', code: 'BAD_REQUEST' } }, 400);
  }

  const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const ext = file.name.split('.').pop() || 'bin';
  const filename = `${dateStr}_${user.userId}.${ext}`;
  const githubPath = `uploads/file/${user.userId}/${filename}`;

  // Upload to GitHub
  const arrayBuffer = await file.arrayBuffer();
  const content = encodeBase64(arrayBuffer);

  const githubResponse = await fetch(
    `https://api.github.com/repos/${c.env.JUDGE_REPO}/contents/${githubPath}`,
    {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${c.env.GITHUB_TOKEN}`,
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'OJ-System',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        message: `Upload file: ${file.name}`,
        content,
      }),
    }
  );

  if (!githubResponse.ok) {
    const errText = await githubResponse.text();
    console.error('GitHub upload failed:', githubResponse.status, errText);
    return c.json({ success: false, error: { message: 'Failed to upload file', code: 'INTERNAL_ERROR' } }, 500);
  }

  const result = await c.env.DB.prepare(
    'INSERT INTO uploads (user_id, filename, original_name, file_type, mime_type, size_bytes, github_path, is_public) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(user.userId, filename, file.name, 'file', file.type, file.size, githubPath, isPublic).run();

  const uploadId = result.meta.last_row_id;

  // Use proxy URL since GitHub repo is private
  const url = `/api/v1/uploads/download/${uploadId}`;

  return c.json({
    success: true,
    data: {
      id: uploadId,
      url,
      filename,
      original_name: file.name,
      file_type: 'file',
      size_bytes: file.size,
      is_public: isPublic,
    },
  });
});

// List uploads
uploads.get('/', authMiddleware, async (c) => {
  const user = c.get('user');
  const page = Math.max(1, parseInt(c.req.query('page') || '1'));
  const pageSize = Math.min(50, Math.max(1, parseInt(c.req.query('pageSize') || '20')));
  const fileType = c.req.query('type') || '';
  const offset = (page - 1) * pageSize;

  // Check if user has upload_admin permission
  const hasUploadAdmin = user.role === 'admin' || user.role === 'super_admin' || user.userId === 1 || (user.permissions || []).includes('upload_admin');

  let countQuery = 'SELECT COUNT(*) as total FROM uploads u';
  let dataQuery = 'SELECT u.*, us.username FROM uploads u JOIN users us ON u.user_id = us.id';
  const binds: any[] = [];
  const countBinds: any[] = [];

  if (!hasUploadAdmin) {
    countQuery += ' WHERE u.user_id = ?';
    dataQuery += ' WHERE u.user_id = ?';
    binds.push(user.userId);
    countBinds.push(user.userId);
  }

  if (fileType) {
    const prefix = hasUploadAdmin && binds.length === 0 ? ' WHERE' : ' AND';
    countQuery += `${prefix} u.file_type = ?`;
    dataQuery += `${prefix} u.file_type = ?`;
    binds.push(fileType);
    countBinds.push(fileType);
  }

  dataQuery += ' ORDER BY u.created_at DESC LIMIT ? OFFSET ?';

  const countResult = await c.env.DB.prepare(countQuery).bind(...countBinds).first();
  const total = (countResult as any)?.total || 0;

  const results = await c.env.DB.prepare(dataQuery).bind(...binds, pageSize, offset).all();

  // Add proxy URL to each result (GitHub repo is private)
  const uploadsWithUrl = results.results.map((r: any) => ({
    ...r,
    url: `/api/v1/uploads/download/${r.id}`,
  }));

  return c.json({
    success: true,
    data: {
      uploads: uploadsWithUrl,
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.ceil(total / pageSize),
      },
    },
  });
});

// Proxy file download (needed because GitHub repo is private)
// 公开文件(is_public=1 或图片)任何人可下载;私有文件(is_public=0 且 file 类型)仅本人或 upload_admin 可下载
uploads.get('/download/:id', optionalAuthMiddleware, async (c) => {
  const uploadId = parseInt(c.req.param('id') || '0');

  const upload: any = await c.env.DB.prepare('SELECT * FROM uploads WHERE id = ?').bind(uploadId).first();
  if (!upload) {
    return c.json({ success: false, error: { message: 'File not found', code: 'NOT_FOUND' } }, 404);
  }

  // 私有文件鉴权:非公开的 file 类型仅上传者本人或 upload_admin 可下载
  if (upload.is_public !== 1 && upload.file_type !== 'image') {
    const user = c.get('user');
    const isUploadAdmin = user && (user.role === 'admin' || user.role === 'super_admin' || user.userId === 1
      || (Array.isArray(user?.permissions) && user.permissions.includes('upload_admin')));
    if (!user || (upload.user_id !== user.userId && !isUploadAdmin)) {
      return c.json({ success: false, error: { message: 'Forbidden: file is private', code: 'FORBIDDEN' } }, 403);
    }
  }

  try {
    const response = await fetch(
      `https://api.github.com/repos/${c.env.JUDGE_REPO}/contents/${upload.github_path}`,
      {
        headers: {
          Authorization: `Bearer ${c.env.GITHUB_TOKEN}`,
          Accept: 'application/vnd.github.v3.raw',
          'User-Agent': 'OJ-System',
        },
      }
    );

    if (!response.ok) {
      return c.json({ success: false, error: { message: 'Failed to download file', code: 'INTERNAL_ERROR' } }, 500);
    }

    const data = await response.arrayBuffer();
    c.header('Content-Type', upload.mime_type || 'application/octet-stream');
    c.header('Cache-Control', 'public, max-age=86400');
    c.header('Content-Disposition', `inline; filename="${escapeContentDispositionFilename(upload.original_name)}"`);
    return c.body(data);
  } catch (e) {
    console.error('GitHub download failed:', e);
    return c.json({ success: false, error: { message: 'Failed to download file', code: 'INTERNAL_ERROR' } }, 500);
  }
});

// Delete upload
uploads.delete('/:id', authMiddleware, async (c) => {
  const user = c.get('user');
  const uploadId = parseInt(c.req.param('id') || '0');

  const upload: any = await c.env.DB.prepare('SELECT * FROM uploads WHERE id = ?').bind(uploadId).first();
  if (!upload) {
    return c.json({ success: false, error: { message: 'File not found', code: 'NOT_FOUND' } }, 404);
  }

  const hasUploadAdmin = user.role === 'admin' || user.role === 'super_admin' || user.userId === 1 || (user.permissions || []).includes('upload_admin');
  if (upload.user_id !== user.userId && !hasUploadAdmin) {
    return c.json({ success: false, error: { message: 'Forbidden: cannot delete others\' files', code: 'FORBIDDEN' } }, 403);
  }

  // Delete from GitHub
  try {
    const currentFile = await fetch(
      `https://api.github.com/repos/${c.env.JUDGE_REPO}/contents/${upload.github_path}`,
      {
        headers: {
          Authorization: `Bearer ${c.env.GITHUB_TOKEN}`,
          Accept: 'application/vnd.github.v3+json',
          'User-Agent': 'OJ-System',
        },
      }
    );

    if (currentFile.ok) {
      const fileData = await currentFile.json() as any;
      await fetch(
        `https://api.github.com/repos/${c.env.JUDGE_REPO}/contents/${upload.github_path}`,
        {
          method: 'DELETE',
          headers: {
            Authorization: `Bearer ${c.env.GITHUB_TOKEN}`,
            Accept: 'application/vnd.github.v3+json',
            'User-Agent': 'OJ-System',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            message: `Delete file: ${upload.original_name}`,
            sha: fileData.sha,
          }),
        }
      );
    }
  } catch (e) {
    console.error('GitHub delete failed:', e);
  }

  // Delete from database
  await c.env.DB.prepare('DELETE FROM uploads WHERE id = ?').bind(uploadId).run();

  return c.json({ success: true, data: { message: 'File deleted' } });
});

export default uploads;

// Avatar upload endpoint (reuses image upload logic)
uploads.post('/avatar', authMiddleware, async (c) => {
  const user = c.get('user');
  const formData = await c.req.formData();
  const file = formData.get('file') as File | null;

  if (!file) {
    return c.json({ success: false, error: { message: 'No file uploaded', code: 'BAD_REQUEST' } }, 400);
  }

  if (!ALLOWED_IMAGE_TYPES.includes(file.type)) {
    return c.json({ success: false, error: { message: 'Invalid image type. Allowed: JPEG, PNG, GIF, WebP', code: 'BAD_REQUEST' } }, 400);
  }

  if (file.size > MAX_IMAGE_SIZE) {
    return c.json({ success: false, error: { message: 'Image too large. Max 5MB', code: 'BAD_REQUEST' } }, 400);
  }

  // 校验文件真实内容(防止伪造 MIME 上传 SVG 等非白名单图片)
  const buffer = await file.arrayBuffer();
  if (!verifyImageSignature(buffer)) {
    return c.json({ success: false, error: { message: 'File content does not match an allowed image type', code: 'BAD_REQUEST' } }, 400);
  }

  const base64 = encodeBase64(buffer);
  const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const ext = file.name.split('.').pop() || 'png';
  const filename = `avatars/${dateStr}_${user.userId}.${ext}`;

  // Save to GitHub (same as image upload)
  try {
    const githubResponse = await fetch(
      `https://api.github.com/repos/${c.env.JUDGE_REPO}/contents/${filename}`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${c.env.GITHUB_TOKEN}`,
          'User-Agent': 'OJ-System',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          message: `Upload avatar for user ${user.userId}`,
          content: base64,
        }),
      }
    );

    if (!githubResponse.ok) {
      const err = await githubResponse.json();
      console.error('GitHub upload error:', err);
      return c.json({ success: false, error: { message: 'Failed to upload avatar', code: 'INTERNAL_ERROR' } }, 500);
    }

    const githubData = (await githubResponse.json()) as { content: { download_url: string } };
    const avatarUrl = githubData.content.download_url;

    // Update user's avatar_url
    await c.env.DB.prepare('UPDATE users SET avatar_url = ? WHERE id = ?').bind(avatarUrl, user.userId).run();

    return c.json({ success: true, data: { avatar_url: avatarUrl, message: 'Avatar updated' } });
  } catch (e) {
    console.error('Avatar upload error:', e);
    return c.json({ success: false, error: { message: 'Failed to upload avatar', code: 'INTERNAL_ERROR' } }, 500);
  }
});
