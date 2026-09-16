import { modifier } from "ember-modifier";

// Returns a modifier that reports each post-wrapper element's visibility (by
// `data-post-number`) to `onVisible`, sharing one lazily-created
// IntersectionObserver across every attached element. Also does a synchronous
// bounds check on attach, since an element already fully visible on mount
// (e.g. a short topic that never scrolls) can otherwise be missed if the
// modal closes before the observer's async first callback lands. Call
// `.disconnect()` (e.g. from willDestroy) to tear down the shared observer.
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

    // Fallback for the "already visible on mount" case — see header comment.
    reportIfAlreadyVisible(element, root);

    return () => observer?.unobserve(element);
  });

  postVisibilityModifier.disconnect = () => observer?.disconnect();

  return postVisibilityModifier;
}
