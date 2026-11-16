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
  await expect(page.locator('#canvas-frame')).toHaveAttribute('data-ready', 'true');
  const resizeScale = await page.locator('#canvas-frame').evaluate(el => el.clientWidth / (Number(document.querySelector<HTMLInputElement>('#canvas-columns')!.value) * 80));
  const height = await card.getAttribute('gs-h');
  const corner = (await card.locator('.ui-resizable-se').boundingBox())!;
  await page.mouse.move(corner.x + corner.width / 2, corner.y + corner.height / 2);
  await page.mouse.down();
  await page.mouse.move(corner.x - 80 * resizeScale, corner.y + 2 * 80 * resizeScale, { steps: 16 });
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
        const readings = [...card.querySelectorAll('.metric-reading')].map(el => el.getBoundingClientRect());
        return rect.top >= 0 && rect.left >= 0 && rect.right <= innerWidth + 1
          && rect.bottom <= innerHeight + 1 && readings.every(reading => reading.bottom <= rect.bottom + 1 && reading.left >= rect.left - 1 && reading.right <= rect.right + 1);
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
    if (item.type === 'gauge') {
      await page.getByRole('switch', { name: 'Включить порог' }).check();
      await page.locator('#widget-threshold').fill('70');
    }
    await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
    const card = page.locator('.metric-card').filter({ has: page.getByRole('heading', { name: item.title, exact: true }) });
    await card.scrollIntoViewIfNeeded();
    await expect(card.locator('..')).toHaveAttribute('gs-w', '2');
    await expect(card.locator('..')).toHaveAttribute('gs-h', '2');
    const readings = card.locator('.metric-reading strong');
    await expect(readings).toHaveCount(item.type === 'chart' ? 2 : 1);
    for (const reading of await readings.all()) await expect(reading).not.toHaveText('—');
  }
  await expect(page.locator('.metric-card')).toHaveCount(8);
  await page.reload();
  await expect(page.locator('#connection')).toContainText('Онлайн');
  await expect(page.locator('.metric-card')).toHaveCount(8);
  const config = await page.evaluate(() => JSON.parse(localStorage.getItem('pc-monitor-board-v1')!));
  expect(config.widgets.find((w: { title: string }) => w.title === cases[2].title).metrics).toHaveLength(2);
  const network = page.locator('.metric-card').filter({ has: page.getByRole('heading', { name: cases[2].title, exact: true }) });
  await expect(network.locator('.metric-reading')).toHaveCount(2);
  await expect(network.locator('.series-name')).toHaveText([receive.title, transmit.title]);
  await page.route('**/api/snapshot', async route => {
    const response = await route.fetch();
    const snapshot = await response.json();
    snapshot.values[receive.id] = 1024;
    snapshot.values[transmit.id] = 2048;
    await route.fulfill({ json: snapshot });
  });
  await page.locator('#retry').dispatchEvent('click');
  await expect(network.locator('.metric-reading strong')).toHaveText(['1', '2']);
  await expect(network.locator('.metric-reading > span')).toHaveText(['КиБ/с', 'КиБ/с']);
  expect(config.widgets.find((w: { title: string }) => w.title === cases[1].title).threshold).toBe(70);
  await revealToolbar(page);
  await page.locator('#fullscreen').click();
  await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBeTruthy();
  await assertFits(page);
});

