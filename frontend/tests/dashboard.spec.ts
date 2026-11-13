import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#connection')).toContainText('Онлайн');
  await expect(page.locator('.metric-card')).toHaveCount(5);
  await expect(page.locator('#canvas-frame')).toHaveAttribute('data-ready', 'true');
});

test('real data, chart rendering and no horizontal overflow', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await expect(page.locator('.metric-card').first().locator('.metric-reading strong')).not.toHaveText('—');
  await expect(page.locator('.uplot canvas').first()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  const values = await page.evaluate(async () => (await fetch('/api/snapshot', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: ['memory.usage'] }),
  })).json());
  expect(values.values['memory.usage']).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});

test('create, persist, configure and remove a widget', async ({ page }) => {
  await page.locator('#canvas-rows').fill('24');
  await page.locator('#add').click();
  await page.locator('.template[data-kind="number"]').click();
  await page.locator('#widget-title').fill('Память для теста');
  await page.locator('#metric-group').selectOption({ label: 'Память' });
  await page.locator('#metric-select').selectOption('memory.used');
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(page.locator('.metric-card')).toHaveCount(6);
  await page.reload();
  await expect(page.locator('#connection')).toContainText('Онлайн');
  const card = page.locator('.metric-card').filter({ has: page.getByRole('heading', { name: 'Память для теста' }) });
  await expect(card).toBeVisible();
  await revealToolbar(page);
  await page.locator('#edit').click();
  await card.getByRole('button', { name: 'Настроить Память для теста' }).click();
  await page.locator('#delete-widget').click();
  await expect(page.locator('.metric-card')).toHaveCount(5);
});

test('opened page survives network failure and recovers without reload', async ({ page }) => {
  const first = page.locator('.metric-card').first();
  const value = await first.locator('.metric-reading strong').textContent();
  const location = page.url();
  await page.route('**/api/**', route => route.abort('failed'));
  await expect(page.locator('#connection')).toContainText('Нет связи');
  await expect(page.locator('#banner-title')).toHaveText('Нет связи с сервером');
  await expect(first.locator('.metric-note')).toHaveText('Данные устарели');
  expect(await first.locator('.metric-reading strong').textContent()).toBe(value);
  expect(page.url()).toBe(location);
  await page.unroute('**/api/**');
  await page.locator('#retry').click();
  await expect(page.locator('#connection')).toContainText('Онлайн');
  await expect(page.locator('#banner')).toBeHidden();
  await expect(page.locator('.metric-card')).toHaveCount(5);
});

test('source failure differs from loss of connection', async ({ page }) => {
  await page.route('**/api/snapshot', route => route.fulfill({ status: 503,
    contentType: 'application/json', body: JSON.stringify({ status: 'metrics_unavailable' }) }));
  await expect(page.locator('#connection')).toContainText('Метрики недоступны');
  await expect(page.locator('#banner-title')).toContainText('Сайт работает');
  await page.unroute('**/api/snapshot');
  await page.locator('#retry').click();
  await expect(page.locator('#connection')).toContainText('Онлайн');
});

test('viewport changes preserve the fixed cell layout', async ({ page }) => {
  const original = await page.evaluate(() => JSON.parse(localStorage.getItem('pc-monitor-board-v1')!).layout);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(async () => page.locator('.metric-card').count()).toBe(5);
  await page.setViewportSize({ width: 1440, height: 1000 });
  const restored = await page.evaluate(() => JSON.parse(localStorage.getItem('pc-monitor-board-v1')!).layout);
  expect(restored).toEqual(original);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
});

