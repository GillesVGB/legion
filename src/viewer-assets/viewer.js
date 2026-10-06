const status = document.querySelector('#status');
const frame = document.querySelector('#transcript');
const tools = document.querySelector('#tools');
const decode = value => Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
let source = '';
const id = /^\/t\/([a-f0-9]{32})$/.exec(location.pathname)?.[1];
if (id) {
  try {
    const secret = new URLSearchParams(location.hash.slice(1)).get('k') || '';
    if (!/^[a-zA-Z0-9_-]{43}$/.test(secret)) throw new Error('Open de volledige dossierlink via de knop in Discord. De toegangssleutel ontbreekt.');
    status.textContent = 'Het transcript wordt veilig geopend…';
    const response = await fetch(`/api/transcripts/${id}`, { cache: 'no-store', redirect: 'error', credentials: 'omit' });
    if (!response.ok) throw new Error(response.status === 404 ? 'Dit transcript is niet beschikbaar. Gebruik de nieuwste knop in Discord.' : 'Het transcript kan nu niet worden geladen. Probeer opnieuw.');
    const envelope = await response.json();
    if (envelope.version !== 1) throw new Error('Dit transcript heeft een onbekend formaat.');
    const key = await crypto.subtle.importKey('raw', decode(secret), 'AES-GCM', false, ['decrypt']);
    let clear;
    try { clear = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode(envelope.iv), additionalData: new TextEncoder().encode(id) }, key, decode(envelope.data)); }
    catch { throw new Error('De toegangssleutel klopt niet. Open de originele knop in Discord.'); }
    source = new TextDecoder().decode(clear);
    frame.srcdoc = source;
    frame.hidden = false; tools.hidden = false;
    status.textContent = 'Transcript geopend. Je kunt zoeken, downloaden of bewaren als PDF.';
  } catch (error) { status.textContent = error.message || 'Het transcript kon niet worden geopend.'; }
}
frame.addEventListener('load', () => {
  if (frame.hidden) return;
  const resize = () => { frame.style.height = `${Math.max(450, (frame.contentDocument?.body.scrollHeight || 1000) + 25)}px`; };
  resize();
  new ResizeObserver(resize).observe(frame.contentDocument.body);
});
document.querySelector('#search').addEventListener('input', event => {
  const value = event.target.value.trim().toLocaleLowerCase();
  const items = [...(frame.contentDocument?.querySelectorAll('.message') || [])];
  let found = 0;
  for (const item of items) { const matches = !value || item.textContent.toLocaleLowerCase().includes(value); item.hidden = !matches; if (matches) found++; }
  document.querySelector('#count').textContent = value ? `${found} van ${items.length} berichten` : '';
});
document.querySelector('#print').addEventListener('click', () => { frame.contentWindow?.focus(); frame.contentWindow?.print(); });
document.querySelector('#download').addEventListener('click', () => {
  if (!source) return;
  const url = URL.createObjectURL(new Blob([source], { type: 'text/html;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url; link.download = 'legion-transcript.html'; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
