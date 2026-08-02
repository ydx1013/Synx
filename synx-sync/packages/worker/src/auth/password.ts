import bcrypt from 'bcryptjs';

const COST = 12;

/** 生成密码哈希（bcrypt cost=12） */
export async function hashPassword(password: string): Promise<string> {
  const salt = await bcrypt.genSalt(COST);
  return bcrypt.hash(password, salt);
}

/** 校验密码 */
export function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}
