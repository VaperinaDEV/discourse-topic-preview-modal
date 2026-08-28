import { modifier } from "ember-modifier";
import TopicPreviewSwipeUpDismiss from "../../lib/topic-preview-modal/swipe-up-dismiss";

// Finds DModal's own `.d-modal__container` (see rootSelector - same
// document.querySelector-after-render pattern already used by
// create-post-visibility-modifier.js and create-load-more-sentinel-modifier.js
// for other internal DModal nodes) and attaches the independent upward-swipe
// tracker to it directly. `enabled` mirrors core's own dSwipe modifier,
// which no-ops the same way when its own `enabled` arg is false.
//
// Not tied to whichever element this modifier is technically applied to in
// the template - it only uses that element's insert/destroy timing, and
// looks up its real target via rootSelector.
export default function createSwipeUpDismissModifier({
  rootSelector,
  onDismiss,
  canDismiss,
  enabled,
}) {
  return modifier(() => {
    if (!enabled) {
      return;
    }

    const container = document.querySelector(rootSelector);
    if (!container) {
      return;
    }

    const dismisser = new TopicPreviewSwipeUpDismiss({ onDismiss, canDismiss });
    dismisser.attach(container);

    return () => dismisser.detach();
  });
}
