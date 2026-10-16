await go(`#/card/${zid('1')}`);
document.querySelector('[data-act=graph]').click();
await new Promise((r) => setTimeout(r, 600));
const svg = document.querySelector('.modal svg.graph') || document.querySelector('.modal svg');
const target = zid('1a');
const n = svg.querySelector(`.g-node[data-uid="${target}"]`);
svg.classList.add('g-focus');
n.classList.add('hl', 'hl-center');
for (const l of svg.querySelectorAll('.g-edge')) if (l.dataset.a === target || l.dataset.b === target) {
  l.classList.add('hl');
  svg.querySelector(`.g-node[data-uid="${l.dataset.a === target ? l.dataset.b : l.dataset.a}"]`)?.classList.add('hl');
}
return svg.querySelectorAll('.g-node').length;
