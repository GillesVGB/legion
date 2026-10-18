// Update presentation only. Member messages, names, answers and dates are historical evidence.
export function rebrandTranscript(html,logo){
  const doc=new DOMParser().parseFromString(html,'text/html');
  doc.title=doc.title.replace(/\bLegion\b/gi,'Bakarov');
  const brand=doc.querySelector('main > .brand');
  if(brand){
    const name=brand.querySelector('div:not(.logo)');
    if(name)for(const node of name.childNodes)if(node.nodeType===3)node.textContent=node.textContent.replace(/\bLegion\b/gi,'BAKAROV');
    const old=brand.querySelector('.logo');
    if(old&&logo){const image=doc.createElement('img');image.className='logo';image.src=logo;image.alt='Bakarov-logo';image.width=56;image.height=56;old.replaceWith(image);}
  }
  const footer=doc.querySelector('main > footer > span');if(footer)footer.textContent=footer.textContent.replace(/\bLegion\b/gi,'BAKAROV');
  const style=doc.createElement('style');style.textContent=':root{--bg:#080807;--panel:#14120e;--line:#37301e;--muted:#aaa28d;--text:#f4efdf;--accent:#d6a51a}a{color:#e5c574}.eyebrow{color:#d6b96d}.brand .logo{width:56px;height:56px;object-fit:contain;clip-path:none;background:#050505;border:1px solid #69501b;border-radius:10px;padding:0}.bot-avatar{background:#3a2e12;color:#f0cc72}.bot-label{background:#796023}.embed{background:#100e0a}.attachment{background:#211c10;border-color:#514323}.avatar{background:#30291a;color:#e8d6a5}@media print{:root{--bg:#fff;--panel:#fff;--line:#ddd;--muted:#555;--text:#111}.embed{background:#f5f5f5}}';doc.head.append(style);
  return '<!doctype html>'+doc.documentElement.outerHTML;
}
