import {
  getMaxAnimationTimeMs,
  MINIMUM_SWIPE_DISTANCE,
} from "discourse/lib/swipe-events";

// Tolerance for subpixel rounding when checking if the post list is at the bottom.
const AT_BOTTOM_EPSILON_PX = 2;

// DModal only supports downward swipe-to-dismiss. This modifier handles
// upward dismissal when the post list is already at the bottom.
//
// Claim upward gestures in the capture phase so DModal does not process
// the same gesture. Once claimed, the modal follows the finger 1:1 and
// uses the same thresholds and easing as DModal's downward dismissal.
//
// Thresholds and easing mirror DModal's private values and may need updating
// if core changes them.
const SWIPE_VELOCITY_THRESHOLD = 0.4; // px/ms
const SWIPE_CLOSE_DISTANCE_RATIO = 0.25; // fraction of container height
const SWIPE_SETTLE_EASING = "cubic-bezier(0.32, 0.72, 0, 1)";

// Mirrors DModal's dampened overdrag for smoother movement against the gesture direction.
function dampenedOverdrag(distance) {
  return Math.max(0, 8 * (Math.log(distance + 1) - 2));
}

// Mirrors core's shouldDeferSwipeToContent for this modal's scrollable
// ancestor, with bottom-edge tolerance. Column-reverse is not needed here.
function hasScrollableRoomBelow(target, container) {
  let element = target;
  while (element && element !== container) {
    if (element.scrollHeight > element.clientHeight) {
      const style = window.getComputedStyle(element);
      if (style.overflowY === "auto" || style.overflowY === "scroll") {
        const maxScroll = element.scrollHeight - element.clientHeight;
        return element.scrollTop < maxScroll - AT_BOTTOM_EPSILON_PX;
      }
    }
    element = element.parentElement;
  }
  return false;
}

export default class TopicPreviewSwipeUpDismiss {
  #onDismiss;
  #canDismiss;
  #container;
  #backdrop;
  #state = null;

  // onDismiss: called after a confirmed upward dismiss and its animation.
  // canDismiss: checked before claiming the gesture to respect the modal's
  // current dismissable state.
  constructor({ onDismiss, canDismiss }) {
    this.#onDismiss = onDismiss;
    this.#canDismiss = canDismiss;
  }

