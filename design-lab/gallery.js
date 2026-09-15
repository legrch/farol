(() => {
  "use strict";

  const prototypeWidth = 1180;
  const prototypeHeight = 760;
  const frames = [...document.querySelectorAll(".preview-shell")];

  function fitFrames() {
    frames.forEach((shell) => {
      const frame = shell.querySelector("iframe");
      const scale = shell.clientWidth / prototypeWidth;
      shell.style.height = `${Math.round(prototypeHeight * scale)}px`;
      frame.style.transform = `scale(${scale})`;
    });
  }

  new ResizeObserver(fitFrames).observe(document.body);
  fitFrames();
  requestAnimationFrame(() => {
    fitFrames();
    document.documentElement.dataset.ready = "true";
  });
})();
