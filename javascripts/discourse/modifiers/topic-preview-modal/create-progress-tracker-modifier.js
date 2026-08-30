import { modifier } from "ember-modifier";

// How close to the scroll container's max scrollTop still counts as
// "reached the bottom" - a couple of px of slack for subpixel rounding
// across browsers/zoom levels.
const BOTTOM_EPSILON_PX = 4;

// Scrollspy-style tracker for the progress indicator: reports the post
// number currently occupying the "active reading" position in the scroll
// container. Shares tracking across every element it's attached to,
// mirroring createPostVisibilityModifier's shape.
//
// We deliberately don't reuse core's `topic:current-post-scrolled` appEvent
// here: that's a *global* bus, and core's own TopicNavigation/TopicProgress
// (on the real topic page underneath, if any) listen to the same channel.
// Piggybacking on it from inside the modal would make our scroll position
// drive - or fight with - the background page's progress bar whenever the
// modal is opened while already reading a topic. Keeping our own local
// tracker avoids that cross-talk entirely.
//
// The "current" post is found via a single-point hit-test against a
// waterline `bandPercent` of the way down the scroll container, rather than
// by checking which posts overlap a broad top band. Posts are stacked with
// no gaps, so exactly one post can ever contain a given point - a broad-band
// overlap check, by contrast, can match two posts at once right after a
// jump (a sliver of the previous post plus the top of the target post both
// sitting in the band a few px apart), and picking "whichever is smaller"
// then shows the post you just left instead of the one you jumped to, until
// you scroll far enough to clear the sliver.
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

    // In a full topic page there's always enough content (reply box,
    // suggested topics...) below the last post for the waterline to reach
    // it. In this compact modal there often isn't, so the last post can sit
    // fully on screen above the waterline without ever containing it - the
    // progress bar would then cap one short of the real total. Scroll
    // position itself is the reliable signal here: once you can't scroll
    // any further, whatever is last is what you're looking at, regardless
    // of where it sits in the viewport.
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
