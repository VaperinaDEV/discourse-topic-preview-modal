function excludedCategoryIds() {
  return (settings.excluded_categories || "")
    .split("|")
    .filter(Boolean)
    .map(Number);
}

export function isCategoryExcluded(categoryId) {
  if (!categoryId) {
    return false;
  }
  return excludedCategoryIds().includes(Number(categoryId));
}

// Best-effort synchronous lookup for topics where only the ID is known.
// Checks the store first, then topic-tracking-state. Returns null if unknown.
export function findKnownCategoryId(api, topicId) {
  try {
    const cached = api.container
      .lookup("service:store")
      .peekRecord("topic", topicId);

    if (cached?.category_id) {
      return cached.category_id;
    }

    const state = api.container
      .lookup("service:topic-tracking-state")
      .findState(topicId);

    return state?.category_id ?? null;
  } catch {
    return null;
  }
}