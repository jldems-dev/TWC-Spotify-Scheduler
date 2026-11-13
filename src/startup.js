(() => {
  const screen = document.getElementById('startup-screen');
  if (!screen) return;

  const showFailure = (detail) => {
    if (screen.classList.contains('is-ready')) return;
    screen.classList.add('has-error');
    const details = screen.querySelector('.startup-failure pre');
    if (details && detail) details.textContent = String(detail).slice(0, 1200);
  };

  window.addEventListener('twc:app-ready', () => screen.classList.add('is-ready'), { once: true });
  window.addEventListener('twc:startup-error', (event) => showFailure(event.detail));
  window.addEventListener('error', (event) => {
    showFailure(event.message || 'A renderer script failed to load.');
  });

  window.setTimeout(() => {
    if (!screen.classList.contains('is-ready') && !screen.classList.contains('has-error')) {
      showFailure('Startup took longer than expected.');
    }
  }, 30000);
})();