test('editing allows moving and resizing cards', async ({ page }, testInfo) => {
  await page.locator('#canvas-rows').fill('24');
  await revealToolbar(page);
  await page.locator('#edit').click();
  const card = page.locator('.grid-stack-item').first();
  const handle = card.locator('.drag-handle');
  const before = await card.getAttribute('gs-y');
  const box = (await handle.boundingBox())!;
  const scale = await page.locator('#canvas-frame').evaluate(el => el.clientWidth / (Number(document.querySelector<HTMLInputElement>('#canvas-columns')!.value) * 80));
  if (testInfo.project.name !== 'desktop') {
    const cdp = await page.context().newCDPSession(page);
    const x = box.x + Math.min(20, box.width / 2), y = box.y + box.height / 2;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    await page.waitForTimeout(350);
    for (let i = 1; i <= 20; i++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y + 4 * 80 * scale * i / 20 }] });
      await page.waitForTimeout(20);
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect.poll(() => card.getAttribute('gs-y')).not.toBe(before);
    return;
  }
  await page.mouse.move(box.x + 20, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 20, box.y + box.height / 2 + 4 * 80 * scale, { steps: 18 });
  await page.mouse.up();
  await expect.poll(() => card.getAttribute('gs-y')).not.toBe(before);
  const height = await card.getAttribute('gs-h');
  const corner = (await card.locator('.ui-resizable-se').boundingBox())!;
  await page.mouse.move(corner.x + corner.width / 2, corner.y + corner.height / 2);
  await page.mouse.down();
  await page.mouse.move(corner.x - 80 * scale, corner.y + 2 * 80 * scale, { steps: 16 });
  await page.mouse.up();
  await expect.poll(() => card.getAttribute('gs-h')).not.toBe(height);
  await revealToolbar(page);
  await page.locator('#edit').click();
  await expect(card.locator('.ui-resizable-se')).toBeHidden();
});

test('an unanswered request is bounded and does not freeze the editor', async ({ page }) => {
  const held: Array<import('@playwright/test').Route> = [];
  await page.route('**/api/snapshot', async route => { held.push(route); });
  await expect(page.locator('#connection')).toContainText('Нет связи', { timeout: 25000 });
  await page.locator('#add').click();
  await expect(page.locator('#library')).toBeVisible();
  await page.getByRole('button', { name: 'Закрыть каталог' }).click();
  await page.unroute('**/api/snapshot');
  await Promise.all(held.map(route => route.abort().catch(() => {})));
  await page.locator('#retry').click();
  await expect(page.locator('#connection')).toContainText('Онлайн');
});

async function revealToolbar(page: import('@playwright/test').Page) {
  if (await page.evaluate(() => Boolean(document.fullscreenElement))) {
    if (await page.evaluate(() => matchMedia('(hover:hover)').matches)) await page.mouse.move(5, 2);
    else if (!await page.locator('.toolbar-dock').evaluate(el => el.classList.contains('toolbar-open'))) await page.locator('.toolbar-reveal').tap();
    await expect.poll(() => page.locator('.toolbar').evaluate(el => el.getBoundingClientRect().top)).toBeGreaterThanOrEqual(0);
  }
}

async function assertFits(page: import('@playwright/test').Page) {
  await expect.poll(() => page.evaluate(() => {
    const root = document.documentElement;
    const cards = [...document.querySelectorAll('.metric-card')];
    return root.scrollHeight <= innerHeight + 1 && root.scrollWidth <= innerWidth + 1
      && cards.every(card => {
        const rect = card.getBoundingClientRect();
        const reading = card.querySelector('.metric-reading')!.getBoundingClientRect();
        return rect.top >= 0 && rect.left >= 0 && rect.right <= innerWidth + 1
          && rect.bottom <= innerHeight + 1 && reading.bottom <= rect.bottom + 1;
      });
  })).toBeTruthy();
}

test('Vitrina light and dark themes persist without decorative page chrome', async ({ page }) => {
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(await page.locator('.brand, footer, .page-heading').count()).toBe(0);
  const before = await page.locator('.metric-card').count();
  await revealToolbar(page);
  await page.locator('#theme').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect.poll(() => page.locator('.metric-card').first().evaluate(el => getComputedStyle(el).backgroundImage)).toBe('none');
  await page.reload();
  await expect(page.locator('#connection')).toContainText('Онлайн');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(page.locator('.metric-card')).toHaveCount(before);
  await revealToolbar(page);
  await page.locator('#theme').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
});

test('fullscreen fits the complete field through theme changes and connection failure', async ({ page }) => {
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('pc-monitor-board-v1')!).layout);
  await revealToolbar(page);
  await page.locator('#fullscreen').click();
  await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBeTruthy();
  await assertFits(page);
  await page.mouse.wheel(0, 500);
  expect(await page.evaluate(() => scrollY)).toBe(0);
  await revealToolbar(page);
  await page.locator('#theme').click();
  await assertFits(page);
  await page.route('**/api/**', route => route.abort('failed'));
  await expect(page.locator('#connection')).toContainText('Нет связи');
  await assertFits(page);
  await page.unroute('**/api/**');
  await page.locator('#retry').click();
  await expect(page.locator('#connection')).toContainText('Онлайн');
  await assertFits(page);
  await revealToolbar(page);
  await page.locator('#fullscreen').click();
  await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBeFalsy();
  const after = await page.evaluate(() => JSON.parse(localStorage.getItem('pc-monitor-board-v1')!).layout);
  expect(after).toEqual(saved);
});

