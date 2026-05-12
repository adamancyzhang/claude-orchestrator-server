/**
 * Shared test utilities for workspace E2E tests.
 * Uses dynamic imports to ensure ZK_ROOT_PATH env var is set before paths.ts evaluates.
 */

/** Simple assertion that throws on failure */
export function assert(condition, message) {
  if (!condition) {
    throw new Error(`ASSERTION FAILED: ${message}`);
  }
}

/** Promise-based delay */
export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Recursively delete a ZK path and all children.
 * Handles EPHEMERAL nodes (which disappear on disconnect) gracefully.
 */
export async function rmr(zk, absPath) {
  try {
    const children = await zk.getChildren(absPath);
    for (const child of children) {
      await rmr(zk, `${absPath}/${child}`);
    }
    await zk.remove(absPath);
  } catch (e) {
    // -101 = NO_NODE, -115 = NOT_EMPTY (ephemeral child already cleaned)
    // ZCONNECTIONLOSS / SESSIONEXPIRED = zk is disconnected
    if (e.code !== -101) throw e;
  }
}

/**
 * Wrap a test function with setup/teardown and PASS/FAIL output.
 * The callback receives a connected `zk` client.
 * `rootPath` is cleaned up via rmr, then the zk session is disconnected.
 *
 * IMPORTANT: do NOT call zk.disconnect() inside the test function.
 * Use a separate ZkClient for disconnect-scenario tests.
 */
export async function runScenario(name, zkHosts, rootPath, fn) {
  const start = Date.now();
  const zk = new (await import("../../dist/zk/client.js")).ZkClient(zkHosts);
  try {
    await zk.connect();
    await fn(zk);
    console.log(`PASS [${Date.now() - start}ms] ${name}`);
  } catch (err) {
    console.log(`FAIL [${Date.now() - start}ms] ${name}`);
    console.error(`  ${err.stack || err.message}`);
    process.exitCode = 1;
  } finally {
    // Clean up with best-effort rmr, then force-disconnect
    try {
      await rmr(zk, rootPath);
    } catch (_) {
      // Path may already be cleaned or session expired — ok
    }
    try {
      await zk.disconnect();
    } catch (_) {
      /* best-effort */
    }
  }
}
