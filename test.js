const IC = { chevron: '<polyline points="9 18 15 12 9 6"/>' };
function sv(n){return '<svg viewBox="0 0 24 24">'+(IC[n]||'')+'</svg>'}
function esc(s){return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}
function mdText(s){return s;}
let clar='';
let raw = 'Hello <think> This is a thought </think> World';
let thoughts = '';
raw = raw.replace(/<think\b[^>]*>([\s\S]*?)<\/think>/g, (_, t) => {
    const words = t.trim().split(/\s+/).length;
    const duration = Math.max(1, Math.round(words / 30));
    thoughts += '<div class="thought-block"><div class="thought-header" onclick="this.parentElement.classList.toggle(\\\'open\\\'); scrollDown();">Thought for ' + duration + 's ' + sv('chevron') + '</div>'
      + '<div class="thought-body">' + esc(t.trim()) + '</div></div>';
    return '';
});
raw = raw.replace(/<think\b[^>]*>[\s\S]*$/, '');
let html='';
const rx=/```(\w+)?(?::(\S+))?\n([\s\S]*?)```/g;let last=0,m;
while((m=rx.exec(raw))!==null){
    if(m.index>last)html+=mdText(raw.slice(last,m.index));
    last=rx.lastIndex;
}
if(last<raw.length)html+=mdText(raw.slice(last));
console.log(thoughts+html+clar);
