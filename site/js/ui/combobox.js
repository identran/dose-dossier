// An editable combobox with list autocomplete (ARIA 1.2 pattern): the text field keeps
// DOM focus, and aria-activedescendant points at the highlighted option.

import { h } from './dom.js';

export function createCombobox({ input, listbox, search, onAnnounce }) {
  let options = [];
  let active = -1;
  let chosen = null; // { drug, text } while the field still holds a picked option

  const isOpen = () => !listbox.hidden;

  function setActive(index) {
    active = index;
    [...listbox.children].forEach((el, i) => el.setAttribute('aria-selected', i === active ? 'true' : 'false'));
    if (active >= 0) {
      input.setAttribute('aria-activedescendant', listbox.children[active].id);
      listbox.children[active].scrollIntoView({ block: 'nearest' });
    } else {
      input.removeAttribute('aria-activedescendant');
    }
  }

  function close() {
    listbox.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    setActive(-1);
  }

  function open() {
    if (!options.length) return close();
    listbox.hidden = false;
    input.setAttribute('aria-expanded', 'true');
  }

  function refresh() {
    options = search(input.value);
    listbox.replaceChildren(...options.map((option, i) =>
      h('li', { role: 'option', id: `${listbox.id}-${i}`, 'aria-selected': 'false', 'data-index': i },
        h('span', null, option.drug.generic),
        option.via && h('span', { class: 'via' }, option.via))));
    active = -1;
    input.removeAttribute('aria-activedescendant');
  }

  function choose(index) {
    const option = options[index];
    if (!option) return;
    input.value = option.drug.generic;
    chosen = { drug: option.drug, text: input.value };
    close();
    onAnnounce?.(`${option.drug.generic} selected`);
  }

  input.addEventListener('input', () => {
    chosen = null;
    refresh();
    open();
    if (input.value.trim()) onAnnounce?.(options.length ? `${options.length} suggestions` : 'No match');
  });

  input.addEventListener('keydown', event => {
    if (event.isComposing) return;
    const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
    if (step) {
      event.preventDefault();
      if (!isOpen()) {
        refresh();
        open();
        if (event.altKey || !options.length) return;
      }
      if (!options.length) return;
      setActive(active < 0 ? (step > 0 ? 0 : options.length - 1) : (active + step + options.length) % options.length);
    } else if (event.key === 'Enter') {
      if (isOpen() && active >= 0) {
        event.preventDefault();
        choose(active);
      }
    } else if (event.key === 'Escape') {
      if (isOpen()) {
        event.preventDefault();
        close();
      } else if (input.value) {
        input.value = '';
        chosen = null;
      }
    } else if (event.key === 'Tab') {
      close();
    }
  });

  input.addEventListener('blur', close);

  // Keep focus in the field while the pointer works the list.
  listbox.addEventListener('pointerdown', event => event.preventDefault());
  listbox.addEventListener('pointermove', event => {
    const el = event.target.closest('[role="option"]');
    if (el && Number(el.dataset.index) !== active) setActive(Number(el.dataset.index));
  });
  listbox.addEventListener('click', event => {
    const el = event.target.closest('[role="option"]');
    if (el) {
      choose(Number(el.dataset.index));
      input.focus();
    }
  });

  return {
    // The picked drug, if the field has not been edited since it was picked.
    chosen: () => (chosen && chosen.text === input.value ? chosen.drug : null),
    text: () => input.value,
    // Open the list with its first option highlighted, for a name that did not resolve.
    suggest() {
      refresh();
      open();
      if (options.length) setActive(0);
      return options.length;
    },
    clear() {
      input.value = '';
      chosen = null;
      options = [];
      close();
    },
    close,
  };
}
