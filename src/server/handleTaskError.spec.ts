import PdfCache, { PdfStatus } from '../common/pdfCache';
import { UpdateStatus } from './utils';
import { handleTaskError } from './handleTaskError';

jest.mock('../common/kafka', () => ({
  produceMessage: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../common/logging', () => ({
  apiLogger: {
    debug: jest.fn(),
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    warning: jest.fn(),
  },
  formatLogError: (value: unknown) =>
    value instanceof Error ? value.message : String(value),
}));

/*
 * =============================================================================
 * ANALYSIS: Intermittent PDF export failures (RHINENG-24661 / Advisor executive
 * report)
 * =============================================================================
 *
 * Customer symptom (prod, 2026-08-19)
 * -----------------------------------
 * Advisor → Recommendations → "Download executive report" intermittently fails
 * with HTTP 500 and status payload:
 *
 *   collection.error: "Collection failed before this component started"
 *   components[0].error: (same synthetic message)
 *   expectedLength: 1, order: 1
 *
 * Request ID: 79326cf1a912427db91f5462022a94c9
 * Collection ID: 3a1d9c42-8f5e-4c41-bb6a-4dfb4fdcca63
 *
 * Why the error message is misleading
 * -----------------------------------
 * "Collection failed before this component started" is NOT the root cause. It
 * is assigned by clusterTask.ts when isCollectionFailed() is true at the start
 * of a queued component — meaning another failure already invalidated the
 * collection. For single-component reports (expectedLength: 1) this implies a
 * platform bug, not an Advisor template error.
 *
 * Root cause: taskerror handler defeats puppeteer-cluster retries
 * ---------------------------------------------------------------
 * RHINENG-24661 (merged as PR #353, 2026-07-08) moved failure recording out of
 * clusterTask catch blocks so puppeteer-cluster could retry (retryLimit: 2).
 * Karel's review on #353 identified that verifyCollection still invalidated
 * collections too early; Charles removed UpdateStatus(Failed) from catch.
 *
 * However the taskerror handler in cluster.ts still ran on EVERY taskerror,
 * including intermediate failures where puppeteer-cluster passes willRetry=true
 * (see puppeteer-cluster README + Cluster.js:259-261). That handler called
 * UpdateStatus(Failed) immediately, which triggers verifyCollection →
 * invalidateCollection before retries execute.
 *
 * Failure sequence (single-component collection):
 *   1. Attempt 1 fails (timeout, transient Chrome/network, token edge case)
 *   2. taskerror fires with willRetry=true → handler ignores flag → Failed
 *   3. Retry dequeues → isCollectionFailed() true → synthetic skip message
 *   4. Real error from step 2 is overwritten in status API response
 *
 * Production context
 * ------------------
 * - Prod pinned at e6eba940 (app-interface !197755, 2026-07-21) — ~48 commits
 *   behind main; includes #353 but not later fixes.
 * - #362 (in prod) removed reactive 401 refresh that #353 added; only proactive
 *   getValidToken() remains — long reports remain sensitive to token timing.
 * - PR #401 (RHCLOUD-49092) addresses a different bug (missing task data when
 *   webpack bundles puppeteer-cluster); it does NOT check willRetry.
 *
 * Fix
 * ---
 * Respect puppeteer-cluster's willRetry flag: defer UpdateStatus(Failed) until
 * willRetry is false (retries exhausted). Wire willRetry from cluster.on through
 * to handleTaskError.
 *
 * Related: RHCLOUD-47965, RHCLOUD-49092, RHINENG-24661
 * =============================================================================
 */

