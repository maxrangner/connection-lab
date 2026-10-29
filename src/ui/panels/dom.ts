export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: { class?: string; text?: string; title?: string; attrs?: Record<string, string> } = {},
  ...children: (Node | string | null | undefined | false)[]
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (props.class) e.className = props.class;
  if (props.text !== undefined) e.textContent = props.text;
  if (props.title) e.title = props.title;
  for (const [k, v] of Object.entries(props.attrs ?? {})) e.setAttribute(k, v);
  for (const c of children) if (c !== null && c !== undefined && c !== false) e.append(c);
  return e;
}

export function button(label: string, onClick: () => void, cls = '', title = ''): HTMLButtonElement {
  const b = h('button', { class: `btn ${cls}`, text: label, title, attrs: { type: 'button' } });
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick();
  });
  return b;
}

/** A segmented control (radio group) returning its root element. */
export function segmented<T extends string | number>(
  name: string,
  options: { value: T; label: string; title?: string }[],
  current: T,
  onChange: (v: T) => void,
): HTMLElement {
  const root = h('div', { class: 'seg', attrs: { role: 'radiogroup', 'aria-label': name } });
  for (const o of options) {
    const b = h('button', { class: `seg-btn${o.value === current ? ' on' : ''}`, text: o.label, title: o.title ?? '', attrs: { type: 'button', role: 'radio', 'aria-checked': String(o.value === current) } });
    b.addEventListener('click', () => {
      for (const x of Array.from(root.children)) {
        x.classList.remove('on');
        x.setAttribute('aria-checked', 'false');
      }
      b.classList.add('on');
      b.setAttribute('aria-checked', 'true');
      onChange(o.value);
    });
    root.append(b);
  }
  return root;
}
