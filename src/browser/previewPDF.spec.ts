const mockPage = {
  setViewport: jest.fn(),
  on: jest.fn(),
  goto: jest.fn().mockResolvedValue({ ok: () => true, statusText: () => 'OK' }),
  waitForNetworkIdle: jest.fn(),
  setExtraHTTPHeaders: jest.fn(),
  setCookie: jest.fn(),
  pdf: jest.fn().mockResolvedValue(Buffer.from('%PDF-mock')),
  close: jest.fn(),
};

const mockExecute = jest.fn(
  (taskFn: ({ page }: { page: unknown }) => Promise<unknown>) =>
    taskFn({ page: mockPage }),
);

jest.mock('puppeteer', () => ({
  __esModule: true,
  default: {
    launch: jest.fn().mockResolvedValue({
      newPage: jest.fn().mockResolvedValue(mockPage),
      close: jest.fn(),
    }),
  },
}));

jest.mock('../server/cluster', () => ({
  cluster: {
    execute: mockExecute,
  },
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { default: previewPdf } = require('./previewPDF');

jest.mock('../common/config', () => ({
  __esModule: true,
  default: {
    IS_PRODUCTION: false,
    webPort: 8000,
  },
}));

jest.mock('../common/logging', () => ({
  apiLogger: {
    debug: jest.fn(),
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
  },
}));

jest.mock('./helpers', () => ({
  pageWidth: 1024,
  pageHeight: 768,
  setWindowProperty: jest.fn(),
}));

jest.mock('../server/render-template', () => ({
  getHeaderAndFooterTemplates: () => ({
    headerTemplate: '<div>header</div>',
    footerTemplate: '<div>footer</div>',
  }),
}));

const { setWindowProperty } = jest.requireMock('./helpers');

describe('previewPdf', () => {
  const TEST_URL = 'http://localhost:8000/puppeteer?scope=test';

  beforeEach(() => {
    jest.clearAllMocks();
    mockPage.goto.mockResolvedValue({
      ok: () => true,
      statusText: () => 'OK',
    });
    mockPage.pdf.mockResolvedValue(Buffer.from('%PDF-mock'));
  });

  describe('cluster integration', () => {
    it('uses shared cluster.execute instead of launching a standalone browser', async () => {
      await previewPdf(TEST_URL);

      expect(mockExecute).toHaveBeenCalledTimes(1);
      expect(mockExecute).toHaveBeenCalledWith(expect.any(Function));
    });
  });

  describe('page setup ordering', () => {
    it('calls setWindowProperty BEFORE page.goto', async () => {
      const callOrder: string[] = [];
      setWindowProperty.mockImplementation(() => {
        callOrder.push('setWindowProperty');
        return Promise.resolve();
      });
      mockPage.goto.mockImplementation(() => {
        callOrder.push('goto');
        return Promise.resolve({
          ok: () => true,
          statusText: () => 'OK',
        });
      });

      await previewPdf(TEST_URL);

      const swpIndex = callOrder.indexOf('setWindowProperty');
      const gotoIndex = callOrder.indexOf('goto');
      expect(swpIndex).toBeGreaterThanOrEqual(0);
      expect(gotoIndex).toBeGreaterThanOrEqual(0);
      expect(swpIndex).toBeLessThan(gotoIndex);
    });
  });

  describe('status check ordering', () => {
    it('checks page status BEFORE generating PDF', async () => {
      const callOrder: string[] = [];
      mockPage.goto.mockImplementation(() => {
        callOrder.push('goto');
        return Promise.resolve({
          ok: () => false,
          statusText: () => 'Internal Server Error',
        });
      });
      mockPage.pdf.mockImplementation(() => {
        callOrder.push('pdf');
        return Promise.resolve(Buffer.from(''));
      });

      await expect(previewPdf(TEST_URL)).rejects.toThrow();

      expect(callOrder).toContain('goto');
      expect(callOrder).not.toContain('pdf');
    });
  });

  describe('no hardcoded delays', () => {
    it('does not use setTimeout/delay before network idle', async () => {
      const originalSetTimeout = global.setTimeout;
      const timeoutSpy = jest.spyOn(global, 'setTimeout');

      await previewPdf(TEST_URL);

      const delayishCalls = timeoutSpy.mock.calls.filter(
        ([, ms]) => typeof ms === 'number' && ms >= 500,
      );
      expect(delayishCalls).toHaveLength(0);

      timeoutSpy.mockRestore();
      global.setTimeout = originalSetTimeout;
    });
  });

  describe('successful preview', () => {
    it('returns PDF buffer directly', async () => {
      const expectedBuffer = Buffer.from('%PDF-mock');
      mockPage.pdf.mockResolvedValue(expectedBuffer);

      const result = await previewPdf(TEST_URL);

      expect(result).toEqual(expectedBuffer);
    });

    it('sets viewport dimensions', async () => {
      await previewPdf(TEST_URL);

      expect(mockPage.setViewport).toHaveBeenCalledWith({
        width: 1024,
        height: 768,
      });
    });

    it('generates A4 PDF with headers and footers', async () => {
      await previewPdf(TEST_URL);

      expect(mockPage.pdf).toHaveBeenCalledWith(
        expect.objectContaining({
          format: 'a4',
          printBackground: true,
          displayHeaderFooter: true,
          headerTemplate: '<div>header</div>',
          footerTemplate: '<div>footer</div>',
          margin: { top: '54px', bottom: '54px' },
        }),
      );
    });

    it('navigates with networkidle2', async () => {
      await previewPdf(TEST_URL);

      expect(mockPage.goto).toHaveBeenCalledWith(
        TEST_URL,
        expect.objectContaining({ waitUntil: 'networkidle2' }),
      );
    });
  });

  describe('error handling', () => {
    it('throws on non-ok page response', async () => {
      mockPage.goto.mockResolvedValue({
        ok: () => false,
        statusText: () => 'Not Found',
      });

      await expect(previewPdf(TEST_URL)).rejects.toThrow();
    });

    it('throws on null page response', async () => {
      mockPage.goto.mockResolvedValue(null);

      await expect(previewPdf(TEST_URL)).rejects.toThrow();
    });
  });
});
