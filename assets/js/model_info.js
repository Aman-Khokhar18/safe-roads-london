// Expand / Collapse all for the feature glossary
(function(){
  const toolbar = document.querySelector('.glossary-toolbar');
  if(!toolbar) return;

  function setAll(open) {
    document.querySelectorAll('details.glossary').forEach(d => d.open = open);
  }

  toolbar.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-action]');
    if(!btn) return;
    const action = btn.getAttribute('data-action');
    if(action === 'expand-all') setAll(true);
    if(action === 'collapse-all') setAll(false);
  });
})();

