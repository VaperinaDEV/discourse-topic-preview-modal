import {
  getMaxAnimationTimeMs,
  MINIMUM_SWIPE_DISTANCE,
} from "discourse/lib/swipe-events";

// Tolerance for the "already at the bottom of the post list" check below.
// `scrollTop` can be fractional (subpixel layout, browser zoom, high-DPI
// screens) while `scrollHeight`/`clientHeight` are always rounded integers -
// so `scrollHeight - clientHeight` can end up a fraction of a pixel short of
// the real max scroll, even at a position that's visually the very bottom.
// core's own `shouldDeferSwipeToContent` does this comparison with zero
// slack, which is fine for *its* down-swipe case (scrollTop === 0 at the top
// is an exact integer, no rounding involved) but not for a bottom check -
// without this epsilon, a genuine "swipe up right at the last post" would
// occasionally miss the claim by that sub-pixel gap and fall through to
// native scrolling instead, which the browser then renders as its own
// elastic overscroll ("rubber-band") bounce - visible as the text briefly
// stretching, and the modal not dismissing.
const AT_BOTTOM_EPSILON_PX = 2;

// DModal's own swipe-to-dismiss (discourse/components/d-modal or
// discourse/ui-kit/d-modal on newer core) only ever closes on a swipe
// *down* - an upward drag just gets dampened and rubber-banded back to
// rest (see its handleSwipeEnded: `if (swipeEvent.goingUp()) return
// ...snap back`). There's no public argument to add a second direction.
//
// The previous version of this file ran a second, fully independent
// listener alongside DModal's own on the same `.d-modal__container` node,
// both reacting to the same raw touch events, neither one aware of the
// other. That's exactly what produced the reported bugs:
//   - DModal's own tracker was *also* live for every upward drag (its
//     `dampenedOverdrag` gives upward movement a small dampened lift even
//     though it never dismisses on its own) - so on a drag that didn't
//     cross this file's dismiss threshold, that small DModal-driven lift
//     was the *only* visible feedback ("otherwise it lifts a little").
//   - This file never touched the transform during the drag itself, only
//     on release - so nothing tracked the finger in real time, and
//     whichever tracker's `.animate()` call happened to land last on a
//     given frame won, which is why it "didn't always work".
//
// Fix: claim the gesture *before* DModal's own tracker ever sees it,
// instead of running alongside it. This listens in the *capture* phase -
// the same idiom this theme already uses elsewhere for the same reason
// (see click.gjs's `capture=true` link interceptor) - so it always runs
// before DModal's own bubble-phase listener on that element, regardless of
// Ember's internal modifier-attach order or which element the touch
// actually started on. The instant a gesture is confirmed as "swiping up,
// already at the bottom of the scrollable content", every further touch
// event of that gesture gets `stopPropagation()` + `preventDefault()` -
// DModal's own listener then never runs for it at all, so it never
// dampens, tracks, or snaps back a gesture this file has claimed. Once
// claimed, this file drives the container's transform itself, 1:1 with the
// finger, exactly like DModal's own live `handleSwipe` does for the
// downward case - just inverted. Downward drags, and upward drags that
// still have scrollable room below, are left completely untouched - never
// claimed, never even preventDefault'd - so DModal (or native scrolling)
// handles those exactly as if this file weren't here.
//
// Thresholds/easing below are copied from DModal's own (private,
// unexported) constants so an upward dismiss feels identical in weight to
// the native downward one - just inverted. If core ever tunes those, this
// drifts out of sync until updated by hand.
const SWIPE_VELOCITY_THRESHOLD = 0.4; // px/ms
const SWIPE_CLOSE_DISTANCE_RATIO = 0.25; // fraction of container height
const SWIPE_SETTLE_EASING = "cubic-bezier(0.32, 0.72, 0, 1)";

// Mirrors DModal's own dampenedOverdrag: resists movement in the "wrong"
// direction (here, the finger wobbling back down mid-drag without
// releasing) instead of just clamping it to zero, so the gesture still
// feels alive rather than stuck.
function dampenedOverdrag(distance) {
  return Math.max(0, 8 * (Math.log(distance + 1) - 2));
}

// Same walk core's own shouldDeferSwipeToContent does - find the first
// scrollable ancestor between the touch target and `container` - but only
// for the one question this file actually needs ("is there still room to
// scroll down"), and with AT_BOTTOM_EPSILON_PX slack on the bottom edge.
// (Doesn't handle column-reverse scrollers the way core's version does -
// not a layout this modal's post list uses.)
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

  // onDismiss: called once a genuine upward dismiss is confirmed - after
  //   this file's own fling-away animation has already finished.
  // canDismiss: checked right before claiming a gesture, so this stays in
  //   sync with the modal's own live `dismissable` state (composer open, a
  //   sub-modal or fk-menu open, etc.) even though the listener itself is
  //   attached once.
  constructor({ onDismiss, canDismiss }) {
    this.#onDismiss = onDismiss;
    this.#canDismiss = canDismiss;
  }

  attach(container) {
    this.#container = container;
    // Same computation DModal itself uses for its own backdrop reference
    // (`this._wrapperElement.nextElementSibling`) - `container`'s parent is
    // that same wrapper element (`.d-modal`), and the backdrop is its next
    // sibling in the markup.
    this.#backdrop = container.parentElement?.nextElementSibling;

    // capture: true is the whole fix - see file header. passive: false so
    // preventDefault() is actually allowed once a gesture is claimed.
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

      // Same rule DModal's own gesture uses to stay out of the post list's
      // way: if there's still scrollable content in the direction of
      // travel (e.g. more posts below), this is a normal scroll, not a
      // dismiss attempt - only swiping up once already at the bottom of
      // the content counts. Down/left/right are never ours either way.
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

    // Claimed: this gesture is ours from here on. Stop DModal's own
    // bubble-phase listener on the same element from ever seeing it, and
    // stop the browser from also trying to natively rubber-band the
    // already-at-its-bound scrolled body underneath.
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
    this.#animateTo(position, 0);
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

  #animateTo(position, duration) {
    const container = this.#container;
    if (!container) {
      return;
    }

    if (this.#backdrop) {
      // Same formula DModal's own #animateBackdropOpacity uses: fades out
      // proportionally to distance dragged, clamped so it never exceeds
      // the backdrop's own resting CSS opacity.
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
  }

  #clearInlineStyles() {
    // .animate({fill: "forwards"}) applies its result as a *compositor*
    // effect, not an inline style - so there's nothing left to reset
    // manually once the container itself is torn down with the modal. This
    // exists only for the (rare) case detach() runs without the element
    // being removed from the document.
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
    // from wherever the finger left it.
    const animation = container.animate(
      [{ transform: "translateY(-100%)" }],
      { fill: "forwards", duration, easing: SWIPE_SETTLE_EASING }
    );

    const dismiss = () => this.#onDismiss();
    animation.finished.then(dismiss, dismiss);
  }
}
