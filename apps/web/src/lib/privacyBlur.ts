import { useEffect } from 'react';
import { MASK_DOTS, usePrivacy } from './privacy';

const PREFIX = 'barakah-masked-';

/**
 * Paints every masked amount on the page as a soft smudge in its own text colour, through the CSS
 * Custom Highlight API, so the 185 places that print an amount (many inside translated sentences)
 * stay plain strings. Nothing in the DOM changes, so React is unaffected. A highlight cannot read the
 * text's colour once it makes the glyphs transparent, so there is one highlight per colour on screen,
 * each with its own rule. Browsers without the API show the plain dots.
 */
function createPainter() {
  const colors = new Map<string, string>();
  const style = document.createElement('style');
  document.head.append(style);

  const paint = () => {
    const byName = new Map<string, Range[]>();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.nodeValue ?? '';
      let at = text.indexOf(MASK_DOTS);
      if (at === -1 || !node.parentElement) continue;
      const color = getComputedStyle(node.parentElement).color;
      let name = colors.get(color);
      if (!name) {
        name = PREFIX + colors.size;
        colors.set(color, name);
        style.textContent += `::highlight(${name}){color:transparent;text-shadow:0 0 0.35em ${color}}\n`;
      }
      const list = byName.get(name) ?? [];
      for (; at !== -1; at = text.indexOf(MASK_DOTS, at + MASK_DOTS.length)) {
        const range = new Range();
        range.setStart(node, at);
        range.setEnd(node, at + MASK_DOTS.length);
        list.push(range);
      }
      byName.set(name, list);
    }
    for (const name of colors.values()) CSS.highlights.set(name, new Highlight(...(byName.get(name) ?? [])));
  };

  const clear = () => {
    for (const name of colors.values()) CSS.highlights.delete(name);
    style.remove();
  };
  return { paint, clear };
}

/** Keeps the blur in step with the page while privacy mode is on. Mount once, near the root. */
export function usePrivacyBlur(): void {
  const hidden = usePrivacy();
  useEffect(() => {
    if (!hidden || typeof CSS === 'undefined' || !('highlights' in CSS)) return;
    const painter = createPainter();
    let frame = 0;
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(() => ((frame = 0), painter.paint()));
    };
    // Theme switches change colours without touching the text, so attributes on <html> count too.
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, { subtree: true, childList: true, characterData: true });
    observer.observe(document.documentElement, { attributes: true });
    schedule();
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      painter.clear();
    };
  }, [hidden]);
}
