import { test as base, type Browser, type BrowserContext, type BrowserContextOptions } from '@playwright/test';

export { expect, type Page, type Route } from '@playwright/test';

const fontStyles = /^https:\/\/fonts\.googleapis\.com\/css2\?/;
const stubFonts = (context: BrowserContext) => context.route(fontStyles, route => route.fulfill({ contentType: 'text/css', body: '' }));

export async function newApplicationContext(browser: Browser, options: BrowserContextOptions) {
  const context = await browser.newContext(options);
  await stubFonts(context);
  return context;
}

// Application behavior is verified with system fonts; a remote font stylesheet
// must not hold page.goto open or change layout halfway through an interaction.
export const test = base.extend<{ applicationFonts: void }>({
  applicationFonts: [async ({ context }, use) => {
    await stubFonts(context);
    await use();
    await context.unroute(fontStyles);
  }, { auto: true }],
});
