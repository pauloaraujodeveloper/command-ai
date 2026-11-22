// Aplica o tema salvo antes da primeira pintura (evita piscar). Arquivo externo para funcionar com CSP sem 'unsafe-inline' em scripts.
try {
  var t = localStorage.getItem('ca-theme');
  if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
} catch (e) {}
