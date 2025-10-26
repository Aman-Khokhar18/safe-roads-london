// Hover opens on desktop; on touch devices, tap the tab to toggle.
(function(){
  const dock = document.getElementById('leftDock');
  const tab = dock?.querySelector('.dock__tab');

  let open = false;
  function set(openState){
    open = openState;
    dock.classList.toggle('open', open);
    tab?.setAttribute('aria-expanded', String(open));
  }

  // On touch/click: toggle. On hover devices, CSS handles it.
  tab?.addEventListener('click', (e)=>{
    if (window.matchMedia('(hover: none)').matches) {
      e.preventDefault();
      set(!open);
    }
  });

  // Close when clicking outside (touch)
  document.addEventListener('click', (e)=>{
    if (!dock.contains(e.target) && window.matchMedia('(hover: none)').matches){
      set(false);
    }
  });
})();
