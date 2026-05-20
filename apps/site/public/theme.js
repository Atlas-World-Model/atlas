(function () {
  const storageKey = "atlas-theme";
  const root = document.documentElement;
  const media = window.matchMedia("(prefers-color-scheme: dark)");

  function preferredTheme() {
    const stored = window.localStorage.getItem(storageKey);
    if (stored === "dark" || stored === "light") return stored;
    return media.matches ? "dark" : "light";
  }

  function applyTheme(theme) {
    root.dataset.theme = theme;
    for (const button of document.querySelectorAll("[data-theme-toggle]")) {
      button.setAttribute("aria-pressed", theme === "dark" ? "true" : "false");
      button.textContent = theme === "dark" ? "Light" : "Dark";
    }
  }

  applyTheme(preferredTheme());

  document.addEventListener("click", function (event) {
    const button = event.target.closest("[data-theme-toggle]");
    if (!button) return;

    const next = root.dataset.theme === "dark" ? "light" : "dark";
    window.localStorage.setItem(storageKey, next);
    applyTheme(next);
  });

  media.addEventListener("change", function () {
    if (!window.localStorage.getItem(storageKey)) {
      applyTheme(preferredTheme());
    }
  });
})();
