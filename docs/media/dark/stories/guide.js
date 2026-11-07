/* Timeline: hold, glide to the target, outline it, click. The frame itself never moves. */
const MOVE = 0.55;
const AIM = 0.25;
const CLICK = 0.3;
const END = 2;
const READ = 1.1;
function compile(flow) {
  let at = 0;
  let from = [640, 380];
  const steps = flow.map((step) => {
    const hold = step.hold ?? READ;
    stage.innerHTML = step.s(1);
    let to = from;
    let box = null;
    if (step.target) {
      const target = document.getElementById(step.target);
      if (!target) throw new Error(`Missing target ${step.target}`);
      box = target.getBoundingClientRect();
      to = [box.left + box.width / 2, box.top + box.height / 2];
    }
    const length = hold + (step.target ? MOVE + AIM + CLICK : 0);
    const compiled = { ...step, at, hold, from, to, box, length };
    at += length;
    from = to;
    return compiled;
  });
  return { steps, seconds: at + END };
}
const compiled = {};
window.prepareGuides = () => {
  for (const [name, flow] of Object.entries(window.FLOWS))
    compiled[name] = compile(flow);
  stage.innerHTML = "";
  return Object.fromEntries(
    Object.entries(compiled).map(([k, v]) => [k, v.seconds]),
  );
};
window.drawGuide = (name, t) => {
  const { steps } = compiled[name];
  const step = steps.findLast((s) => s.at <= t) ?? steps[0];
  const local = t - step.at;
  const p = Math.min(1, local / step.hold);
  let [x, y] = step.from;
  let overlay = "";
  if (step.target && local > step.hold) {
    const move = ease(Math.min(1, (local - step.hold) / MOVE));
    x += (step.to[0] - x) * move;
    y += (step.to[1] - y) * move;
    if (local > step.hold + MOVE) {
      const b = step.box;
      overlay += `<div class="aim" style="left:${b.left - 4}px;top:${b.top - 4}px;width:${b.width + 8}px;height:${b.height + 8}px"></div>`;
    }
    if (local > step.hold + MOVE + AIM) {
      const r = 6 + 16 * ((local - step.hold - MOVE - AIM) / CLICK);
      overlay += `<div class="ripple" style="left:${x - r}px;top:${y - r}px;width:${2 * r}px;height:${2 * r}px"></div>`;
    }
  }
  const pointer = `<svg class="cursor" style="left:${x}px;top:${y}px" viewBox="0 0 14 20"><path d="M1 1v15l4-3.6 2.6 6 2.6-1.1-2.6-6H13z" fill="var(--text)" stroke="var(--bg)" stroke-width="1.2"/></svg>`;
  stage.innerHTML = step.s(p) + overlay + pointer + caption(step.n, step.cap);
};
