import { modifier } from "ember-modifier";

// How close to the scroll container's max scrollTop still counts as
// "reached the bottom" - a couple of px of slack for subpixel rounding
// across browsers/zoom levels.
const BOTTOM_EPSILON_PX = 4;

// Tracks the post at the active reading position for the progress indicator.
// Shared across all attached elements, mirroring createPostVisibilityModifier.
//
// We use a local tracker instead of core's global `topic:current-post-scrolled`
// event to prevent the modal's scroll position from affecting the background
// topic's progress bar.
//
// The active post is found with a single-point hit-test at `bandPercent`
// down the scroll container. Since posts have no gaps, exactly one post can
// contain that point, avoiding the ambiguous overlap that a broad top-band
// check can produce after jumps.
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

  // The single post whose bounding rect actually contains the waterline
  // point, or null if the waterline currently falls outside every attached
  // post (e.g. above the first one right after mount).
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

    // Unlike full topic pages, compact modals may lack enough content below the
    // last post for the waterline to reach it. Use the scroll limit as a fallback:
    // when no further scrolling is possible, the last post is considered active.
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

    // Waterline missed every post - it's above the first one (top of a
    // short/just-loaded stream) or below the last. Snap to whichever edge
    // it's nearest.
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
