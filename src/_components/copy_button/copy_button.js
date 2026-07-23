async function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      // fall through to the legacy path
    }
  }
  const ta = document.createElement("textarea")
  ta.value = text
  ta.setAttribute("readonly", "")
  ta.style.position = "fixed"
  ta.style.top = "-1000px"
  document.body.appendChild(ta)
  ta.select()
  let ok = false
  try {
    ok = document.execCommand("copy")
  } catch {
    ok = false
  }
  document.body.removeChild(ta)
  return ok
}

function addCopyButtons() {
  document.querySelectorAll("div.highlight").forEach((block) => {
    if (block.querySelector(".copy-btn")) return
    const pre = block.querySelector("pre")
    if (!pre) return

    const btn = document.createElement("button")
    btn.type = "button"
    btn.className = "copy-btn"
    btn.textContent = "Copy"

    btn.addEventListener("click", async () => {
      const ok = await copyText(pre.innerText.replace(/\n$/, ""))
      btn.textContent = ok ? "Copied!" : "Error"
      setTimeout(() => (btn.textContent = "Copy"), 1500)
    })

    block.appendChild(btn)
  })
}

if (document.readyState !== "loading") addCopyButtons()
else document.addEventListener("DOMContentLoaded", addCopyButtons)
