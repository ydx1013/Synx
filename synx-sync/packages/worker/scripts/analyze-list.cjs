const d = require('C:/Users/Public/synx-list.json');
const byAuth = {};
for (const f of d.files) {
  byAuth[f.author] = (byAuth[f.author] ?? 0) + 1;
}
console.log('byAuth:', JSON.stringify(byAuth));
const mobile = d.files.filter((f) => f.author === 'obsidian-8vzozh');
console.log('mobile files:', mobile.length);
mobile.forEach((f) => console.log('  ', f.path));
