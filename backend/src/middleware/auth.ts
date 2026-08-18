import { Context, Next } from 'hono';
import { AppType } from '../types';

export async function authMiddleware(c: Context<AppType>, next: Next) {
  const authHeader = c.req.header('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ success: false, error: { message: 'Unauthorized', code: 'UNAUTHORIZED' } }, 401);
  }

  const token = authHeader.slice(7);
  const { verifyJWT } = await import('../utils/jwt');
  const payload = await verifyJWT(token, c.env.JWT_SECRET, (c.env as any).JWT_SECRET_PREVIOUS);
  if (!payload) {
    return c.json({ success: false, error: { message: 'Invalid or expired token', code: 'UNAUTHORIZED' } }, 401);
  }

  // Check if user is banned (DB lookup, super admin id=1 is exempt)
  if (payload.userId !== 1) {
    try {
      const row: any = await c.env.DB.prepare('SELECT banned FROM users WHERE id = ?').bind(payload.userId).first();
      if (row && row.banned === 1) {
        return c.json({ success: false, error: { message: 'Account banned', code: 'ACCOUNT_BANNED' } }, 403);
      }
    } catch {
      // If DB lookup fails (e.g. column missing during migration), continue gracefully
    }
  }

  c.set('user', payload);
  await next();
}

// 可选鉴权:有有效 token 则解析用户并写入 c.get('user'),无 token 或 token 无效则放行(不 401)。
// 用于公开接口中需要区分「已登录用户」与「游客」的场景(如比赛详情返回 is_registered)。
export async function optionalAuthMiddleware(c: Context<AppType>, next: Next) {
  const authHeader = c.req.header('Authorization');
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    const { verifyJWT } = await import('../utils/jwt');
    const payload = await verifyJWT(token, c.env.JWT_SECRET, (c.env as any).JWT_SECRET_PREVIOUS);
    if (payload) {
      c.set('user', payload);
    }
  }
  await next();
}

export async function adminMiddleware(c: Context<AppType>, next: Next) {
  const user = c.get('user');
  if (!user || (user.role !== 'admin' && user.role !== 'super_admin' && user.userId !== 1)) {
    return c.json({ success: false, error: { message: 'Forbidden: admin only', code: 'FORBIDDEN' } }, 403);
  }
  await next();
}

export async function superAdminMiddleware(c: Context<AppType>, next: Next) {
  const user = c.get('user');
  if (!user || user.userId !== 1) {
    return c.json({ success: false, error: { message: 'Forbidden: super admin only', code: 'FORBIDDEN' } }, 403);
  }
  await next();
}

// Check if user has admin-level access (admin role or super admin)
export function isAdmin(user: any): boolean {
  if (!user) return false;
  return user.userId === 1 || user.role === 'admin' || user.role === 'super_admin';
}

// Check if user has a specific permission
function hasPermission(user: any, permission: string): boolean {
  // Super admin (user id=1) always has all permissions
  if (user.userId === 1) return true;
  // Admin/super_admin role has all permissions
  if (user.role === 'admin' || user.role === 'super_admin') return true;
  // Check specific permissions
  const permissions: string[] = user.permissions || [];
  return permissions.includes(permission);
}

// Permission middleware factories
export function permissionMiddleware(permission: string) {
  return async (c: Context<AppType>, next: Next) => {
    const user = c.get('user');
    if (!user) {
      return c.json({ success: false, error: { message: 'Unauthorized', code: 'UNAUTHORIZED' } }, 401);
    }
    if (!hasPermission(user, permission)) {
      return c.json({ success: false, error: { message: `Forbidden: requires ${permission}`, code: 'FORBIDDEN' } }, 403);
    }
    await next();
  };
}

// Convenience middlewares for each permission type
export const contestAdminMiddleware = permissionMiddleware('contest_admin');
export const problemAdminMiddleware = permissionMiddleware('problem_admin');
export const listAdminMiddleware = permissionMiddleware('list_admin');
export const ticketAdminMiddleware = permissionMiddleware('ticket_admin');
export const uploadAdminMiddleware = permissionMiddleware('upload_admin');
