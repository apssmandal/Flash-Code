const fs = require('fs');
const html = fs.readFileSync('D:/Animixer/Flash Code/media/chat.html', 'utf8');
const renderMdMatch = html.match(/function renderMd\(raw\)\{[\s\S]*?return thoughts\+html\+clar;\}/);
let renderMdCode = renderMdMatch[0];
renderMdCode = `
const IC = { chevron: '<polyline points="9 18 15 12 9 6"/>' };
function sv(n){return '<svg viewBox="0 0 24 24">'+(IC[n]||'')+'</svg>'}
function esc(s){return s;}
function mdText(s){return s;}
function buildClar(){return '';}
` + renderMdCode;
eval(renderMdCode);
console.log(renderMd('Test <think>This is a thought</think> output'));
