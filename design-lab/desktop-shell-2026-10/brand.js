const dockConcepts = [
  [
    "iris-glass",
    "Iris Glass",
    "Translucent Iris and Cobalt arcs around a pearl center. A deep indigo tile gives the mark room to glow.",
  ],
  [
    "prism",
    "Prism",
    "Pearl glass catches Cobalt, cyan and Iris reflections. A quieter symbol against a richer, spectral tile.",
  ],
  [
    "aurora-enamel",
    "Aurora Enamel",
    "Cobalt and Iris enamel over pale porcelain. Crisp, colorful arcs with a soft pearl center.",
  ],
];
let chosen = "iris-glass";
let desktopTheme = "light";
function renderBrand() {
  document.querySelector("#concepts").innerHTML = dockConcepts
    .map(
      ([id, name, copy], i) =>
        `<article><div class="icon-canvas variant-${id}"><img src="assets/dock-v4/${id}.png" alt="Signal Lens Dock concept / ${name}"></div><div class="concept-title"><span>0${i + 1}</span><h2>${name}</h2></div><p>${copy}</p><div class="sizes">${[24, 32, 64].map((size) => `<figure><img src="assets/dock-v4/${id}.png" alt="" width="${size}" height="${size}"><figcaption>${size} px</figcaption></figure>`).join("")}</div><button class="choose" data-choice="${id}" aria-pressed="${chosen === id}">${chosen === id ? "Selected for preview" : "Preview in Dock"}</button></article>`,
    )
    .join("");
  const item = dockConcepts.find((c) => c[0] === chosen);
  document.querySelector("#selected-title").textContent = item[1];
  const img = document.querySelector("#selected-icon");
  img.src = `assets/dock-v4/${chosen}.png`;
  img.alt = `Signal Lens / ${item[1]}`;
  document
    .querySelector("#desktop")
    .classList.toggle("dark", desktopTheme === "dark");
  document
    .querySelectorAll("[data-desktop]")
    .forEach((b) =>
      b.setAttribute("aria-pressed", b.dataset.desktop === desktopTheme),
    );
}
document.addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  if (b.dataset.choice) {
    chosen = b.dataset.choice;
    renderBrand();
    document.querySelector(`[data-choice="${chosen}"]`).focus();
  }
  if (b.dataset.desktop) {
    desktopTheme = b.dataset.desktop;
    renderBrand();
    document.querySelector(`[data-desktop="${desktopTheme}"]`).focus();
  }
});
for (const id of ["emblem", "menu-light", "menu-dark"])
  document.querySelector("#" + id).innerHTML = FarolMark.svg(
    "lens",
    "currentColor",
  );
renderBrand();
