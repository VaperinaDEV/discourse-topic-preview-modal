import { modifier } from "ember-modifier";

// Returns a modifier for the "load more below" sentinel element: fires
// `onIntersect` once the sentinel scrolls into view within `rootSelector`.
export default function createLoadMoreSentinelModifier({
  rootSelector,
  onIntersect,
}) {
  return modifier((element) => {
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          onIntersect();
        }
      },
      {
        root: document.querySelector(rootSelector),
        rootMargin: "200px",
      }
    );
    obs.observe(element);
    return () => obs.disconnect();
  });
}
