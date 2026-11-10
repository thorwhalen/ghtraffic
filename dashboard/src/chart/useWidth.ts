/** Measure an element's width and follow it as the layout changes (rotation, resize). */
import { useLayoutEffect, useRef, useState } from "react";

export function useWidth<T extends HTMLElement>(initial = 320) {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(initial);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth || initial);
    // ResizeObserver fires when the element itself changes size, not only the window.
    const ro = new ResizeObserver(([entry]) => setWidth(Math.round(entry.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [initial]);
  return [ref, width] as const;
}
