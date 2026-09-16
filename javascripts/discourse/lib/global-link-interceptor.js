import TopicPreviewModal from "../components/modal/topic-preview-modal";
import { trackTopicVisit } from "./prefetch";
import { matchTopicLink } from "./topic-link";
import { triggerHaptic } from "./haptic";
import { findKnownCategoryId, isCategoryExcluded } from "./excluded-categories";

// Capture-phase document click listener that opens the preview modal for any
// link pointing to a topic, anywhere on the page. Left alone (already handled
// elsewhere): .topic-list-item (click.gjs/button-trigger.gjs), links inside
// the modal itself (handleInternalLinkClick + the routeTo patch in
// service-patches.js), and links to the topic already open on its own page.
//
// Called once from the api-initializer when settings.open_all_topic_links
// is enabled.
export function installGlobalTopicLinkInterceptor(api) {
  document.addEventListener(
    "click",
    (event) => handleClick(event, api),
    true
  );
}

function handleClick(event, api) {
  if (event.defaultPrevented || event.button !== 0) {
    return;
  }
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
    return;
  }

  const link = event.target.closest?.("a[href]");
  if (!link) {
    return;
  }

  const rawHref = link.getAttribute("href") || "";
  // In-page anchors resolve to the current pathname below — bail first.
  if (rawHref.startsWith("#")) {
    return;
  }
  if (link.target && link.target !== "_self") {
    return;
  }
  if (link.hasAttribute("download")) {
    return;
  }
  if (
    link.closest(
      ".topic-list-item, .topic-preview-modal, .topic-preview-modal__scrubber-modal"
    )
  ) {
    return;
  }

  let url;
  try {
    url = new URL(link.href, window.location.origin);
  } catch {
    return;
  }
  if (url.origin !== window.location.origin) {
    return;
  }

  const match = matchTopicLink(url.pathname);
  if (!match) {
    return;
  }

  // Already reading this topic's full page — let core handle the in-page jump.
  const currentMatch = matchTopicLink(window.location.pathname);
  if (currentMatch && currentMatch.topicId === match.topicId) {
    return;
  }

  // Only intercept once we can confirm the category isn't excluded; unknown
  // categories keep the default behavior and open the modal.
  if (isCategoryExcluded(findKnownCategoryId(api, match.topicId))) {
    return;
  }

  event.preventDefault();
  event.stopPropagation();

  const topic = { id: match.topicId, slug: match.slug };
  trackTopicVisit(topic);

  const capabilities = api.container.lookup("service:capabilities");
  triggerHaptic(capabilities, "open");

  api.container.lookup("service:modal").show(TopicPreviewModal, {
    model: { topic, postNumber: match.postNumber },
  });
}
