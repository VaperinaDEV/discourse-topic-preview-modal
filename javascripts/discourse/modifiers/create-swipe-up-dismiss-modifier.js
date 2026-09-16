import { modifier } from "ember-modifier";
import TopicPreviewSwipeUpDismiss from "../lib/swipe-up-dismiss";

// Finds DModal's own `.d-modal__container` via rootSelector (same
// after-render lookup pattern as create-post-visibility-modifier.js) and
// attaches the upward-swipe tracker to it directly — not to whatever element
// this modifier is applied to in the template, which is only used for
// insert/destroy timing. `enabled` mirrors core's dSwipe modifier.
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