test('fullscreen fits all 24 widgets with no clipped readings', async ({ page }) => {
  await page.evaluate(() => {
    const board = JSON.parse(localStorage.getItem('pc-monitor-board-v1')!);
    board.widgets = Array.from({ length: 24 }, (_, i) => ({ ...board.widgets[0], id: `many-${i}`,
      title: `CPU ${i + 1}`, type: i % 2 ? 'number' : 'chart', metrics: ['cpu.usage'] }));
    board.columns = 12; board.rows = 8;
    board.layout = Object.fromEntries(board.widgets.map((w: { id: string }, i: number) => [w.id,
      { x: i % 6 * 2, y: Math.floor(i / 6) * 2, w: 2, h: 2 }]));
    localStorage.setItem('pc-monitor-board-v1', JSON.stringify(board));
  });
  await page.reload();
  await expect(page.locator('#connection')).toContainText('Онлайн');
  await expect(page.locator('.metric-card')).toHaveCount(24);
  await revealToolbar(page);
  await page.locator('#fullscreen').click();
  await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBeTruthy();
  await assertFits(page);
});

test('create number, gauge and a two-series network chart from available sources', async ({ page }) => {
  await page.locator('#canvas-rows').fill('24');
  const catalog = await page.evaluate(async () => (await (await fetch('/api/catalog')).json()).metrics);
  const receive = catalog.find((m: { id: string }) => m.id.startsWith('network.receive'));
  const transmit = catalog.find((m: { id: string; device: string }) => m.id.startsWith('network.transmit') && m.device === receive?.device);
  const cases = [
    { type: 'number', title: 'RAM в гигабайтах', group: 'Память', metric: 'memory.used' },
    { type: 'gauge', title: 'CPU: порог 70%', group: 'Процессор', metric: 'cpu.usage' },
    { type: 'chart', title: 'Сеть: приём и передача', group: 'Сеть', metric: receive?.id },
  ];
  expect(receive).toBeTruthy();
  expect(transmit).toBeTruthy();
  for (const item of cases) {
    await page.locator('#add').click();
    await page.locator(`.template[data-kind="${item.type}"]`).click();
    await page.locator('#widget-title').fill(item.title);
    await page.locator('#metric-group').selectOption({ label: item.group });
    await page.locator('#metric-select').selectOption(item.metric);
    if (item.type === 'chart') await page.locator('#secondary-select').selectOption(transmit.id);
    if (item.type === 'gauge') await page.locator('#widget-threshold').fill('70');
    await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
    const card = page.locator('.metric-card').filter({ has: page.getByRole('heading', { name: item.title, exact: true }) });
    await card.scrollIntoViewIfNeeded();
    await expect(card.locator('.metric-reading strong')).not.toHaveText('—');
  }
  await expect(page.locator('.metric-card')).toHaveCount(8);
  await page.reload();
  await expect(page.locator('#connection')).toContainText('Онлайн');
  await expect(page.locator('.metric-card')).toHaveCount(8);
  const config = await page.evaluate(() => JSON.parse(localStorage.getItem('pc-monitor-board-v1')!));
  expect(config.widgets.find((w: { title: string }) => w.title === cases[2].title).metrics).toHaveLength(2);
  expect(config.widgets.find((w: { title: string }) => w.title === cases[1].title).threshold).toBe(70);
  await revealToolbar(page);
  await page.locator('#fullscreen').click();
  await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBeTruthy();
  await assertFits(page);
});

test('canvas dimensions apply automatically, persist and reject clipping existing cards', async ({ page }) => {
  await expect(page.getByRole('button', { name: 'Применить размер поля' })).toHaveCount(0);
  await page.locator('#canvas-columns').fill('16');
  await page.locator('#canvas-rows').fill('20');
  await page.reload();
  await expect(page.locator('#connection')).toContainText('Онлайн');
  await expect(page.locator('#canvas-columns')).toHaveValue('16');
  await expect(page.locator('#canvas-rows')).toHaveValue('20');
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('pc-monitor-board-v1')!));
  await page.locator('#canvas-columns').fill('2');
  await page.locator('#canvas-rows').fill('2');
  await page.locator('#canvas-rows').blur();
  await expect(page.locator('#toast')).toContainText('выходят за границы');
  const after = await page.evaluate(() => JSON.parse(localStorage.getItem('pc-monitor-board-v1')!));
  expect(after).toEqual(saved);
  await expect(page.locator('.metric-card')).toHaveCount(5);
});

