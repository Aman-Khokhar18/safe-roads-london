(function () {
  const btn = document.getElementById('navToggle');
  const nav = document.getElementById('primaryNav');
  if (!btn || !nav) return;

  const links = nav.querySelectorAll('a');
  const mq = window.matchMedia('(min-width: 720px)'); // match your CSS

  function openNav() {
    btn.setAttribute('aria-expanded', 'true');
    nav.classList.add('is-open');
    document.body.classList.add('nav-open');
  }
  function closeNav() {
    btn.setAttribute('aria-expanded', 'false');
    nav.classList.remove('is-open');
    document.body.classList.remove('nav-open');
  }
  function toggleNav() {
    (btn.getAttribute('aria-expanded') === 'true') ? closeNav() : openNav();
  }

  btn.addEventListener('click', toggleNav);
  links.forEach(a => a.addEventListener('click', closeNav));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeNav(); });

  // Close when switching to desktop
  if (mq.addEventListener) {
    mq.addEventListener('change', e => { if (e.matches) closeNav(); });
  } else {
    window.addEventListener('resize', () => { if (window.innerWidth >= 720) closeNav(); });
  }

  // ✅ Close on outside click/tap
  function onOutsidePointerDown(e) {
    if (!document.body.classList.contains('nav-open')) return;
    if (nav.contains(e.target) || btn.contains(e.target)) return; // ignore clicks inside menu or on button
    closeNav();
  }
  document.addEventListener('pointerdown', onOutsidePointerDown, { passive: true });

  // (Optional) close if focus moves outside (keyboard users)
  document.addEventListener('focusin', (e) => {
    if (!document.body.classList.contains('nav-open')) return;
    if (nav.contains(e.target) || btn.contains(e.target)) return;
    closeNav();
  });
})();
