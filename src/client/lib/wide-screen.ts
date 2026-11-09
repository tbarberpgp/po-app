import { useEffect, useState } from "react";

/** Room for a list and its preview panel side by side. Narrower than this the
 *  panel only opens on a click, so the list keeps the width on a phone. */
export function useWideScreen(): boolean {
  const query = "(min-width: 1100px)";
  const [wide, setWide] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setWide(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return wide;
}