describe('handleTaskError willRetry guard', () => {
  const pdfCache = PdfCache.getInstance();

  afterEach(() => {
    pdfCache.deleteCollection('willretry-coll');
  });

  it('does not mark collection Failed while willRetry is true', async () => {
    const collectionId = 'willretry-coll';
    const componentId = 'comp-1';
    const realError = 'TimeoutError: Navigation timeout of 120000ms exceeded';

    pdfCache.setExpectedLength(collectionId, 1);
    await UpdateStatus({
      collectionId,
      status: PdfStatus.Generating,
      filepath: '',
      componentId,
      order: 1,
    });

    await handleTaskError(
      new Error(realError),
      { collectionId, componentId, order: 1 },
      true,
    );

    expect(pdfCache.isCollectionFailed(collectionId)).toBe(false);
    expect(pdfCache.getCollection(collectionId).status).toBe(
      PdfStatus.Generating,
    );
  });

  it('records the real error only after retries are exhausted', async () => {
    const collectionId = 'willretry-coll';
    const componentId = 'comp-1';
    const realError = 'TimeoutError: Navigation timeout of 120000ms exceeded';

    pdfCache.setExpectedLength(collectionId, 1);
    await UpdateStatus({
      collectionId,
      status: PdfStatus.Generating,
      filepath: '',
      componentId,
      order: 1,
    });

    await handleTaskError(
      new Error(realError),
      { collectionId, componentId, order: 1 },
      true,
    );
    expect(pdfCache.isCollectionFailed(collectionId)).toBe(false);

    await handleTaskError(
      new Error(realError),
      { collectionId, componentId, order: 1 },
      false,
    );

    const collection = pdfCache.getCollection(collectionId);
    expect(collection.status).toBe(PdfStatus.Failed);
    expect(collection.error).toBe(realError);
    expect(collection.components[0].error).toBe(realError);
    expect(collection.components[0].error).not.toBe(
      'Collection failed before this component started',
    );
  });

  it('does not call UpdateStatus(Failed) while willRetry is true', async () => {
    const utils = await import('./utils');
    const updateStatusSpy = jest
      .spyOn(utils, 'UpdateStatus')
      .mockResolvedValue(undefined);

    await handleTaskError(
      new Error('transient failure'),
      { collectionId: 'coll', componentId: 'comp', order: 1 },
      true,
    );

    expect(updateStatusSpy).not.toHaveBeenCalled();
    updateStatusSpy.mockRestore();
  });
});

describe('handleTaskError retry defeat regression (pre-fix behavior)', () => {
  const pdfCache = PdfCache.getInstance();

  afterEach(() => {
    pdfCache.deleteCollection('retry-defeat-coll');
  });

  /**
   * Documents the customer-facing failure chain when willRetry is ignored.
   * Simulates the old handler recording Failed on the first taskerror, then
   * the clusterTask synthetic skip path on retry.
   */
  it('masks the real retriable error with the synthetic skip message on retry', async () => {
    const collectionId = 'retry-defeat-coll';
    const componentId = '30f682c3-9fce-4aa3-a274-12104e09b941';
    const realError = 'TimeoutError: Navigation timeout of 120000ms exceeded';

    pdfCache.setExpectedLength(collectionId, 1);
    await UpdateStatus({
      collectionId,
      status: PdfStatus.Generating,
      filepath: '',
      componentId,
      order: 1,
    });

    // Old bug: first taskerror treated as final (willRetry ignored)
    await handleTaskError(
      new Error(realError),
      { collectionId, componentId, order: 1 },
      false,
    );

    expect(pdfCache.isCollectionFailed(collectionId)).toBe(true);
    expect(pdfCache.getCollection(collectionId).error).toBe(realError);

    // clusterTask retry path when isCollectionFailed() is true at task start
    await UpdateStatus({
      collectionId,
      status: PdfStatus.Failed,
      filepath: '',
      componentId,
      order: 1,
      error: 'Collection failed before this component started',
    });

    const collection = pdfCache.getCollection(collectionId);
    expect(collection.status).toBe(PdfStatus.Failed);
    expect(collection.expectedLength).toBe(1);
    expect(collection.components).toHaveLength(1);
    expect(collection.error).toBe(
      'Collection failed before this component started',
    );
    expect(collection.components[0].error).toBe(
      'Collection failed before this component started',
    );
    expect(collection.components[0].error).not.toBe(realError);
  });
});

describe('handleTaskError', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('records component failure when task data is present and willRetry is false', async () => {
    const utils = await import('./utils');
    const updateStatusSpy = jest
      .spyOn(utils, 'UpdateStatus')
      .mockResolvedValue(undefined);

    await handleTaskError(
      new Error('task failed'),
      {
        collectionId: 'coll-data',
        componentId: 'comp-data',
        order: 2,
      },
      false,
    );

    expect(updateStatusSpy).toHaveBeenCalledWith({
      collectionId: 'coll-data',
      status: PdfStatus.Failed,
      filepath: '',
      componentId: 'comp-data',
      order: 2,
      error: 'task failed',
    });

    updateStatusSpy.mockRestore();
  });
});
