import { apiLogger, formatLogError } from '../common/logging';
import PdfCache, { PdfStatus } from '../common/pdfCache';
import { UpdateStatus } from './utils';

export async function handleTaskError(
  err: Error,
  data: unknown,
  willRetry = false,
): Promise<void> {
  apiLogger.error(
    `Puppeteer cluster task error: ${formatLogError(err)} data: ${formatLogError(data)}`,
  );

  if (willRetry) {
    apiLogger.warning(
      `Task will retry, deferring failure recording: ${formatLogError(err)}`,
    );
    return;
  }

  // After all retries exhausted, record component failure and invalidate collection
  if (data && typeof data === 'object' && 'collectionId' in data) {
    const collectionId = (data as { collectionId: string }).collectionId;
    const componentId = (data as { componentId?: string }).componentId;
    const order = (data as { order?: number }).order;
    const message = err instanceof Error ? err.message : String(err);
    apiLogger.error(
      `Collection ${collectionId} failed after retries: ${message}`,
    );

    // Record component as Failed if componentId available
    if (componentId) {
      await UpdateStatus({
        collectionId,
        status: PdfStatus.Failed,
        filepath: '',
        componentId,
        order,
        error: message,
      });
      // UpdateStatus → verifyCollection → invalidateCollection (happens here)
    } else {
      // No componentId - directly invalidate collection
      PdfCache.getInstance().invalidateCollection(collectionId, message);
    }
  }
}
