export async function showStartScreen() {
  const config = await fetch('maps/map-config.json')
    .then((r) => (r.ok ? r.json() : { maps: {} }))
    .catch(() => ({ maps: {} }));

  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.id = 'start-screen';
    Object.assign(overlay.style, {
      position: 'fixed',
      inset: '0',
      zIndex: '1000',
      display: 'grid',
      placeItems: 'center',
      background: '#12161d',
      color: '#eef3f8',
      fontFamily: 'system-ui, sans-serif',
      padding: '32px',
      boxSizing: 'border-box',
    });

    const shell = document.createElement('div');
    Object.assign(shell.style, {
      width: 'min(860px, 100%)',
      display: 'grid',
      gap: '18px',
    });

    const title = document.createElement('h1');
    title.textContent = 'Creature Workshop';
    Object.assign(title.style, { margin: '0', fontSize: '28px', fontWeight: '650' });

    const grid = document.createElement('div');
    Object.assign(grid.style, {
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))',
      gap: '10px',
    });

    function card(label, detail, onClick) {
      const btn = document.createElement('button');
      btn.type = 'button';
      Object.assign(btn.style, {
        minHeight: '92px',
        border: '1px solid #354050',
        borderRadius: '8px',
        background: '#1a2029',
        color: '#eef3f8',
        padding: '16px',
        textAlign: 'left',
        cursor: 'pointer',
      });
      btn.innerHTML = `<div style="font-weight:650;font-size:15px;margin-bottom:6px"></div><div style="font-size:12px;color:#98a5b5"></div>`;
      btn.children[0].textContent = label;
      btn.children[1].textContent = detail;
      btn.addEventListener('mouseenter', () => { btn.style.borderColor = '#6aa7ff'; });
      btn.addEventListener('mouseleave', () => { btn.style.borderColor = '#354050'; });
      btn.addEventListener('click', onClick);
      return btn;
    }

    grid.appendChild(card('Infinite World', 'Procedural terrain, grass, and GPU forest', () => {
      overlay.remove();
      resolve({ mode: 'infinite' });
    }));

    const maps = config.maps || {};
    for (const [key, meta] of Object.entries(maps)) {
      if (meta && meta.playable === false) continue;
      grid.appendChild(card(meta?.displayName || key, 'Authored terrain with runtime GPU trees', () => {
        overlay.remove();
        resolve({ mode: 'map', mapKey: key });
      }));
    }

    shell.append(title, grid);
    overlay.appendChild(shell);
    document.body.appendChild(overlay);
  });
}