test('field fits actual card bounds and keeps layout through editing and reload', async ({ page }) => {
  await expect(page.locator('#canvas-size')).toBeHidden();
  const original = await page.evaluate(() => JSON.parse(localStorage.getItem('pc-monitor-board-v1')!));
  const bounds = (board: typeof original) => ({
    columns: Math.max(2, ...Object.values(board.layout).map((p: any) => p.x + p.w)),
    rows: Math.max(2, ...Object.values(board.layout).map((p: any) => p.y + p.h)),
  });
  expect({ columns: original.columns, rows: original.rows }).toEqual(bounds(original));
  await page.locator('#edit').click();
  await expect(page.locator('#canvas-size')).toBeVisible();
  const editing = await page.evaluate(() => JSON.parse(localStorage.getItem('pc-monitor-board-v1')!));
  expect(editing.columns).toBe(Math.min(48, original.columns + 2));
  expect(editing.rows).toBe(Math.min(96, original.rows + 2));
  expect(editing.layout).toEqual(original.layout);
  await page.locator('#edit').click();
  await page.reload();
  await expect(page.locator('#connection')).toContainText('Онлайн');
  const restored = await page.evaluate(() => JSON.parse(localStorage.getItem('pc-monitor-board-v1')!));
  expect(restored).toEqual(original);
  await expect(page.locator('#canvas-size')).toBeHidden();
  await expect(page.locator('#edit + #add')).toHaveCount(1);
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
    await page.mouse.move(x, y + 2 * 80 * scale, { steps: 20 });
    await page.mouse.up();
  } else {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    await page.waitForTimeout(350);
    for (let i = 1; i <= 20; i++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y + 2 * 80 * scale * i / 20 }] });
      await page.waitForTimeout(20);
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  }
  await expect(card).toHaveAttribute('gs-y', '2');
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
    const value = card.querySelector('.card-readings') || card.querySelector('.metric-reading')!;
    const title = card.querySelector('h3')!.getBoundingClientRect();
    const reading = value.getBoundingClientRect();
    const rows = [...card.querySelectorAll('.card-readings.dual .metric-reading')];
    const columnsAligned = rows.length < 2 || ['.series-key', '.series-name', 'strong', 'span'].every(selector => {
      const left = rows.map(row => row.querySelector(selector)!.getBoundingClientRect().left);
      return Math.max(...left) - Math.min(...left) < 1;
    });
    return { number: card.classList.contains('number'), chart: card.classList.contains('chart'), columnsAligned,
      inline: heading.contains(value), valueAfterTitle: reading.left >= title.right - 1,
      graphShare: card.querySelector('.card-visual')!.getBoundingClientRect().height / card.getBoundingClientRect().height };
  }));
  for (const card of layout) {
    expect(card.inline).toBe(!card.number);
    expect(card.columnsAligned).toBeTruthy();
    if (!card.number) expect(card.valueAfterTitle).toBeTruthy();
    if (card.chart) expect(card.graphShare).toBeGreaterThan(.5);
  }
});


test('chart period persists and is sent in history requests after reload', async ({ page }) => {
  await page.locator('#edit').click();
  await page.locator('#period').selectOption('21600');
  const request = page.waitForRequest(req => req.url().endsWith('/api/history') && req.postDataJSON().seconds === 21600);
  await page.reload();
  await request;
  await page.locator('#edit').click();
  await expect(page.locator('#period')).toHaveValue('21600');
});

test('threshold accepts zero, uses metric units and survives reload above 100', async ({ page }) => {
  await page.locator('#edit').click();
  const card = page.locator('.metric-card').filter({ has: page.getByRole('heading', { name: 'Оперативная память', exact: true }) });
  await card.locator('.card-settings').click();
  await page.getByRole('switch', { name: 'Включить порог' }).check();
  await page.locator('#widget-threshold').fill('0');
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(card).toHaveClass(/warning/);
  await expect(card.locator('.metric-note')).toHaveText('Порог ≥ 0 %');
  await card.locator('.card-settings').click();
  await page.locator('#metric-select').selectOption('memory.used');
  await page.locator('#widget-type').selectOption('number');
  await expect(page.locator('#threshold-caption')).toHaveText('Порог предупреждения, Б');
  await page.locator('#widget-threshold').fill('1048576');
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await page.reload();
  await expect(page.locator('#connection')).toContainText('Онлайн');
  await expect(card).toHaveClass(/warning/);
  await expect(card.locator('.metric-note')).toHaveText('Порог ≥ 1 МиБ');
  await page.locator('#edit').click();
  await card.locator('.card-settings').click();
  await expect(page.locator('#widget-threshold')).toHaveValue('1048576');
});