test('fullscreen editing follows the same cells at the scaled pointer position', async ({ page }, testInfo) => {
  await page.evaluate(() => {
    const b = JSON.parse(localStorage.getItem('pc-monitor-board-v1')!);
    b.widgets = [b.widgets[0]]; b.columns = 12; b.rows = 10;
    b.layout = { [b.widgets[0].id]: { x: 0, y: 0, w: 4, h: 3 } };
    localStorage.setItem('pc-monitor-board-v1', JSON.stringify(b));
  });
  await page.reload();
  await expect(page.locator('#connection')).toContainText('Онлайн');
  await revealToolbar(page);
  await page.locator('#fullscreen').click();
  await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBeTruthy();
  await revealToolbar(page);
  await page.locator('#edit').click();
  const scale = await page.locator('#canvas-frame').evaluate(el => el.clientWidth / (Number(document.querySelector<HTMLInputElement>('#canvas-columns')!.value) * 80));
  const card = page.locator('.grid-stack-item').first();
  await page.mouse.click(1, 400);
  await expect.poll(() => page.locator('.toolbar').evaluate(el => el.getBoundingClientRect().bottom)).toBeLessThanOrEqual(0);
  const box = (await card.locator('.drag-handle').boundingBox())!;
  const x = box.x + Math.min(15, box.width / 2), y = box.y + box.height / 2;
  if (testInfo.project.name === 'desktop') {
    await page.mouse.move(x, y); await page.mouse.down();
    await page.mouse.move(x, y + 3 * 80 * scale, { steps: 20 });
    await page.mouse.up();
  } else {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    await page.waitForTimeout(350);
    for (let i = 1; i <= 20; i++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y + 3 * 80 * scale * i / 20 }] });
      await page.waitForTimeout(20);
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  }
  await expect(card).toHaveAttribute('gs-y', '3');
  await assertFits(page);
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('pc-monitor-board-v1')!).layout);
  await revealToolbar(page);
  await page.locator('#fullscreen').click();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('pc-monitor-board-v1')!).layout)).toEqual(saved);
});

test('legacy board migration preserves cards and keeps a recoverable browser copy', async ({ page }) => {
  await page.evaluate(() => {
    const b = JSON.parse(localStorage.getItem('pc-monitor-board-v1')!);
    const layout = Object.fromEntries(b.widgets.map((w: { id: string }, i: number) => [w.id,
      { x: i % 3 * 4, y: Math.floor(i / 3) * 4, w: 4, h: 4 }]));
    localStorage.setItem('pc-monitor-board-v1', JSON.stringify({ version: 1, widgets: b.widgets, layouts: { wide: layout } }));
  });
  await page.reload();
  await expect(page.locator('#connection')).toContainText('Онлайн');
  await expect(page.locator('.metric-card')).toHaveCount(5);
  const data = await page.evaluate(() => ({
    current: JSON.parse(localStorage.getItem('pc-monitor-board-v1')!),
    backup: JSON.parse(localStorage.getItem('pc-monitor-board-before-fixed-grid')!),
  }));
  expect(data.current.version).toBe(2);
  expect(data.current.widgets).toEqual(data.backup.widgets);
  expect(data.current.layout).toEqual(data.backup.layouts.wide);
});

test('chart and gauge readings share the title row and plots get most of the card', async ({ page }) => {
  const layout = await page.locator('.metric-card').evaluateAll(cards => cards.map(card => {
    const heading = card.querySelector('.card-heading')!;
    const value = card.querySelector('.metric-reading')!;
    const title = card.querySelector('h3')!.getBoundingClientRect();
    const reading = value.getBoundingClientRect();
    return { number: card.classList.contains('number'), chart: card.classList.contains('chart'),
      inline: heading.contains(value), valueAfterTitle: reading.left >= title.right - 1,
      graphShare: card.querySelector('.card-visual')!.getBoundingClientRect().height / card.getBoundingClientRect().height };
  }));
  for (const card of layout) {
    expect(card.inline).toBe(!card.number);
    if (!card.number) expect(card.valueAfterTitle).toBeTruthy();
    if (card.chart) expect(card.graphShare).toBeGreaterThan(.5);
  }
});
