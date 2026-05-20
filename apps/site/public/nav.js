(function () {
  const root = document.documentElement;

  function setOpen(open) {
    root.dataset.menuOpen = open ? "true" : "false";
    for (const button of document.querySelectorAll("[data-menu-toggle]")) {
      button.setAttribute("aria-expanded", open ? "true" : "false");
    }
  }

  setOpen(false);

  document.addEventListener("click", function (event) {
    const toggle = event.target.closest("[data-menu-toggle]");
    if (toggle) {
      setOpen(root.dataset.menuOpen !== "true");
      return;
    }

    if (!event.target.closest(".site-nav")) {
      setOpen(false);
    }
  });

  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape") setOpen(false);
  });
})();