test('equal height cards have aligned footer separators and transparent fullscreen field', async ({ page }) => {
  const footers = await page.locator('.metric-card').evaluateAll(cards => cards.map(card => {
    const rect = card.getBoundingClientRect();
    const footerElement = card.querySelector('.card-bottom')!;
    const footer = footerElement.getBoundingClientRect();
    const note = card.querySelector('.metric-note')!.getBoundingClientRect();
    return { height: rect.height, inset: rect.bottom - footer.top,
      above: note.top - footer.top - parseFloat(getComputedStyle(footerElement).borderTopWidth),
      below: rect.bottom - note.bottom - parseFloat(getComputedStyle(card).borderBottomWidth) };
  }));
  for (const footer of footers) expect(Math.abs(footer.above - footer.below)).toBeLessThan(1);
  for (const first of footers) for (const second of footers) {
    if (Math.abs(first.height - second.height) < 1) expect(Math.abs(first.inset - second.inset)).toBeLessThan(1);
  }
  await page.locator('#fullscreen').click();
  await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBeTruthy();
  const field = await page.locator('#canvas-frame').evaluate(el => ({ background: getComputedStyle(el).backgroundColor, outline: getComputedStyle(el).outlineStyle }));
  expect(field).toEqual({ background: 'rgba(0, 0, 0, 0)', outline: 'none' });
});

test('network axis labels stay inside canvas across traffic scales', async ({ page }) => {
  await page.addInitScript(() => {
    (window as any).networkLabels = [];
    const original = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function(text, x, y, maxWidth) {
      if (text.includes('Б/с')) {
        const width = this.measureText(text).width;
        const left = x - (this.textAlign === 'right' || this.textAlign === 'end' ? width : this.textAlign === 'center' ? width / 2 : 0);
        const matrix = this.getTransform();
        (window as any).networkLabels.push({ text, left: left * matrix.a + matrix.e,
          right: (left + width) * matrix.a + matrix.e, canvasWidth: this.canvas.width });
      }
      return maxWidth === undefined ? original.call(this, text, x, y) : original.call(this, text, x, y, maxWidth);
    };
  });
  await page.route('**/api/history', async route => {
    const { ids } = route.request().postDataJSON();
    const now = Math.floor(Date.now() / 1000);
    const series = Object.fromEntries(ids.map((id: string) => [id,
      Array.from({ length: 60 }, (_, i) => [now - 300 + i * 5, id.startsWith('network.') ? (i % 2 ? 999.9 : 99.9) * 1024 ** 2 : 30])
    ]));
    await route.fulfill({ json: { series } });
  });
  await page.reload();
  await expect.poll(() => page.evaluate(() => (window as any).networkLabels.length)).toBeGreaterThan(0);
  const labels = await page.evaluate(() => (window as any).networkLabels);
  for (const label of labels) {
    expect(label.left, label.text).toBeGreaterThanOrEqual(-1);
    expect(label.right, label.text).toBeLessThanOrEqual(label.canvasWidth + 1);
  }
});


