import { expect, test } from '@playwright/test';

test('the self-test passes', async ({ page }) => {
  await page.goto('/?self-test');
  await expect(page.locator('#self-test-result')).toHaveText(/^passed: \d+ of \d+$/, { timeout: 45_000 });
});
