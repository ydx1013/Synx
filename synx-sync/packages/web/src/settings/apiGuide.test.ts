import { describe, expect, it } from 'vitest';
import { buildApiExamples } from './apiGuide';

describe('buildApiExamples', () => {
  it('生成包含当前站点地址、鉴权头和请求参数的调用示例', () => {
    const examples = buildApiExamples('https://synx.example.com');

    expect(examples.curl).toContain('https://synx.example.com/api/inbox/notes');
    expect(examples.curl).toContain('Authorization: Bearer synx_pat_你的Token');
    expect(examples.curl).toContain('"title"');
    expect(examples.curl).toContain('"content"');
    expect(examples.powershell).toContain('Invoke-RestMethod');
    expect(examples.javascript).toContain("method: 'POST'");
  });

  it('移除站点地址末尾的斜杠', () => {
    expect(buildApiExamples('https://synx.example.com/').curl).toContain('https://synx.example.com/api/inbox/notes');
  });
});