test('threshold starts off, can be enabled and stays disabled after reload with its value kept', async ({ page }) => {
  const card = page.locator('.metric-card').filter({ has: page.getByRole('heading', { name: 'Оперативная память', exact: true }) });
  await expect(card).not.toHaveClass(/warning/);
  await expect(card.locator('.metric-note')).toHaveText('Порог выключен');
  await page.locator('#edit').click();
  await card.locator('.card-settings').click();
  const toggle = page.getByRole('switch', { name: 'Включить порог' });
  await expect(toggle).not.toBeChecked();
  await expect(page.locator('#widget-threshold')).toBeDisabled();
  await toggle.check();
  await page.locator('#widget-threshold').fill('0');
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(card).toHaveClass(/warning/);
  await card.locator('.card-settings').click();
  await expect(toggle).toBeChecked();
  await toggle.uncheck();
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(card).not.toHaveClass(/warning/);
  await page.reload();
  await expect(page.locator('#connection')).toContainText('Онлайн');
  await expect(card.locator('.metric-note')).toHaveText('Порог выключен');
  await expect(card).not.toHaveClass(/warning/);
  await page.locator('#edit').click();
  await card.locator('.card-settings').click();
  await expect(toggle).not.toBeChecked();
  await expect(page.locator('#widget-threshold')).toHaveValue('0');
  await toggle.check();
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(card).toHaveClass(/warning/);
});


test('readings keep their width, right alignment and heading position as values change', async ({ page }) => {
  const metrics = await page.evaluate(() => {
    const board = JSON.parse(localStorage.getItem('pc-monitor-board-v1')!);
    return board.widgets.find((w: any) => w.type === 'chart' && w.metrics.length === 2).metrics;
  });
  let speed = 5.4;
  await page.route('**/api/snapshot', async route => {
    const response = await route.fetch();
    const snapshot = await response.json();
    snapshot.values[metrics[0]] = speed * 1024;
    snapshot.values[metrics[1]] = 9.2 * 1024;
    await route.fulfill({ json: snapshot });
  });
  const group = page.locator('.card-readings.dual').first();
  const value = group.locator('strong').first();
  const geometry = () => group.evaluate(el => {
    const rows = [...el.querySelectorAll('.metric-reading')];
    const card = el.closest('.metric-card')!;
    const title = card.querySelector('h3')!.getBoundingClientRect();
    const reference = document.querySelector('.metric-card h3')!.getBoundingClientRect();
    const referenceCard = document.querySelector('.metric-card')!.getBoundingClientRect();
    return { left: el.getBoundingClientRect().left, width: el.getBoundingClientRect().width,
      titleOffset: title.top - card.getBoundingClientRect().top,
      referenceOffset: reference.top - referenceCard.top,
      rightAligned: rows.every(row => getComputedStyle(row.querySelector('strong')!).textAlign === 'right'),
      markerOffsets: rows.map(row => {
        const marker = row.querySelector('.series-key b')!.getBoundingClientRect();
        const label = row.querySelector('.series-name')!;
        const rect = label.getBoundingClientRect();
        const padding = parseFloat(getComputedStyle(label).paddingBottom);
        return (marker.top + marker.bottom) / 2 - (rect.top + rect.bottom - padding) / 2;
      }),
    };
  });
  await page.locator('#retry').dispatchEvent('click');
  await expect(value).toHaveText('5,4');
  const initial = await geometry();
  expect(initial.rightAligned).toBeTruthy();
  expect(Math.abs(initial.titleOffset - initial.referenceOffset)).toBeLessThan(1);
  for (const offset of initial.markerOffsets) expect(Math.abs(offset)).toBeLessThan(1);
  speed = 125.4;
  await page.locator('#retry').dispatchEvent('click');
  await expect(value).toHaveText('125,4');
  const ordinary = await geometry();
  expect(Math.abs(ordinary.left - initial.left)).toBeLessThan(1);
  expect(Math.abs(ordinary.width - initial.width)).toBeLessThan(1);
  speed = 1023.9;
  await page.locator('#retry').dispatchEvent('click');
  await expect(value).toHaveText(/1\s023,9/);
  const grown = await geometry();
  expect(grown.width).toBeGreaterThan(initial.width);
  speed = 5.4;
  await page.locator('#retry').dispatchEvent('click');
  await expect(value).toHaveText('5,4');
  const restored = await geometry();
  expect(Math.abs(restored.width - grown.width)).toBeLessThan(1);
  expect(Math.abs(restored.left - grown.left)).toBeLessThan(1);
});
