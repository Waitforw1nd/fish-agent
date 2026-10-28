(function () {
  try {
    var saved = localStorage.getItem('fish-cloud-theme');
    var theme = saved === 'light' || saved === 'dark'
      ? saved
      : (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
    document.documentElement.setAttribute('data-theme', theme);
  } catch (err) {
    document.documentElement.setAttribute('data-theme', 'dark');
  }
})();
