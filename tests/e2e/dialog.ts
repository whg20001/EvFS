import { expect, type Page } from '@playwright/test';

/** Open the current module menu; callers can then answer the unsaved-input guard. */
export async function openModule(page: Page, title: string) {
  await page.getByRole('button', { name: '全部模块', exact: true }).click();
  await page.getByRole('dialog', { name: '全部模块', exact: true }).getByRole('button', { name: new RegExp(`^${title} `) }).click();
}

/** Answer the in-page confirmation dialog (replaces native window.confirm handling). */
export async function answerDialog(page: Page, accept: boolean, contains: string[] = []) {
  const dialog = page.getByRole('alertdialog').filter({ has: page.locator('[data-confirm]') });
  await expect(dialog).toBeVisible();
  for (const text of contains) await expect(dialog).toContainText(text);
  await dialog.locator(accept ? '[data-confirm]' : '[data-cancel]').click();
  await expect(dialog).toHaveCount(0);
}

/** For flows that previously auto-accepted every native confirm. */
export async function autoAcceptDialogs(page: Page) {
  await page.addLocatorHandler(page.getByRole('alertdialog'), async () => {
    // A feedback notice may open over a pending confirmation. Follow the live
    // foreground dialog rather than waiting on an inert button underneath it.
    const foreground = page.locator('[role="alertdialog"]:not([inert] *)').last();
    for (let attempt = 0; attempt < 5; attempt++) {
      const id = await foreground.getAttribute('aria-labelledby');
      try { await foreground.locator('[data-confirm], [data-feedback-close]').click({ timeout: 2000 }); return; }
      catch (cause) {
        // A click already in progress keeps its old element when another dialog
        // appears. Retry only if the foreground actually changed in the meantime.
        const nextId = await foreground.getAttribute('aria-labelledby', { timeout: 1000 }).catch(() => null);
        if (!(cause instanceof Error) || cause.name !== 'TimeoutError' || nextId === id) throw cause;
      }
    }
    throw new Error('Dialogs kept replacing one another while trying to acknowledge them.');
  }, { noWaitAfter: true });
}

export async function acknowledgeFeedback(page: Page, contains: string[] = []) {
  const dialog = page.getByRole('alertdialog').filter({ has: page.locator('[data-feedback-close]') });
  await expect(dialog).toBeVisible();
  for (const text of contains) await expect(dialog).toContainText(text);
  const labelledBy = await dialog.getAttribute('aria-labelledby');
  await dialog.getByRole('button', { name: '知道了', exact: true }).click();
  await expect(page.locator(`[role="alertdialog"][aria-labelledby="${labelledBy}"]`)).toHaveCount(0);
}
