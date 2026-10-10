let accent = "iris";
const signalColors = { iris: "#aea0ef", cobalt: "#9db9ee", amber: "#dfb47b" };
function drawing(mark, mono = false) {
  const signal = mono ? "currentColor" : signalColors[accent],
    core = mono ? "currentColor" : "#f2be70";
  const tile = mono
    ? ""
    : '<rect x="4" y="4" width="56" height="56" rx="14" fill="#1c2639"/>';
  const lens = `<path d="M23 19a16 16 0 0 0 0 26M41 19a16 16 0 0 1 0 26" stroke="${signal}" stroke-width="5" stroke-linecap="round" fill="none"/><circle cx="32" cy="32" r="8" fill="${core}"/>`;
  const beacon = `<path d="M28 30h8l5 19H23l5-19Z" fill="${signal}"/><rect x="26" y="23" width="12" height="7" rx="2" fill="${core}"/><path d="m22 24-8-4m8 8-8 4m28-8 8-4m-8 8 8 4" stroke="${signal}" stroke-width="4" stroke-linecap="round"/>`;
  return `<svg viewBox="0 0 64 64" aria-hidden="true">${tile}${mark === "beacon" ? beacon : lens}</svg>`;
}
function mark(mark) {
  return mark === "lamp"
    ? '<img src="assets/farol-mark.png" alt="Original Farol lamp">'
    : drawing(mark);
}
function renderBrand() {
  document
    .querySelectorAll("[data-accent]")
    .forEach((b) =>
      b.setAttribute("aria-pressed", b.dataset.accent === accent),
    );
  document.querySelector("#concepts").innerHTML = [
    [
      "lamp",
      "Original lamp",
      "The familiar warm light on navy. Keeps existing brand continuity. The UI accent does not need to match the lamp.",
    ],
    [
      "lens",
      "Signal lens",
      "A warm core with two open arcs. Clearer geometry and a link to the interface accent. The open top and bottom help avoid a record-button shape.",
    ],
    [
      "beacon",
      "Beacon",
      "A small lighthouse with a warm light. More literal and easy to explain; the tiny silhouette needs further native size testing.",
    ],
  ]
    .map(
      ([id, name, copy]) =>
        `<article><div class="icon-canvas">${mark(id)}</div><h2>${name}${id === "lamp" ? '<span class="recommended">Existing identity</span>' : ""}</h2><p>${copy}</p><div class="sizes">${[16, 20, 32, 64].map((size) => `<figure><span style="width:${size}px;height:${size}px">${mark(id).replace("<svg ", '<svg style="width:100%;height:100%" ').replace("<img ", '<img style="width:100%;height:100%" ')}</span><figcaption>${size} px</figcaption></figure>`).join("")}</div><div class="mono-row">${id === "lamp" ? '<div class="mono-surface"><small>Retain the existing<br>menu-bar artboard</small></div>' : ["", "dark"].map((theme) => `<div class="mono-surface ${theme}">${drawing(id, true)}<small>Template study</small></div>`).join("")}</div><a class="choice-link" href="index.html?mark=${id}&accent=${accent}&theme=dark">Preview with the interface</a></article>`,
    )
    .join("");
}
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-accent]");
  if (b) {
    accent = b.dataset.accent;
    renderBrand();
    document.querySelector(`[data-accent="${accent}"]`).focus();
  }
});
renderBrand();
