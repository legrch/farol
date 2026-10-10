/* Original vector studies. A tile belongs only to the Dock icon variant. */
const FarolMark = {
  svg(
    shape = "lens",
    ink = "currentColor",
    variant = "emblem",
    status = "ready",
  ) {
    const color = variant === "dock" ? "#ffffff" : ink;
    const stroke = `style="fill:none;stroke:${color};stroke-width:5;stroke-linecap:round;stroke-linejoin:round"`;
    const tile =
      variant === "dock"
        ? `<rect x="3" y="3" width="58" height="58" rx="15" style="fill:${ink};stroke:none"/>`
        : "";
    let outline;
    if (shape === "aperture")
      outline = `<path d="M38 13a20 20 0 1 0 13 25M45 18l5 5" ${stroke}/>`;
    else if (shape === "relay")
      outline = `<path d="M17 44V29c0-10 7-17 17-17h10M47 20v15c0 10-7 17-17 17H20" ${stroke}/>`;
    else
      outline = `<path d="M23 19a16 16 0 0 0 0 26M41 19a16 16 0 0 1 0 26" ${stroke}/>`;
    let core = `<circle cx="32" cy="32" r="7" style="fill:${color};stroke:none"/>`;
    if (status === "running")
      core = `<circle cx="32" cy="32" r="8" style="fill:none;stroke:${color};stroke-width:3;stroke-dasharray:3 4"/>`;
    if (status === "attention")
      core = `<path d="M32 23v11" style="stroke:${color};stroke-width:4;stroke-linecap:round"/><circle cx="32" cy="41" r="2.5" style="fill:${color};stroke:none"/>`;
    if (status === "offline")
      core = `<path d="m27 27 10 10m0-10-10 10" style="stroke:${color};stroke-width:3.5;stroke-linecap:round"/>`;
    if (status === "update")
      core = `<path d="M32 21v19m-6-6 6 6 6-6" style="fill:none;stroke:${color};stroke-width:3.5;stroke-linecap:round;stroke-linejoin:round"/>`;
    return `<svg viewBox="${variant === "dock" ? "0 0 64 64" : "7 7 50 50"}" aria-hidden="true">${tile}${outline}${core}</svg>`;
  },
};
