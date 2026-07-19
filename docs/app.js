document.querySelectorAll('[data-copy]').forEach((button) => {
  button.addEventListener('click', async () => {
    const code = document.querySelector(button.dataset.copy)?.innerText || '';
    const original = button.innerText;
    try {
      await navigator.clipboard.writeText(code);
      button.innerText = 'Copied';
    } catch {
      button.innerText = 'Copy unavailable';
    }
    window.setTimeout(() => { button.innerText = original; }, 1200);
  });
});
