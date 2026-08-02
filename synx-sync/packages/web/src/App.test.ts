import { describe, expect, it } from 'vitest';
import { notePathFromLocation } from './App';

describe('notePathFromLocation', () => {
  it('把以 .md/.markdown 结尾的 URL 路径提取为笔记相对路径', () => {
    expect(notePathFromLocation('/肝窦毛细血管化.md')).toBe('肝窦毛细血管化.md');
    expect(notePathFromLocation('/文件夹/子文件夹/笔记.markdown')).toBe('文件夹/子文件夹/笔记.markdown');
    expect(notePathFromLocation('/未命名.md')).toBe('未命名.md');
  });

  it('处理 location.pathname 的编码形式（浏览器对中文路径编码）', () => {
    expect(notePathFromLocation('/%E6%9C%AA%E5%91%BD%E5%90%8D.md')).toBe('未命名.md');
    expect(notePathFromLocation('/%E7%AC%94%E8%AE%B0/%E4%BC%9A%E8%AE%AE%E8%AE%B0%E5%BD%95.md')).toBe('笔记/会议记录.md');
  });

  it('非笔记路径返回 null，交给默认跳转', () => {
    expect(notePathFromLocation('/settings')).toBeNull();
    expect(notePathFromLocation('/notes')).toBeNull();
    expect(notePathFromLocation('/')).toBeNull();
    expect(notePathFromLocation('/assets/index.css')).toBeNull();
  });
});
