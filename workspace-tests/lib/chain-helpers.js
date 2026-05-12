/** Responsibility chain link order */
export const CHAIN_LINKS = ["plan", "build", "verify", "review", "accept"];

/** Maps chain link to the role that handles it */
export const LINK_TO_ROLE = {
  plan: "planner",
  build: "builder",
  verify: "verifier",
  review: "reviewer",
  accept: "accepter",
};

/** Maps each link to the next link in the chain (null for terminal) */
export const LINK_NEXT = {
  plan: "build",
  build: "verify",
  verify: "review",
  review: "accept",
  accept: null,
};

/**
 * Returns a function that generates the next chain-link task params
 * based on a completed task. Used as MockWorker's createNextInChain callback.
 *
 * Usage:
 *   const next = chainFactory("chain-1", "Build API");
 *   const params = next(completedTask);  // => { title, description, link, chainId }
 */
export function chainFactory(chainId, baseTitle) {
  return function createNext(completedTask) {
    const currentLink = completedTask.link;
    if (!currentLink) return null;

    const nextLink = LINK_NEXT[currentLink];
    if (!nextLink) return null; // chain complete

    return {
      title: `${baseTitle} — ${nextLink.toUpperCase()}`,
      description: `Chain step: ${currentLink} → ${nextLink}`,
      priority: 1,
      link: nextLink,
      chainId,
      parentTaskId: completedTask.id,
    };
  };
}
