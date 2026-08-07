import type { Page } from 'puppeteer';
import { pageHeight, pageWidth, setWindowProperty } from './helpers';
import { getHeaderAndFooterTemplates } from '../server/render-template';
import { apiLogger } from '../common/logging';
import { cluster } from '../server/cluster';

const previewPdf = async (url: string): Promise<Buffer> =>
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  cluster.execute(async ({ page }: { page: Page }) => {
    try {
      page.on('console', (msg) =>
        apiLogger.debug(`[Headless log] ${msg.text()}`),
      );
      await page.setViewport({ width: pageWidth, height: pageHeight });

      await setWindowProperty(
        page,
        'customPuppeteerParams',
        JSON.stringify({
          puppeteerParams: {
            pageWidth,
            pageHeight,
          },
        }),
      );

      const extraHeaders: Record<string, string> = {};
      if (process.env.MOCK_TOKEN) {
        extraHeaders['Authorization'] = process.env.MOCK_TOKEN;
      }
      await page.setCookie({
        name: 'cs_jwt',
        value: 'bar',
        domain: 'localhost',
      });
      await page.setExtraHTTPHeaders(extraHeaders);

      const pageStatus = await page.goto(url, {
        waitUntil: 'networkidle2',
      });

      if (!pageStatus?.ok()) {
        throw new Error(
          `Puppeteer error while loading the react app: ${pageStatus?.statusText()}`,
        );
      }

      const { headerTemplate, footerTemplate } = getHeaderAndFooterTemplates();

      return await page.pdf({
        format: 'a4',
        printBackground: true,
        displayHeaderFooter: true,
        headerTemplate,
        footerTemplate,
        margin: {
          top: '54px',
          bottom: '54px',
        },
      });
    } finally {
      try {
        await page.close();
      } catch {
        // page may already be closed
      }
    }
  });

export default previewPdf;
