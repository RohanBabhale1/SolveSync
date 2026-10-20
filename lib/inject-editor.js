// Shared by Repovive and CodeChef. Runs in the page's own JS world so it can read the code editor's full text
// (Monaco / Ace / CodeMirror 5 keep it in JS objects, and virtualise the visible DOM lines).
(() => {
  const read = () => {
    try {
      const ed = window.monaco?.editor?.getEditors?.()[0];
      if (ed?.getModel()) return { code: ed.getModel().getValue(), lang: ed.getModel().getLanguageId?.() };
    } catch (_) {}
    try {
      const el = document.querySelector('.ace_editor');
      if (el && window.ace) { const e = window.ace.edit(el); return { code: e.getValue(), lang: String(e.session.getMode().$id || '').split('/').pop() }; }
    } catch (_) {}
    try {
      const cm = document.querySelector('.CodeMirror')?.CodeMirror;
      if (cm) return { code: cm.getValue(), lang: cm.getOption('mode')?.name || cm.getOption('mode') };
    } catch (_) {}
    return null;
  };
  window.addEventListener('message', (e) => {
    if (e.source !== window || e.data?.source !== 'solvesync-rv-req') return;
    window.postMessage({ source: 'solvesync-rv-res', id: e.data.id, ...(read() || {}) }, '*');
  });
})();
