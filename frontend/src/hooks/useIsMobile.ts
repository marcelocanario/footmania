import { useEffect, useState } from "react";

export function useIsMobile(breakpoint = 880): boolean {
  const [mobile, setMobile] = useState(
    () => typeof window !== "undefined" && window.matchMedia(`(max-width: ${breakpoint}px)`).matches
  );

  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${breakpoint}px)`);
    const onChange = (e: MediaQueryListEvent) => setMobile(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [breakpoint]);

  return mobile;
}
