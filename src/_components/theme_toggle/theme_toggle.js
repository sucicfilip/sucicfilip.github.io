function initThemeToggle() {
  const btn = document.querySelector(".theme-toggle")
  if (!btn) return
  btn.addEventListener("click", () => {
    const current =
      document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark"
    const next = current === "light" ? "dark" : "light"
    document.documentElement.setAttribute("data-theme", next)
    try {
      localStorage.setItem("theme", next)
    } catch (e) {}
  })
}

if (document.readyState !== "loading") initThemeToggle()
else document.addEventListener("DOMContentLoaded", initThemeToggle)
