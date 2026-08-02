-- 存储配置表增加保留策略列（JSON 文本，NULL=使用默认策略）
ALTER TABLE storages ADD COLUMN retention_policy TEXT;
