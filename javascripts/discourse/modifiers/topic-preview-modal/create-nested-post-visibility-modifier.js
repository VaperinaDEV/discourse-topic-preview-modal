import { modifier } from "ember-modifier";

// Observes nested-post elements dynamically because NestedPost/children are
// created lazily as the reply tree expands. This keeps timing tracking aligned
// with the core nested view without requiring a change to the core component.
export default function createNestedPostVisibilityModifier({ onVisible }) {
  let observer;
  let mutationObserver;
  let rootElement;
  const observed = new WeakSet();

  function reportIfAlreadyVisible(element, root) {
    const postNumber = parseInt(element.dataset.postNumber, 10);
    if (!postNumber) {
      return;
    }

    const target = element.getBoundingClientRect();
    const bounds = root?.getBoundingClientRect() ?? {
      top: 0,
      left: 0,
      right: window.innerWidth,
      bottom: window.innerHeight,
    };

    if (
      target.bottom > bounds.top &&
      target.top < bounds.bottom &&
      target.right > bounds.left &&
      target.left < bounds.right
    ) {
      onVisible(postNumber);
    }
  }

  function observeElement(element) {
    if (!(element instanceof HTMLElement) || observed.has(element)) {
      return;
    }
    observed.add(element);
    observer.observe(element);
    reportIfAlreadyVisible(element, rootElement);
  }

  function observeTree(element) {
    if (element.matches?.(".nested-post__article[data-post-number], .nested-post__collapsed-bar[data-post-number], .nested-post__placeholder[data-post-number]")) {
      observeElement(element);
    }
    element
      .querySelectorAll?.(
        ".nested-post__article[data-post-number], .nested-post__collapsed-bar[data-post-number], .nested-post__placeholder[data-post-number]"
      )
      .forEach(observeElement);
  }

  function disconnect() {
    mutationObserver?.disconnect();
    observer?.disconnect();
    observer = null;
    mutationObserver = null;
    rootElement = null;
  }

  return modifier((element) => {
    rootElement = element.closest(".d-modal__body") || element;

    observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) {
            return;
          }
          const postNumber = parseInt(entry.target.dataset.postNumber, 10);
          if (postNumber) {
            onVisible(postNumber);
          }
        });
      },
      {
        root: rootElement,
        threshold: 0.1,
      }
    );

    mutationObserver = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        mutation.addedNodes.forEach((node) => {
          if (node instanceof HTMLElement) {
            observeTree(node);
          }
        });
        mutation.removedNodes.forEach((node) => {
          if (node instanceof HTMLElement) {
            node
              .querySelectorAll?.(".nested-post__article[data-post-number], .nested-post__collapsed-bar[data-post-number], .nested-post__placeholder[data-post-number]")
              .forEach((nestedPost) => observer.unobserve(nestedPost));
            if (node.matches?.(".nested-post__article[data-post-number], .nested-post__collapsed-bar[data-post-number], .nested-post__placeholder[data-post-number]")) {
              observer.unobserve(node);
            }
          }
        });
      });
    });

    mutationObserver.observe(element, { childList: true, subtree: true });
    observeTree(element);

    return disconnect;
  });
}
