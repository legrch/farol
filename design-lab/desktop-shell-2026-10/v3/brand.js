let accent = "iris";
let treatment = "color";
const markColors = { iris: "#715bb9", cobalt: "#3561b7", amber: "#946521" };
const concepts = [
  [
    "lens",
    "Signal lens",
    "Open arcs around a single center. Closest to the abstract direction you liked.",
  ],
  [
    "aperture",
    "Open aperture",
    "An interrupted ring and a small center. One color; no literal object.",
  ],
  [
    "relay",
    "Relay",
    "Opposing curved paths suggest work moving through Farol.",
  ],
];
function draw(id, variant = "emblem") {
  return FarolMark.svg(
    id,
    treatment === "mono" ? "currentColor" : markColors[accent],
    variant,
  );
}
function renderBrand() {
  document
    .querySelectorAll("[data-accent]")
    .forEach((b) =>
      b.setAttribute("aria-pressed", b.dataset.accent === accent),
    );
  document
    .querySelectorAll("[data-treatment]")
    .forEach((b) =>
      b.setAttribute("aria-pressed", b.dataset.treatment === treatment),
    );
  document.querySelector("#concepts").innerHTML = concepts
    .map(
      ([id, name, copy]) =>
        `<article><div class="icon-canvas emblem-canvas">${draw(id)}</div><h2>${name}</h2><p>${copy}</p><div class="sizes">${[16, 20, 32, 64].map((size) => `<figure><span style="width:${size}px;height:${size}px">${draw(id)}</span><figcaption>${size} px</figcaption></figure>`).join("")}</div><div class="brand-uses"><figure class="dock-use">${FarolMark.svg(id, markColors[accent], "dock")}<figcaption>Dock icon<br>Tile only here</figcaption></figure><figure class="pure-use">${FarolMark.svg(id, "currentColor")}<figcaption>Emblem<br>Transparent</figcaption></figure><figure class="menu-use">${FarolMark.svg(id, "currentColor")}<figcaption>Menu bar<br>Monochrome</figcaption></figure></div><a class="choice-link" href="menu-bar.html?mark=${id}">Preview in the menu bar</a></article>`,
    )
    .join("");
}
document.addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  if (b.dataset.accent) accent = b.dataset.accent;
  if (b.dataset.treatment) treatment = b.dataset.treatment;
  renderBrand();
  b.focus();
});
renderBrand();
