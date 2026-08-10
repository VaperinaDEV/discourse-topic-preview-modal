import { modifier } from "ember-modifier";

// Returns a modifier that reports each post-wrapper element's visibility
// (by `data-post-number`) to `onVisible`, sharing a single lazily-created
// IntersectionObserver across every element it's attached to - matching the
// original `this.visibilityObserver ||= new IntersectionObserver(...)`
// per-component-instance behavior.
//
// IntersectionObserver's first callback fires asynchronously (usually a
// frame or two after `observe()`), so an element that's already fully
// visible the instant it mounts - e.g. a brand new topic with a single post
// and nothing to scroll - can be missed if the modal is closed before that
// first callback lands. To close that race, we also do a synchronous bounds
// check right when we start observing and report immediately if the element
// is already in view.
//
// Call `.disconnect()` on the returned modifier (e.g. from willDestroy) to
// tear down the shared observer; individual elements are unobserved
// automatically as they're removed.
export default function createPostVisibilityModifier({
  rootSelector,
  onVisible,
}) {
  let observer = null;

  function reportIfAlreadyVisible(element, root) {
    const n = parseInt(element.dataset.postNumber, 10);
    if (!n) {
      return;
    }

    const target = element.getBoundingClientRect();
    const bounds = root
      ? root.getBoundingClientRect()
      : { top: 0, left: 0, right: window.innerWidth, bottom: window.innerHeight };

    const isVisible =
      target.bottom > bounds.top &&
      target.top < bounds.bottom &&
      target.right > bounds.left &&
      target.left < bounds.right;

    if (isVisible) {
      onVisible(n);
    }
  }

  const postVisibilityModifier = modifier((element) => {
    const root = document.querySelector(rootSelector);

    observer ||= new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            const n = parseInt(entry.target.dataset.postNumber, 10);
            if (n) {
              onVisible(n);
            }
          }
        });
      },
      {
        root,
        threshold: 0.1,
      }
    );
    observer.observe(element);

    // Synchronous fallback for the "already visible on mount" case -
    // don't rely solely on the observer's async first callback.
    reportIfAlreadyVisible(element, root);

    return () => observer?.unobserve(element);
  });

  postVisibilityModifier.disconnect = () => observer?.disconnect();

  return postVisibilityModifier;
}
