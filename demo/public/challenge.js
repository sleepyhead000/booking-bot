/**
 * Injects the demo's fake anti-bot challenge overlay.
 *
 * The flag is injected into the page by the server (window.__DEMO_CHALLENGE__)
 * so the overlay exists before `load` fires — otherwise the bot would never
 * observe it. The overlay clears itself after `autoclearMs`, simulating a
 * challenge that resolves, which lets the bot's "wait for the challenge to
 * clear" path be exercised end-to-end.
 */
(() => {
  const flag = window.__DEMO_CHALLENGE__;
  if (!flag || !flag.enabled) return;
  if (document.getElementById('challenge-page')) return;

  const el = document.createElement('div');
  el.id = 'challenge-page';
  el.setAttribute('data-demo-challenge', '');
  el.className = 'challenge-overlay';
  el.setAttribute('role', 'alertdialog');
  el.innerHTML = `
    <div class="challenge-card">
      <div class="spinner"></div>
      <h1>Verifying you are human…</h1>
      <p class="muted" data-demo-challenge-widget>demo challenge</p>
      <button id="challenge-continue" type="button">Continue</button>
    </div>`;

  const clear = () => el.remove();
  el.querySelector('#challenge-continue')?.addEventListener('click', clear);
  document.body.appendChild(el);
  setTimeout(clear, flag.autoclearMs || 6000);
})();
