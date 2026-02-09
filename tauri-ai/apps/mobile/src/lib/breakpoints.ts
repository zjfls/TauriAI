import { useEffect, useMemo, useState } from "react";

export type LayoutSize = "compact" | "medium" | "expanded";

function getLayoutSize(width: number): LayoutSize {
  if (width >= 1024) return "expanded";
  if (width >= 768) return "medium";
  return "compact";
}

export function useLayoutSize(): LayoutSize {
  const [width, setWidth] = useState(() => window.innerWidth);

  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener("resize", onResize, { passive: true });
    return () => window.removeEventListener("resize", onResize);
  }, []);

  return useMemo(() => getLayoutSize(width), [width]);
}

