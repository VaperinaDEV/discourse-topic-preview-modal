import { modifier } from "ember-modifier";

// Slack (px) for "reached the bottom" across browsers/zoom rounding.
const BOTTOM_EPSILON_PX = 4;

// Tracks the post at the active reading position for the progress indicator,
// shared across all attached elements. Uses a local tracker instead of
// core's global `topic:current-post-scrolled` event so the modal's scroll
// doesn't affect the background topic's progress bar. The active post is
// found via a single-point hit-test at `bandPercent` down the container —
// posts have no gaps, so exactly one can contain that point, avoiding the
// ambiguous overlap a broad top-band check produces after jumps.
export default function createProgressTrackerModifier({
  rootSelector,
  onCurrentPostChange,
  bandPercent = 0.25,
}) {
  let root = null;
  let scrollHandler = null;
  let rafId = null;

  // postNumber -> element, for every post wrapper currently mounted.
  const attached = new Map();

  function maxAttached() {
    let max = null;
    for (const n of attached.keys()) {
      if (max == null || n > max) {
        max = n;
      }
    }
    return max;
  }

  function minAttached() {
    let min = null;
    for (const n of attached.keys()) {
      if (min == null || n < min) {
        min = n;
      }
    }
    return min;
  }

  function isAtBottom() {
    if (!root) {
      return false;
    }
    return (
      root.scrollTop + root.clientHeight >=
      root.scrollHeight - BOTTOM_EPSILON_PX
    );
  }

  // The post whose bounding rect contains the waterline point, or null if
  // the waterline falls outside every attached post.
  function postAtWaterline(waterlineY) {
    for (const [postNumber, element] of attached) {
      const rect = element.getBoundingClientRect();
      if (rect.top <= waterlineY && rect.bottom > waterlineY) {
        return postNumber;
      }
    }
    return null;
  }

  function reportCurrent() {
    if (!root || !attached.size) {
      return;
    }

    // Compact modals may lack content below the last post for the waterline
    // to reach — fall back to the scroll limit.
    if (isAtBottom()) {
      onCurrentPostChange(maxAttached());
      return;
    }

    const bounds = root.getBoundingClientRect();
    const waterlineY = bounds.top + bounds.height * bandPercent;

    const hit = postAtWaterline(waterlineY);
    if (hit != null) {
      onCurrentPostChange(hit);
      return;
    }

    // Waterline missed every post — snap to the nearest edge.
    onCurrentPostChange(waterlineY < bounds.top ? minAttached() : maxAttached());
  }

  function onScroll() {
    // rAF-batched: scroll can fire far faster than we need to re-check.
    if (rafId) {
      return;
    }
    rafId = requestAnimationFrame(() => {
      rafId = null;
      reportCurrent();
    });
  }

  const progressTrackerModifier = modifier((element) => {
    root ||= document.querySelector(rootSelector);

    if (root && !scrollHandler) {
      scrollHandler = onScroll;
      root.addEventListener("scroll", scrollHandler, { passive: true });
    }

    const n = parseInt(element.dataset.postNumber, 10);
    if (n) {
      attached.set(n, element);
    }

    reportCurrent();

    return () => {
      const num = parseInt(element.dataset.postNumber, 10);
      if (num) {
        attached.delete(num);
      }
      reportCurrent();
    };
  });

  progressTrackerModifier.disconnect = () => {
    if (root && scrollHandler) {
      root.removeEventListener("scroll", scrollHandler);
    }
    scrollHandler = null;
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    attached.clear();
    root = null;
  };

  return progressTrackerModifier;
}
