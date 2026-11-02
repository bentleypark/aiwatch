const ROW_HIGHLIGHT = {
  card: { hover: 'hover:bg-[var(--bg2)]', selected: 'bg-[var(--bg2)]' },
  inset: { hover: 'hover:bg-[var(--bg3)]', selected: 'bg-[var(--bg3)]' },
}

export function rowHighlight(onInset) {
  return ROW_HIGHLIGHT[onInset ? 'inset' : 'card']
}
