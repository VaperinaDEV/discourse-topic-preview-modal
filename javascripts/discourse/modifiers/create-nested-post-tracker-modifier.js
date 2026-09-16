import { modifier } from "ember-modifier";

// Container-level counterpart to create-post-visibility-modifier.js +
// lazy-images.js, for the <Nested> tree, which doesn't template a per-post
// wrapper we could attach those to individually. Instead this attaches once
// to <Nested>'s container and uses a MutationObserver to pick up
// `[data-post-number]` elements as they appear — root posts, lazily-loaded
// children, "load more", newly-expanded branches, sort changes, etc.
export default function createNestedPostTrackerModifier({
  rootSelector,
  onVisible,
}) {
  let intersectionObserver = null;
  let mutationObserver = null;
  const seen = new WeakSet();

  function markImagesLazy(element) {
    element.querySelectorAll("img:not([loading])").forEach((img) => {
      img.setAttribute("loading", "lazy");
      img.setAttribute("decoding", "async");
    });
  }

  function isAlreadyVisible(element, root) {
    const target = element.getBoundingClientRect();
    const bounds = root
      ? root.getBoundingClientRect()
      : { top: 0, left: 0, right: window.innerWidth, bottom: window.innerHeight };

    return (
      target.bottom > bounds.top &&
      target.top < bounds.bottom &&
      target.right > bounds.left &&
      target.left < bounds.right
    );
  }

  function observeElement(element, root) {
    if (seen.has(element)) {
      return;
    }
    seen.add(element);

    markImagesLazy(element);
    intersectionObserver.observe(element);

    // Don't rely solely on IntersectionObserver's async first callback for
    // an element that's already on-screen the moment it's discovered.
    if (isAlreadyVisible(element, root)) {
      const n = parseInt(element.dataset.postNumber, 10);
      if (n) {
        onVisible(n);
      }
    }
  }

  function scan(container, root) {
    container
      .querySelectorAll("[data-post-number]")
      .forEach((element) => observeElement(element, root));
  }

  const nestedPostTrackerModifier = modifier((element) => {
    const root = document.querySelector(rootSelector);

    intersectionObserver = new IntersectionObserver(
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
      { root, threshold: 0.1 }
    );

    mutationObserver = new MutationObserver(() => scan(element, root));
    mutationObserver.observe(element, { childList: true, subtree: true });

    scan(element, root);

    return () => {
      mutationObserver?.disconnect();
      intersectionObserver?.disconnect();
    };
  });

  nestedPostTrackerModifier.disconnect = () => {
    mutationObserver?.disconnect();
    intersectionObserver?.disconnect();
  };

  return nestedPostTrackerModifier;
}