  attach(container) {
    this.#container = container;
    // Matches DModal's backdrop reference via the wrapper's next sibling.
    this.#backdrop = container.parentElement?.nextElementSibling;

    // Capture phase prevents DModal from handling the gesture; passive: false
    // allows preventDefault() after claiming it.
    const opts = { capture: true, passive: false };
    container.addEventListener("touchstart", this.#onTouchStart, opts);
    container.addEventListener("touchmove", this.#onTouchMove, opts);
    container.addEventListener("touchend", this.#onTouchEnd, opts);
    container.addEventListener("touchcancel", this.#onTouchCancel, opts);
  }

  detach() {
    const container = this.#container;
    if (!container) {
      return;
    }
    // Only `capture` needs to match to remove a listener - `passive`
    // doesn't affect listener identity.
    const opts = { capture: true };
    container.removeEventListener("touchstart", this.#onTouchStart, opts);
    container.removeEventListener("touchmove", this.#onTouchMove, opts);
    container.removeEventListener("touchend", this.#onTouchEnd, opts);
    container.removeEventListener("touchcancel", this.#onTouchCancel, opts);
    this.#clearInlineStyles();
    this.#container = null;
    this.#backdrop = null;
    this.#state = null;
  }

  #onTouchStart = (e) => {
    // Multitouch cancels the gesture, matching DModal's own SwipeEvents.
    if (e.touches.length > 1) {
      this.#state = null;
      return;
    }
    const touch = e.touches[0];
    this.#state = {
      startX: touch.clientX,
      startY: touch.clientY,
      lastY: touch.clientY,
      lastT: Date.now(),
      deltaY: 0,
      velocityY: 0,
      direction: null,
      deferred: false,
      claimed: false,
    };
    // Deliberately doesn't stop propagation yet - ownership isn't decided
    // until the first real move. DModal's own touchstart handler just
    // initializes its own state the same way, harmlessly.
  };

  #onTouchMove = (e) => {
    const state = this.#state;
    if (!state || e.touches.length > 1) {
      return;
    }

    const touch = e.touches[0];
    const deltaX = touch.clientX - state.startX;
    const deltaY = touch.clientY - state.startY;

    if (!state.direction) {
      // Same 5px settle DModal's own tracker waits out before committing to
      // a direction, so a light tap-and-lift never counts as a swipe.
      if (
        Math.abs(deltaX) < MINIMUM_SWIPE_DISTANCE &&
        Math.abs(deltaY) < MINIMUM_SWIPE_DISTANCE
      ) {
        return;
      }

      state.direction =
        Math.abs(deltaX) > Math.abs(deltaY)
          ? deltaX > 0
            ? "right"
            : "left"
          : deltaY > 0
            ? "down"
            : "up";

      // Let normal scrolling handle gestures while content remains scrollable.
      // Only an upward swipe at the bottom can trigger dismissal.
      const notOurs =
        state.direction !== "up" ||
        hasScrollableRoomBelow(e.target, this.#container) ||
        !this.#canDismiss?.();

      if (notOurs) {
        state.deferred = true;
        return; // leave this gesture for DModal / native scroll, untouched
      }

      state.claimed = true;
    }

    if (!state.claimed) {
      return;
    }

    // Claim the gesture to block DModal and native rubber-banding.
    e.stopPropagation();
    e.preventDefault();

    const now = Date.now();
    const dt = now - state.lastT;
    if (dt > 0) {
      state.velocityY = (touch.clientY - state.lastY) / dt;
    }
    state.lastY = touch.clientY;
    state.lastT = now;
    state.deltaY = deltaY;

    // Applied instantly on every move so the modal tracks the finger 1:1 -
    // same as DModal's own live handleSwipe, just inverted (and dampening
    // a downward wobble instead of an upward one).
    const position = deltaY <= 0 ? deltaY : dampenedOverdrag(deltaY);
    this.#setLivePosition(position);
  };

  #onTouchEnd = (e) => {
    const state = this.#state;
    this.#state = null;

    if (!state?.claimed) {
      return;
    }

    e.stopPropagation();

    const closeDistance =
      this.#container.clientHeight * SWIPE_CLOSE_DISTANCE_RATIO;
    const distance = Math.abs(state.deltaY);
    const velocity = Math.abs(state.velocityY);

    if (
      state.deltaY >= 0 ||
      (velocity < SWIPE_VELOCITY_THRESHOLD && distance < closeDistance)
    ) {
      // Below threshold (or drifted back down at release) - settle back to
      // rest ourselves, since DModal never tracked this gesture to have a
      // snap-back of its own to fall back on.
      this.#animateTo(0, getMaxAnimationTimeMs());
      return;
    }

    this.#flingAwayAndDismiss();
  };

  #onTouchCancel = (e) => {
    const state = this.#state;
    this.#state = null;
    if (state?.claimed) {
      e.stopPropagation();
      this.#animateTo(0, getMaxAnimationTimeMs());
    }
  };

  // Apply the drag position directly instead of creating a new animation on
  // every touchmove. Inline styles update synchronously and avoid stale
  // compositor values or accumulating finished animations.
  #setLivePosition(position) {
    const container = this.#container;
    if (!container) {
      return;
    }
    container.style.transform = `translateY(${position}px)`;
    if (this.#backdrop) {
      // Same formula DModal's own #animateBackdropOpacity uses: fades out
      // proportionally to distance dragged, clamped so it never exceeds
      // the backdrop's own resting CSS opacity.
      const opacity = 1 - Math.abs(position) / container.clientHeight;
      this.#backdrop.style.opacity = Math.max(0, Math.min(opacity, 0.6));
    }
  }

  #animateTo(position, duration) {
    const container = this.#container;
    if (!container) {
      return;
    }

    if (this.#backdrop) {
      const opacity = 1 - Math.abs(position) / container.clientHeight;
      this.#backdrop.animate(
        [{ opacity: Math.max(0, Math.min(opacity, 0.6)) }],
        { fill: "forwards", duration }
      );
    }

    container.animate([{ transform: `translateY(${position}px)` }], {
      fill: "forwards",
      duration,
      easing: SWIPE_SETTLE_EASING,
    });

    // The animate() calls above already captured their "from" keyframe
    // synchronously from the inline styles #setLivePosition wrote during the
    // drag - safe to clear them now so they don't linger under the real
    // Animation (see #setLivePosition).
    this.#clearLiveStyles();
  }

  #clearLiveStyles() {
    if (this.#container) {
      this.#container.style.transform = "";
    }
    if (this.#backdrop) {
      this.#backdrop.style.opacity = "";
    }
  }

  #clearInlineStyles() {
    this.#clearLiveStyles();
    // Animation effects are removed with the modal; reset only if the element remains.
    this.#container?.getAnimations?.().forEach((a) => a.cancel());
    this.#backdrop?.getAnimations?.().forEach((a) => a.cancel());
  }

  // Mirrors DModal's own private #animateSwipeDismiss(), just upward.
  #flingAwayAndDismiss() {
    const container = this.#container;
    const backdrop = this.#backdrop;
    const duration = getMaxAnimationTimeMs();

    if (backdrop) {
      backdrop.animate([{ opacity: 0 }], { fill: "forwards", duration });
    }

    // Single-keyframe form: the browser fills in the "from" state from the
    // container's current computed transform, so this picks up smoothly
    // from wherever the finger left it - reliably, now that #setLivePosition
    // is a plain style write rather than a same-tick Animation.
    const animation = container.animate(
      [{ transform: "translateY(-100%)" }],
      { fill: "forwards", duration, easing: SWIPE_SETTLE_EASING }
    );

    this.#clearLiveStyles();

    const dismiss = () => this.#onDismiss();
    animation.finished.then(dismiss, dismiss);
  }
}
