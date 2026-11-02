/**
 * Draws a B+ tree as a frond: internal pages are stems near the top, leaf
 * pages hang along the bottom, each with a bar showing how full the page is.
 */
import { formatValue, type TreeView } from '../src/index.ts';

const SVG = 'http://www.w3.org/2000/svg';

type NodeView = TreeView['levels'][number][number];

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, parent?: Element): SVGElementTagNameMap[K] {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  parent?.appendChild(e);
  return e;
}

const keyText = (k: unknown[]) => k.map((v) => formatValue(v as never)).join(',');

export interface TreeRenderOptions {
  /** Draw every key inside its page (for small trees). */
  showKeys: boolean;
  /** Page ids to highlight, e.g. pages touched by the last operation. */
  changed?: Set<number>;
  onHover?: (text: string | null, ev?: MouseEvent) => void;
  /** Squeeze leaves to fit this many pixels (for large trees drawn without keys). */
  fitWidth?: number;
}

export function describeNode(view: TreeView, n: NodeView): string {
  const fill = Math.round((n.bytes / view.pageSize) * 100);
  const lines = [
    `${n.kind === 'leaf' ? 'Leaf' : 'Internal'} page ${n.id}`,
    `${n.keys.length} ${n.kind === 'leaf' ? 'rows' : 'separator keys'}, ${n.bytes} of ${view.pageSize} bytes (${fill}%)`,
  ];
  if (n.keys.length > 0) lines.push(`keys ${keyText(n.keys[0]!)} … ${keyText(n.keys.at(-1)!)}`);
  if (n.kind === 'internal') lines.push(`${n.children.length} children`);
  if (n.overflowCells > 0) lines.push(`${n.overflowCells} values in overflow pages`);
  if (n.kind === 'leaf' && n.next) lines.push(`next leaf: page ${n.next}`);
  return lines.join('\n');
}

export function renderTree(view: TreeView, opts: TreeRenderOptions): SVGSVGElement {
  const levels = view.levels;
  const leafLevel = levels.length - 1;
  const charW = 6.7;
  const pad = 16;
  const levelGap = opts.showKeys ? 74 : 86;
  const leafH = opts.showKeys ? 26 : 64;
  const nodeH = opts.showKeys ? 26 : 12;
  const leafCount = levels[leafLevel]?.length ?? 0;
  const slot = opts.showKeys || !opts.fitWidth ? 12 : Math.max(1.6, Math.min(14, (opts.fitWidth - pad * 2) / Math.max(1, leafCount)));

  const width = (n: NodeView, depth: number): number => {
    if (opts.showKeys) return Math.max(28, n.keys.map(keyText).join('  ').length * charW + 14);
    return depth === leafLevel ? Math.max(1.5, slot * 0.72) : 12;
  };

  // Lay out leaves left to right, then centre each parent over its children.
  const pos = new Map<number, { x: number; y: number; w: number; h: number; n: NodeView; depth: number }>();
  let x = pad;
  const gap = opts.showKeys ? 10 : slot * 0.28;
  const leaves = levels[leafLevel] ?? [];
  for (const n of leaves) {
    const w = width(n, leafLevel);
    pos.set(n.id, { x, y: pad + leafLevel * levelGap, w, h: leafH, n, depth: leafLevel });
    x += w + gap;
  }
  for (let d = leafLevel - 1; d >= 0; d--) {
    let cursor = pad;
    const innerGap = opts.showKeys ? gap : 2;
    for (const n of levels[d]!) {
      const w = width(n, d);
      const kids = n.children.map((c) => pos.get(c)).filter((p) => p !== undefined);
      let cx = kids.length > 0 ? (kids[0]!.x + kids.at(-1)!.x + kids.at(-1)!.w) / 2 : cursor + w / 2;
      cx = Math.max(cx, cursor + w / 2);
      pos.set(n.id, { x: cx - w / 2, y: pad + d * levelGap, w, h: nodeH, n, depth: d });
      cursor = cx + w / 2 + innerGap;
      x = Math.max(x, cursor);
    }
  }

  const totalW = Math.max(x + pad, 320);
  const totalH = pad * 2 + leafLevel * levelGap + leafH + (opts.showKeys ? 0 : 4);
  const svg = el('svg', { width: totalW, height: totalH, viewBox: `0 0 ${totalW} ${totalH}`, role: 'img', 'aria-label': `B+ tree of ${view.name}: ${levels.length} levels, ${leaves.length} leaf pages` });

  const stems = el('g', {}, svg);
  for (const p of pos.values()) {
    for (const c of p.n.children) {
      const q = pos.get(c);
      if (!q) continue;
      const x1 = p.x + p.w / 2;
      const y1 = p.y + p.h;
      const x2 = q.x + q.w / 2;
      const y2 = q.y;
      const my = (y1 + y2) / 2;
      el('path', { class: 'stem', d: `M${x1},${y1} C${x1},${my} ${x2},${my} ${x2},${y2}` }, stems);
    }
  }

  const pages = el('g', {}, svg);
  for (const p of pos.values()) {
    const g = el('g', { class: 'hit', tabindex: 0 }, pages);
    const changed = opts.changed?.has(p.n.id) ? ' changed' : '';
    const isLeaf = p.n.kind === 'leaf';
    el('rect', { class: `page ${isLeaf ? 'leaf' : 'internal'}${changed}`, x: p.x, y: p.y, width: p.w, height: p.h, rx: opts.showKeys ? 4 : Math.min(2, p.w / 3) }, g);
    if (isLeaf && !opts.showKeys) {
      const fill = Math.min(1, p.n.bytes / view.pageSize);
      const h = Math.max(1, (p.h - 4) * fill);
      const inset = p.w > 6 ? 2 : 0;
      el('rect', { class: 'fill', x: p.x + inset, y: p.y + p.h - inset - h, width: Math.max(1, p.w - inset * 2), height: h }, g);
    }
    if (opts.showKeys) {
      const t = el('text', { x: p.x + 7, y: p.y + p.h / 2 + 4 }, g);
      t.textContent = p.n.keys.length ? p.n.keys.map(keyText).join('  ') : '∅';
      if (!p.n.keys.length) t.setAttribute('class', 'dim');
    }
    const text = describeNode(view, p.n);
    g.addEventListener('mouseenter', (ev) => opts.onHover?.(text, ev));
    g.addEventListener('mousemove', (ev) => opts.onHover?.(text, ev));
    g.addEventListener('mouseleave', () => opts.onHover?.(null));
    g.addEventListener('focus', () => opts.onHover?.(text));
    g.addEventListener('blur', () => opts.onHover?.(null));
  }
  return svg;
}
