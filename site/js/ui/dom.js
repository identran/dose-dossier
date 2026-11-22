// Small DOM helpers shared by the interface modules.

export const $ = (selector, root = document) => root.querySelector(selector);

// h('li', { class: 'x', hidden: false }, 'text', node, …)
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs || {})) {
    if (value === false || value == null) continue;
    el.setAttribute(name, value === true ? '' : value);
  }
  el.append(...children.flat(Infinity).filter(child => child != null && child !== false));
  return el;
}

export const sr = text => h('span', { class: 'sr' }, text);
