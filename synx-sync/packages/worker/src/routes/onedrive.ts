import { Hono } from 'hono';
import type { OnedriveConfig } from '@synx/shared';
import { authMiddleware } from '../middleware/auth.js';
import {
  buildAuthUrl,
  DEFAULT_AUTHORITY,
  exchangeCodeForToken,
  generatePkceCodes,
} from '../storage/onedriveAuth.js';
import type { Env, AppVars } from '../types.js';

/**
 * OneDrive OAuth2 PKCE 路由。
 *
 * 设计参考 Remotely Save 的 Obsidian OAuth 回调机制，适配 Web 端：
 * - 用户在 Web 控制台选择 OneDrive → 输入自己的 Microsoft App Client ID
 * - Worker 生成 PKCE verifier/challenge，构建授权 URL
 * - 用户在新窗口中完成 Microsoft 登录
 * - Microsoft 重定向回 Worker 的 /api/onedrive/callback
 * - Worker 渲染一个 postMessage 页面，将 code 传回父窗口
 * - 父窗口调用 /api/onedrive/auth/exchange 换取 token
 *
 * 中转站角色：Worker 只负责 PKCE 生成和 token 交换，
 * 不存储 token（token 由前端填入表单，随存储配置一起 AES 加密存 D1）。
 */
export const onedrive = new Hono<{ Bindings: Env; Variables: AppVars }>();

// auth/start 和 auth/exchange 需要登录（callback 不需要）
onedrive.use('/auth/*', authMiddleware);

/**
 * 启动 OAuth 流程：生成 PKCE，返回授权 URL。
 * 前端打开此 URL 让用户登录 Microsoft。
 */
onedrive.post('/auth/start', async (c) => {
  const body = await c.req.json<{
    clientId: string;
    authority?: string;
    remoteBaseDir?: string;
  }>();

  if (!body.clientId) return c.json({ error: 'missing clientId' }, 400);

  const authority = body.authority || DEFAULT_AUTHORITY;
  const origin = new URL(c.req.url).origin;
  const redirectUri = `${origin}/api/onedrive/callback`;

  const { verifier, challenge } = await generatePkceCodes();
  const state = crypto.randomUUID();

  const authUrl = buildAuthUrl({
    clientId: body.clientId,
    authority,
    redirectUri,
    challenge,
    state,
  });

  return c.json({ authUrl, verifier, state, redirectUri });
});

/**
 * 用授权码交换 token。
 * 前端在收到 callback 的 code 后调用此接口。
 */
onedrive.post('/auth/exchange', async (c) => {
  const body = await c.req.json<{
    code: string;
    verifier: string;
    clientId: string;
    authority?: string;
    remoteBaseDir?: string;
  }>();

  if (!body.code || !body.verifier || !body.clientId) {
    return c.json({ error: 'missing fields' }, 400);
  }

  const authority = body.authority || DEFAULT_AUTHORITY;
  const origin = new URL(c.req.url).origin;
  const redirectUri = `${origin}/api/onedrive/callback`;

  let tokenResponse;
  try {
    tokenResponse = await exchangeCodeForToken({
      clientId: body.clientId,
      authority,
      code: body.code,
      redirectUri,
      verifier: body.verifier,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'token exchange failed';
    return c.json({ error: message }, 422);
  }

  // 获取用户显示名（参考 Remotely Save 的 fetchProfile）
  let username: string | undefined;
  try {
    const meRes = await fetch('https://graph.microsoft.com/v1.0/me', {
      headers: { Authorization: `Bearer ${tokenResponse.access_token}` },
    });
    if (meRes.ok) {
      const me = (await meRes.json()) as { displayName?: string; userPrincipalName?: string };
      username = me.displayName || me.userPrincipalName;
    }
  } catch {
    // profile 获取失败不影响整体流程
  }

  const config: OnedriveConfig = {
    accessToken: tokenResponse.access_token,
    refreshToken: tokenResponse.refresh_token!,
    accessTokenExpiresAt: Date.now() + tokenResponse.expires_in * 1000 - 2 * 60 * 1000,
    clientId: body.clientId,
    authority,
    remoteBaseDir: body.remoteBaseDir,
    username,
  };

  return c.json({ config });
});

/**
 * OAuth 回调端点（Microsoft 重定向回此处）。
 * 不需要 auth 中间件——这是来自 Microsoft 的浏览器重定向。
 *
 * 渲染一个最小 HTML 页面，通过 postMessage 将 code 传回父窗口。
 */
onedrive.get('/callback', (c) => {
  const code = c.req.query('code') || '';
  const state = c.req.query('state') || '';
  const error = c.req.query('error');
  const errorDescription = c.req.query('error_description') || '';

  if (error) {
    const msg = JSON.stringify(errorDescription || error);
    return c.html(
      `<!doctype html><html><body><p style="font-family:sans-serif;text-align:center;padding:2rem">` +
        `认证失败：${errorDescription || error}` +
        `</p><script>window.opener?.postMessage({type:'onedrive-callback',error:${msg}},'*')<\/script>` +
        `</body></html>`,
    );
  }

  const codeJson = JSON.stringify(code);
  const stateJson = JSON.stringify(state);
  return c.html(
    `<!doctype html><html><body><p style="font-family:sans-serif;text-align:center;padding:2rem">` +
      `认证成功，请关闭此窗口` +
      `</p><script>window.opener?.postMessage({type:'onedrive-callback',code:${codeJson},state:${stateJson}},'*')<\/script>` +
      `</body></html>`,
  );
});
