import { expect, type Page } from '@playwright/test';

/** Answer the in-page confirmation dialog (replaces native window.confirm handling). */
export async function answerDialog(page: Page, accept: boolean, contains: string[] = []) {
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toBeVisible();
  for (const text of contains) await expect(dialog).toContainText(text);
  await dialog.locator(accept ? '[data-confirm]' : '[data-cancel]').click();
  await expect(dialog).toHaveCount(0);
}

/** For flows that previously auto-accepted every native confirm. */
export async function autoAcceptDialogs(page: Page) {
  await page.addLocatorHandler(page.getByRole('alertdialog'), async dialog => { await dialog.locator('[data-confirm]').click(); });
}
