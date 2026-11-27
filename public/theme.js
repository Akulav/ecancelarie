// Tema aleasă de utilizator (luminoasă / întunecată), aplicată înainte de afișarea paginii, ca să nu clipească.
// Fără alegere, tema urmează setarea sistemului (prefers-color-scheme, în style.css).
(function () {
  try {
    var t = localStorage.getItem('ansc.theme');
    if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
  } catch (e) {}
})();
