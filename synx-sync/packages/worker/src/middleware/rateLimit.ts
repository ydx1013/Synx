// 简单 KV 计数限流（窗口内最多 max 次）
export async function checkRateLimit(
  kv: KVNamespace,
  key: string,
  max: number,
  windowSec: number,
): Promise<{ allowed: boolean; count: number }> {
  const raw = await kv.get(key);
  const count = raw ? parseInt(raw, 10) : 0;
  if (count >= max) return { allowed: false, count };
  await kv.put(key, String(count + 1), { expirationTtl: windowSec });
  return { allowed: true, count: count + 1 };
}

/** 从请求中提取客户端标识（用于限流 key） */
export function getClientId(c: { req: { header: (n: string) => string | undefined } }): string {
  return (
    c.req.header('cf-connecting-ip') ??
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ??
    'unknown'
  );
}
