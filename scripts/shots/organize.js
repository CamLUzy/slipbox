await go(`#/card/${DATA.cards.find((c) => c.kind === 'fleeting').uid}`);
document.querySelector('[data-act=ai-organize]').click();
