import { chromium, Page } from 'playwright';

async function cleanupYahooMail() {
  console.log('Connecting to Chrome...');

  const browser = await chromium.connectOverCDP('http://localhost:9222');
  const contexts = browser.contexts();

  if (contexts.length === 0) {
    console.log('No browser contexts found');
    return;
  }

  const context = contexts[0];
  const pages = context.pages();

  let yahooPage = pages.find(p => p.url().includes('mail.yahoo.com'));

  if (!yahooPage) {
    console.log('Yahoo Mail not found, opening it...');
    yahooPage = await context.newPage();
    await yahooPage.goto('https://mail.yahoo.com');
    await yahooPage.waitForLoadState('networkidle');
  }

  console.log('Found Yahoo Mail page:', yahooPage.url());

  // Navigate fresh to yahoo mail
  console.log('Navigating fresh to Yahoo Mail...');
  await yahooPage.goto('https://mail.yahoo.com', { waitUntil: 'networkidle', timeout: 30000 });
  await yahooPage.waitForTimeout(3000);

  const title = await yahooPage.title();
  console.log('Page title:', title);

  // If we hit a block page, try inbox directly
  if (title.includes('emxdgt') || title.includes('proxy')) {
    console.log('Blocked by tracking - trying inbox directly');
    await yahooPage.goto('https://mail.yahoo.com/d/folders/1', { waitUntil: 'networkidle', timeout: 30000 });
    await yahooPage.waitForTimeout(3000);
  }

  // Debug: Get updated page info
  const finalTitle = await yahooPage.title();
  const finalUrl = yahooPage.url();
  console.log('Final title:', finalTitle);
  console.log('Final URL:', finalUrl);

  // Try to find elements
  const allElements = await yahooPage.evaluate(() => {
    const els = document.querySelectorAll('button, [role="button"], [role="checkbox"], a');
    const items: string[] = [];
    els.forEach(el => {
      const text = (el as HTMLElement).innerText?.trim().substring(0, 40) || '';
      const ariaLabel = el.getAttribute('aria-label') || '';
      if (text || ariaLabel) {
        items.push(`"${text}" [${ariaLabel}]`);
      }
    });
    return items.slice(0, 40);
  });
  console.log(`Found ${allElements.length} clickable elements:`);
  allElements.forEach(e => console.log('  ', e));

  // Helper to find and click elements with multiple selector strategies
  async function tryClick(page: Page, selectors: string[], description: string): Promise<boolean> {
    for (const selector of selectors) {
      try {
        const el = page.locator(selector).first();
        if (await el.isVisible({ timeout: 1000 })) {
          await el.click();
          console.log(`✓ Clicked ${description} using: ${selector}`);
          return true;
        }
      } catch {
        // Try next selector
      }
    }
    console.log(`✗ Could not find ${description}`);
    return false;
  }

  // Helper to delete all in current view
  async function selectAllAndDelete(page: Page): Promise<boolean> {
    // Try multiple selector strategies for "select all" checkbox
    const selectAllSelectors = [
      'input[type="checkbox"][aria-label*="Select all"]',
      '[data-test-id="checkbox-all"]',
      '[aria-label="Select all messages"]',
      '.mail-checkbox-all',
      'button[aria-label*="Select"]',
      '[role="checkbox"][aria-label*="all"]',
    ];

    const clicked = await tryClick(page, selectAllSelectors, 'select all checkbox');
    if (!clicked) return false;

    await page.waitForTimeout(500);

    // Try multiple selectors for delete button
    const deleteSelectors = [
      '[data-test-id="toolbar-delete"]',
      'button[aria-label="Delete"]',
      '[title="Delete"]',
      'button:has-text("Delete")',
      '[aria-label*="Delete"]',
    ];

    const deleted = await tryClick(page, deleteSelectors, 'delete button');
    if (deleted) {
      await page.waitForTimeout(1500);
      return true;
    }
    return false;
  }

  // Tab selectors - Yahoo uses views/tabs
  const tabs = [
    { name: 'Offers', selectors: ['[data-test-id="views-tab-offers"]', 'button:has-text("Offers")', 'a:has-text("Offers")'] },
    { name: 'Social', selectors: ['[data-test-id="views-tab-social"]', 'button:has-text("Social")', 'a:has-text("Social")'] },
    { name: 'Newsletters', selectors: ['[data-test-id="views-tab-newsletters"]', 'button:has-text("Newsletters")', 'a:has-text("Newsletters")'] },
  ];

  for (const tab of tabs) {
    console.log(`\n--- Cleaning ${tab.name} tab ---`);
    const tabClicked = await tryClick(yahooPage, tab.selectors, `${tab.name} tab`);

    if (tabClicked) {
      await yahooPage.waitForTimeout(2000);

      let rounds = 0;
      while (rounds < 10) {
        const hasMore = await selectAllAndDelete(yahooPage);
        if (!hasMore) break;
        rounds++;
      }
      console.log(`${tab.name}: ${rounds} deletion rounds completed`);
    }
  }

  console.log('\n✅ Cleanup complete!');

  // Leave browser open
  await browser.close();
}

cleanupYahooMail().catch(console.error);
