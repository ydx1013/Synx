-- 为图库添加永久访问令牌：用于图片代理端点鉴权（替代会过期的 JWT）
ALTER TABLE image_galleries ADD COLUMN access_token TEXT NOT NULL DEFAULT '';
