export function buildApiExamples(origin: string) {
  const endpoint = `${origin.replace(/\/$/, '')}/api/inbox/notes`;
  return {
    curl: `curl -X POST "${endpoint}" \\
  -H "Authorization: Bearer synx_pat_你的Token" \\
  -H "Content-Type: application/json" \\
  -d '{"title":"会议记录","content":"# 会议记录\\n\\n这是通过 API 添加的内容。"}'`,
    powershell: `$headers = @{
  Authorization = "Bearer synx_pat_你的Token"
  "Content-Type" = "application/json"
}
$body = @{
  title = "会议记录"
  content = "# 会议记录\`n\`n这是通过 API 添加的内容。"
} | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri "${endpoint}" -Headers $headers -Body $body`,
    javascript: `await fetch('${endpoint}', {
  method: 'POST',
  headers: {
    Authorization: 'Bearer synx_pat_你的Token',
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    title: '会议记录',
    content: '# 会议记录\\n\\n这是通过 API 添加的内容。'
  })
});`,
  };
}
