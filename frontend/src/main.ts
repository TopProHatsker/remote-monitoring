import { GridStack, type GridStackWidget } from 'gridstack';
import uPlot from 'uplot';
import 'gridstack/dist/gridstack.min.css';
import 'uplot/dist/uPlot.min.css';
import './style.css';

type Metric = { id: string; title: string; group: string; unit: string; device: string; maximum: number | null };
type Kind = 'number' | 'gauge' | 'chart';
type Position = { x: number; y: number; w: number; h: number };
type Widget = { id: string; type: Kind; title: string; metrics: string[]; color: string; threshold: number };
type Board = { version: 2; widgets: Widget[]; columns: number; rows: number; layout: Record<string, Position> };
type LegacyBoard = { version: 1; widgets: Widget[]; layouts: Record<string, Record<string, Position>> };
type Snapshot = { sample_time: number; hostname: string; values: Record<string, number | null> };
type Catalog = { hostname: string; metrics: Metric[] };
type Connection = 'connecting' | 'live' | 'checking' | 'offline' | 'source';
type Runtime = { element: HTMLElement; chart?: uPlot; chartScale?: number; observer?: ResizeObserver };

const $ = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const icons = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  edit: '<path d="m16 3 5 5-12 12H4v-5zM14 5l5 5"/>',
  full: '<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/>',
  gear: '<path d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z"/><path d="m9 3-1 3-3 1-2 5 2 5 3 1 1 3h6l1-3 3-1 2-5-2-5-3-1-1-3z"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  chart: '<path d="M3 3v18h18M6 16l5-6 4 3 6-8"/>',
  number: '<path d="m7 5-3 2m3-2v14M13 7a4 4 0 0 1 8 0c0 4-8 6-8 12h8"/>',
  gauge: '<path d="M4 19a10 10 0 1 1 16 0M12 13l5-5"/><circle cx="12" cy="13" r="2"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>',
  moon: '<path d="M20.5 13A9 9 0 0 1 11 3.5 9 9 0 1 0 20.5 13Z"/>',
};
function icon(name: keyof typeof icons) { return `<svg viewBox="0 0 24 24" aria-hidden="true">${icons[name]}</svg>`; }
function esc(value: string) { return value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!)); }
const colors = ['#0067b8', '#616161', '#107c10', '#d83b01'];
const legacyColors = ['#eab88b', '#72d7bf', '#93b9ef', '#c2a6ef'];
const cellSize = 80;
const storageKey = 'pc-monitor-board-v1';
const uid = () => `w-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
let presentation = false;
let canvasScale = 1;
let fitFrame = 0;
let catalog: Metric[] = [];
const portrait = innerHeight > innerWidth;
let board: Board = { version: 2, widgets: [], columns: portrait ? 6 : 12,
  rows: portrait ? 12 : 8, layout: {} };
let initialized = false;
let editing = false;
let grid: GridStack;
let connection: Connection = 'connecting';
let failures = 0;
let lastSample: number | null = null;
let currentValues: Record<string, number | null> = {};
let timer: ReturnType<typeof setTimeout>;
let running = false;
let rerun = false;
let historyAt = 0;
let period = 900;
let editingWidget: string | null = null;
let catalogAt = 0;
let messageTimer: ReturnType<typeof setTimeout>;
const runtimes = new Map<string, Runtime>();
const histories = new Map<string, [number, number | null][]>();

$('#app').innerHTML = `
  <main>
    <div class="toolbar-dock">
    <button class="toolbar-reveal" aria-label="Показать панель управления"><span class="sr-only">Показать панель управления</span></button>
    <header class="toolbar">
      <div class="machine-status"><h1 id="hostname" title="Имя машины">Подключение…</h1><span id="connection" class="status" role="status"><i></i><span>Подключаемся</span></span><span id="last-update" class="sr-only">Ожидаем первые измерения</span></div>
      <form id="canvas-size" class="canvas-size" aria-label="Размер поля в клетках">
        <span>Поле</span><label><span class="sr-only">Ширина в клетках</span><input id="canvas-columns" aria-label="Ширина в клетках" type="number" min="2" max="48" step="1" required /></label><span>×</span><label><span class="sr-only">Высота в клетках</span><input id="canvas-rows" aria-label="Высота в клетках" type="number" min="2" max="96" step="1" required /></label><span>клеток</span>
      </form>
      <div class="toolbar-actions">
        <label class="period-label" hidden><select id="period" aria-label="Период графиков"><option value="300">5 минут</option><option value="900" selected>15 минут</option><option value="3600">1 час</option><option value="21600">6 часов</option><option value="86400">24 часа</option></select></label>
        <button id="edit" class="button" aria-label="Редактировать" title="Редактировать">${icon('edit')}<span>Редактировать</span></button>
        <button id="add" class="button primary" aria-label="Добавить виджет" title="Добавить виджет">${icon('plus')}<span>Виджет</span></button>
        <button class="icon-button" id="theme" aria-label="Включить тёмную тему" title="Включить тёмную тему">${icon('moon')}</button>
        <button class="icon-button" id="fullscreen" aria-label="Полный экран" title="Полный экран">${icon('full')}</button>
      </div>
    </header>
    </div>
    <div class="connection-banner" id="banner" role="status" hidden><div><strong id="banner-title"></strong><span id="banner-text"></span></div><button id="retry" class="button small">Повторить ${icon('arrow')}</button></div>
    <section class="workspace" aria-label="Дашборд">
      <div id="edit-hint" class="edit-hint" hidden>Перетаскивайте карточки за заголовок. Потяните за угол, чтобы изменить размер. Настройки сохраняются на этом устройстве.</div>
      <div id="dashboard-stage"><div id="canvas-frame"><div class="grid-stack" id="dashboard"></div></div></div>
      <div id="empty" class="empty" hidden>${icon('grid')}<h2>Добавьте первый виджет</h2><p>Выберите показатель компьютера.</p><button class="button primary" id="empty-add">Добавить виджет</button></div>
    </section>
  </main>
  <dialog id="library" class="drawer"><div class="drawer-head"><div><div class="eyebrow">КОНСТРУКТОР</div><h2>Добавить виджет</h2></div><button class="icon-button" data-close="library" aria-label="Закрыть каталог">${icon('close')}</button></div><p class="drawer-description">Выберите заготовку. На большом экране её можно перетащить на дашборд.</p><div id="templates"></div><div class="drawer-note">В каждом виджете можно выбрать показатель и устройство. Доступны только обнаруженные источники.</div></dialog>
  <dialog id="settings"><form id="widget-form"><div class="drawer-head"><div><div class="eyebrow">НАСТРОЙКА ВИДЖЕТА</div><h2 id="settings-title">Новый виджет</h2></div><button type="button" class="icon-button" data-close="settings" aria-label="Закрыть настройки">${icon('close')}</button></div>
    <label>Название<input id="widget-title" maxlength="60" placeholder="Название показателя" /></label>
    <div class="form-row"><label>Отображение<select id="widget-type"><option value="number">Число</option><option value="gauge">Шкала</option><option value="chart">График</option></select></label><label>Группа<select id="metric-group"></select></label></div>
    <label>Показатель и устройство<select id="metric-select" required></select></label>
    <label id="secondary-label">Второй ряд<select id="secondary-select"><option value="">Без второго ряда</option></select></label>
    <label id="threshold-label">Порог предупреждения, %<input id="widget-threshold" type="number" min="1" max="100" value="85" /></label>
    <fieldset><legend>Цвет</legend><div class="color-picker">${colors.map((c, i) => `<label class="color-option" style="--swatch:${c}"><input type="radio" name="color" value="${c}" ${i === 0 ? 'checked' : ''} aria-label="Цвет ${i + 1}"/><span></span></label>`).join('')}</div></fieldset>
    <p id="form-error" class="form-error" role="alert"></p><div class="form-actions"><button type="button" id="delete-widget" class="button danger" hidden>Удалить</button><button type="button" class="button" data-close="settings">Отмена</button><button class="button primary" type="submit">Сохранить</button></div>
  </form></dialog>
  <div class="toast" role="status" id="toast" hidden></div>`;

function toast(text: string) {
  $('#toast').textContent = text; $('#toast').hidden = false;
  clearTimeout(messageTimer); messageTimer = setTimeout(() => $('#toast').hidden = true, 4500);
}
function readBoard(): boolean {
  try {
    const value: Board | LegacyBoard = JSON.parse(localStorage.getItem(storageKey) || 'null');
    if (!value || ![1, 2].includes(value.version) || !Array.isArray(value.widgets) || value.widgets.length > 24) return false;
    if (!value.widgets.every(w => typeof w.id === 'string' && w.id.length < 80 && ['number', 'gauge', 'chart'].includes(w.type)
      && typeof w.title === 'string' && w.title.length <= 60 && Array.isArray(w.metrics) && w.metrics.length > 0
      && w.metrics.length <= 2 && w.metrics.every(m => typeof m === 'string') && [...colors, ...legacyColors].includes(w.color)
      && Number.isFinite(w.threshold) && w.threshold > 0 && w.threshold <= 100)) return false;
    if (new Set(value.widgets.map(w => w.id)).size !== value.widgets.length) return false;
    const widgets = value.widgets.map(w => ({ ...w, color: legacyColors.includes(w.color) ? colors[0] : w.color }));
    let layout: Record<string, Position> = {};
    let columns = board.columns, rows = board.rows;
    if (value.version === 2) {
      if (!Number.isInteger(value.columns) || !Number.isInteger(value.rows)
        || value.columns < 2 || value.columns > 48 || value.rows < 2 || value.rows > 96) return false;
      columns = value.columns; rows = value.rows; layout = value.layout;
    } else {
      // Сохраняем старые карточки и переносим наиболее подходящую прежнюю раскладку
      const candidates = portrait ? ['screenTall', 'phone', 'wide'] : ['screenWide', 'wide', 'tablet'];
      const key = candidates.find(k => widgets.every(w => value.layouts?.[k]?.[w.id])) || 'wide';
      const source = value.layouts?.[key] || {};
      const oldColumns = key === 'phone' ? 1 : Math.max(1, ...Object.values(source).map(p => p.x + p.w));
      const factor = oldColumns < 6 ? Math.ceil(6 / oldColumns) : 1;
      layout = Object.fromEntries(Object.entries(source).map(([id, p]) => [id, { ...p, x: p.x * factor, w: p.w * factor }]));
      columns = Math.min(48, Math.max(2, oldColumns * factor));
      rows = Math.min(96, Math.max(2, ...Object.values(layout).map(p => p.y + p.h)));
      localStorage.setItem('pc-monitor-board-before-fixed-grid', JSON.stringify(value));
    }
    board = { version: 2, widgets, columns, rows, layout: {} };
    for (const widget of widgets) {
      const p = layout?.[widget.id];
      if (p && [p.x, p.y, p.w, p.h].every(n => Number.isInteger(n) && n >= 0)
        && p.w >= 1 && p.h >= 2 && p.x + p.w <= columns && p.y + p.h <= rows) board.layout[widget.id] = p;
    }
    return true;
  } catch { return false; }
}
function persist() {
  if (!initialized) return;
  try { localStorage.setItem(storageKey, JSON.stringify(board)); }
  catch { toast('Браузер не смог сохранить раскладку. Она доступна до закрытия страницы.'); }
}
function savePositions() {
  if (!grid) return;
  for (const el of grid.getGridItems()) {
    const n = el.gridstackNode!;
    if (n.id) board.layout[n.id] = { x: n.x || 0, y: n.y || 0, w: n.w || 1, h: n.h || 3 };
  }
  persist();
}
function defaultBoard() {
  const network = catalog.find(m => m.id.startsWith('network.receive'));
  const transmit = network && catalog.find(m => m.group === 'Сеть' && m.device === network.device && m.id.startsWith('network.transmit'));
  const disk = catalog.find(m => m.id.startsWith('fs.usage') && m.device === '/') || catalog.find(m => m.id.startsWith('fs.usage'));
  const specs: [Kind, string, string[], string][] = [
    ['chart', 'Загрузка процессора', ['cpu.usage'], colors[0]],
    ['gauge', 'Оперативная память', ['memory.usage'], colors[0]],
    ['chart', 'Сетевая активность', network ? [network.id, ...(transmit ? [transmit.id] : [])] : ['cpu.usage'], colors[0]],
    ['gauge', 'Место на диске', [disk?.id || 'memory.usage'], colors[0]],
    ['number', 'Время без перезагрузки', ['host.uptime'], colors[0]],
  ];
  board.widgets = specs.map(([type, title, metrics, color]) => ({ id: uid(), type, title, metrics, color, threshold: 85 }));
  const positions: Position[] = portrait
    ? [{ x: 0, y: 0, w: 6, h: 4 }, { x: 0, y: 4, w: 3, h: 4 },
       { x: 0, y: 8, w: 3, h: 4 }, { x: 3, y: 4, w: 3, h: 4 }, { x: 3, y: 8, w: 3, h: 4 }]
    : [{ x: 0, y: 0, w: 8, h: 3 }, { x: 8, y: 0, w: 4, h: 3 },
       { x: 0, y: 3, w: 6, h: 3 }, { x: 6, y: 3, w: 3, h: 3 }, { x: 9, y: 3, w: 3, h: 3 }];
  board.widgets.forEach((w, i) => board.layout[w.id] = positions[i]);
  initialized = true; persist();
}
function meta(id: string) { return catalog.find(m => m.id === id); }
function valueLabel(value: number | null | undefined, unit = ''): [string, string] {
  if (value === null || value === undefined || !Number.isFinite(value)) return ['—', ''];
  if (unit === 'seconds') {
    if (value >= 86400) return [(value / 86400).toFixed(1).replace('.', ','), 'дн.'];
    return [Math.floor(value / 3600).toString(), 'ч'];
  }
  if (unit === 'bytes' || unit === 'bytes/s') {
    const units = unit === 'bytes' ? ['Б', 'КиБ', 'МиБ', 'ГиБ', 'ТиБ'] : ['Б/с', 'КиБ/с', 'МиБ/с', 'ГиБ/с'];
    const i = value > 0 ? Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1) : 0;
    return [(value / 1024 ** Math.max(i, 0)).toLocaleString('ru-RU', { maximumFractionDigits: 1 }), units[Math.max(i, 0)]];
  }
  return [value.toLocaleString('ru-RU', { maximumFractionDigits: 1 }), unit === 'celsius' ? '°C' : unit];
}
function displayColor(color: string) {
  if (document.documentElement.dataset.theme !== 'dark') return color;
  return ({ '#0067b8': '#69b8f7', '#616161': '#b3b3b3', '#107c10': '#7dcc80', '#d83b01': '#ff9b79' } as Record<string, string>)[color] || '#69b8f7';
}
function fitCanvas() {
  if (!grid) return;
  const stage = $('#dashboard-stage');
  const width = board.columns * cellSize, height = board.rows * cellSize;
  const scale = Math.min(Math.max(1, stage.clientWidth - 2) / width, Math.max(1, stage.clientHeight - 2) / height);
  canvasScale = scale;
  document.documentElement.style.setProperty('--canvas-scale', String(scale));
  const frame = $('#canvas-frame');
  // Меняем реальные CSS-размеры: transform масштабировал уже нарисованный Canvas и текст
  frame.style.width = `${width * scale}px`; frame.style.height = `${height * scale}px`;
  frame.style.transform = 'none';
  const dpr = window.devicePixelRatio || 1;
  const snap = (v: number) => Math.round(v * dpr) / dpr;
  frame.style.left = `${snap(Math.max(0, (stage.clientWidth - width * scale) / 2))}px`;
  frame.style.top = `${snap(Math.max(0, (stage.clientHeight - height * scale) / 2))}px`;
  grid.cellHeight(cellSize * scale); grid.margin(6 * scale);
  for (const [id, runtime] of runtimes) {
    const h = runtime.element.clientHeight / scale;
    runtime.element.classList.toggle('fit-dense', h < 200);
    runtime.element.classList.toggle('fit-tiny', h < 130);
    const reading = Math.max(14, Math.min(38, h * .2, runtime.element.clientWidth / scale * .2));
    runtime.element.style.setProperty('--fit-reading', `${reading}px`);
    runtime.element.style.setProperty('--fit-unit', `${Math.max(9, Math.min(15, reading * .45))}px`);
    runtime.element.style.setProperty('--header-reading', `${h < 130 ? 10 : h < 200 ? 12 : 14}px`);
    runtime.element.style.setProperty('--fit-padding', `${Math.max(3, Math.min(16, h * .06))}px`);
    if (runtime.chart && Math.abs((runtime.chartScale || 1) - scale) > .0001) {
      const widget = board.widgets.find(w => w.id === id)!;
      createChart(widget, runtime); updateChart(widget, runtime);
    }
  }
  frame.dataset.ready = 'true';
}
function scheduleFit() {
  if (!CSS.supports('height', '100dvh')) $('main').style.height = `${innerHeight}px`;
  cancelAnimationFrame(fitFrame); fitFrame = requestAnimationFrame(fitCanvas);
}
function syncCanvasControls() {
  $<HTMLInputElement>('#canvas-columns').value = String(board.columns);
  $<HTMLInputElement>('#canvas-rows').value = String(board.rows);
  for (const id of ['#canvas-columns', '#canvas-rows']) $(id).setAttribute('aria-invalid', 'false');
}
function renderBoard() {
  $('#canvas-frame').dataset.ready = 'false';
  for (const r of runtimes.values()) { r.observer?.disconnect(); r.chart?.destroy(); }
  runtimes.clear();
  if (grid) grid.destroy(false);
  $('#dashboard').replaceChildren();
  const columns = board.columns;
  $('#canvas-frame').style.width = `${columns * cellSize * canvasScale}px`;
  $('#canvas-frame').style.height = `${board.rows * cellSize * canvasScale}px`;
  grid = GridStack.init({ column: columns, cellHeight: cellSize * canvasScale, margin: 6 * canvasScale, animate: false,
    minRow: board.rows, maxRow: board.rows, float: true,
    handle: '.drag-handle', disableDrag: !editing, disableResize: !editing,
    alwaysShowResizeHandle: true, columnOpts: { breakpoints: [] } }, '#dashboard');
  grid.batchUpdate();
  for (const widget of board.widgets) {
    const existing = board.layout[widget.id];
    const position: GridStackWidget = existing ? { ...existing } : {
      w: Math.min(4, columns), h: 2, autoPosition: true,
    };
    const el = document.createElement('div'); el.className = 'grid-stack-item'; el.dataset.widgetId = widget.id;
    const content = document.createElement('article'); content.className = `grid-stack-item-content metric-card ${widget.type}`;
    content.style.setProperty('--accent', displayColor(widget.color));
    const reading = '<div class="metric-reading"><strong>—</strong><span></span></div>';
    content.innerHTML = `<div class="card-heading"><div class="drag-handle"><span class="drag-dots">⠿</span><h3 title="${esc(widget.title)}">${esc(widget.title)}</h3></div><div class="card-heading-tools"><button class="card-settings icon-button" aria-label="Настроить ${esc(widget.title)}">${icon('gear')}</button>${widget.type !== 'number' ? reading : ''}</div></div><div class="card-device"></div>${widget.type === 'number' ? reading : ''}<div class="card-visual"></div><div class="card-bottom"><span class="metric-note">Ожидаем измерения</span><span class="card-kind">${widget.type === 'chart' ? 'ИСТОРИЯ' : widget.type === 'gauge' ? 'ЗАПОЛНЕНИЕ' : 'ТЕКУЩЕЕ'}</span></div>`;
    content.querySelector('button')!.addEventListener('click', () => openSettings(widget));
    el.append(content); grid.el.append(el);
    grid.makeWidget(el, { ...position, id: widget.id, minW: 1, minH: 2, maxH: board.rows });
    const runtime: Runtime = { element: content }; runtimes.set(widget.id, runtime);
    if (widget.type === 'gauge') content.querySelector('.card-visual')!.innerHTML = '<div class="gauge-track"><div class="gauge-fill"></div></div><div class="gauge-labels"><span>0%</span><span>100%</span></div>';
    if (widget.type === 'chart') createChart(widget, runtime);
  }
  grid.batchUpdate(false);
  grid.on('change', () => savePositions());
  grid.on('dragstop resizestop', () => scheduleFit());
  savePositions(); syncCanvasControls();
  $('#empty').hidden = board.widgets.length !== 0;
  document.body.classList.toggle('editing', editing);
  updateCards();
  scheduleFit();
}
function createChart(widget: Widget, runtime: Runtime) {
  const host = runtime.element.querySelector<HTMLElement>('.card-visual')!;
  runtime.observer?.disconnect(); runtime.chart?.destroy(); host.replaceChildren();
  const scale = canvasScale;
  runtime.chartScale = scale;
  const axesColor = getComputedStyle(document.documentElement).getPropertyValue('--muted').trim();
  const gridColor = getComputedStyle(document.documentElement).getPropertyValue('--chart-grid').trim();
  const lineColor = displayColor(widget.color);
  const lines = widget.metrics.map((id, i) => ({ label: meta(id)?.title || 'Показатель', stroke: i ? axesColor : lineColor,
    width: Math.max(.6, 1.8 * scale), fill: i ? undefined : `${lineColor}12`, spanGaps: false,
    value: (_: uPlot, v: number) => valueLabel(v, meta(id)?.unit).join(' ') }));
  runtime.chart = new uPlot({
    width: Math.max(20, host.clientWidth), height: Math.max(12, host.clientHeight),
    padding: [14 * scale, 8 * scale, 0, 4 * scale], legend: { show: false },
    cursor: { drag: { x: false, y: false } },
    scales: { x: { time: true }, y: { auto: true } },
    axes: [{ stroke: axesColor, grid: { show: false }, ticks: { show: false }, size: 24 * scale, gap: 5 * scale,
      font: `${Math.max(1, Math.round(10 * scale))}px system-ui`, values: (_u, values) => values.map(v => new Date(v * 1000).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })) },
    { stroke: axesColor, grid: { stroke: gridColor, width: 1 }, ticks: { show: false }, size: 52 * scale, gap: 5 * scale,
      font: `${Math.max(1, Math.round(10 * scale))}px system-ui`, values: (_u, values) => values.map(v => valueLabel(v, meta(widget.metrics[0])?.unit).join(' ')) }],
    series: [{}, ...lines],
  }, [[] as number[], ...widget.metrics.map(() => [] as (number | null)[])], host);
  runtime.observer = new ResizeObserver(() => runtime.chart?.setSize({ width: Math.max(20, host.clientWidth), height: Math.max(12, host.clientHeight) }));
  runtime.observer.observe(host);
}
function updateChart(widget: Widget, runtime: Runtime) {
  if (!runtime.chart) return;
  const primary = histories.get(widget.metrics[0]) || [];
  const times = primary.map(p => p[0]);
  const series = widget.metrics.map(id => {
    const points = new Map(histories.get(id) || []);
    return times.map(t => points.get(t) ?? null);
  });
  runtime.chart.setData([times, ...series]);
}
function updateCards() {
  const stale = connection !== 'live';
  for (const widget of board.widgets) {
    const runtime = runtimes.get(widget.id); if (!runtime) continue;
    const metric = meta(widget.metrics[0]);
    const value = currentValues[widget.metrics[0]];
    const [display, unit] = valueLabel(value, metric?.unit);
    runtime.element.querySelector('.metric-reading strong')!.textContent = display;
    runtime.element.querySelector('.metric-reading span')!.textContent = unit;
    runtime.element.querySelector('.card-device')!.textContent = metric ? `${metric.group} / ${metric.device}` : 'Источник недоступен';
    runtime.element.classList.toggle('stale', stale);
    runtime.element.classList.toggle('warning', metric?.unit === '%' && value != null && value >= widget.threshold);
    const note = runtime.element.querySelector('.metric-note')!;
    if (stale && lastSample) note.textContent = 'Данные устарели';
    else if (!metric) note.textContent = 'Источник недоступен';
    else if (value == null) note.textContent = 'Собираются данные';
    else if (widget.metrics.length > 1) {
      const second = meta(widget.metrics[1]);
      note.textContent = `${second?.title || 'Второй ряд'}: ${valueLabel(currentValues[widget.metrics[1]], second?.unit).join(' ')}`;
    } else note.textContent = 'Последнее измерение';
    const fill = runtime.element.querySelector<HTMLElement>('.gauge-fill');
    if (fill) fill.style.width = `${Math.max(0, Math.min(100, value ?? 0))}%`;
    updateChart(widget, runtime);
  }
}
function setConnection(next: Connection) {
  connection = next;
  const names: Record<Connection, string> = { connecting: 'Подключаемся', live: 'Онлайн', checking: 'Проверяем связь', offline: 'Нет связи', source: 'Метрики недоступны' };
  $('#connection').className = `status ${next}`;
  $('#connection span').textContent = names[next];
  $('#last-update').textContent = lastSample ? `Последнее измерение: ${new Date(lastSample * 1000).toLocaleTimeString('ru-RU')}` : 'Ожидаем первые измерения';
  $('#connection').title = $('#last-update').textContent || '';
  const show = !['live', 'connecting'].includes(next); $('#banner').hidden = !show;
  if (show) {
    $('#banner-title').textContent = next === 'source' ? 'Сайт работает. Источник метрик недоступен.' : next === 'offline' ? 'Нет связи с сервером' : 'Сервер не ответил вовремя';
    $('#banner-text').textContent = `${lastSample ? 'Показаны последние известные значения. ' : ''}Проверяем соединение автоматически. Ваша раскладка сохранена.`;
  }
  document.body.classList.toggle('disconnected', next !== 'live');
  updateCards();
  scheduleFit();
}
class ApiError extends Error { constructor(public status: number) { super(`HTTP ${status}`); } }
async function api<T>(path: string, body?: unknown, timeout = 3000): Promise<T> {
  const controller = new AbortController(); const timeoutId = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(path, { method: body ? 'POST' : 'GET', signal: controller.signal, cache: 'no-store',
      headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
    if (!response.ok) throw new ApiError(response.status);
    return await response.json() as T;
  } finally { clearTimeout(timeoutId); }
}
async function refresh() {
  clearTimeout(timer);
  if (running) { rerun = true; return; }
  if (document.hidden) return;
  running = true;
  let prior = connection;
  try {
    if (!catalog.length || Date.now() - catalogAt > 60000) {
      const result = await api<Catalog>('/api/catalog'); catalog = result.metrics;
      catalogAt = Date.now(); $('#hostname').textContent = result.hostname;
      if (!initialized) { defaultBoard(); renderBoard(); }
    }
    const ids = [...new Set(board.widgets.flatMap(w => w.metrics))];
    const data = await api<Snapshot>('/api/snapshot', { ids: ids.length ? ids : ['cpu.usage'] });
    if (Date.now() / 1000 - data.sample_time > 12) throw new ApiError(503);
    lastSample = data.sample_time; currentValues = data.values;
    $('#hostname').textContent = data.hostname;
    failures = 0; setConnection('live');
    if (prior === 'offline' || prior === 'source') { toast('Связь восстановлена'); historyAt = 0; }
    const charts = [...new Set(board.widgets.filter(w => w.type === 'chart').flatMap(w => w.metrics))];
    if (charts.length && Date.now() - historyAt >= 6000) {
      try {
        const history = await api<{ series: Record<string, [number, number | null][]> }>('/api/history', { ids: charts, seconds: period }, 8000);
        for (const [id, points] of Object.entries(history.series)) histories.set(id, points);
        historyAt = Date.now(); updateCards();
      } catch { /* Следующий опрос повторит историю; её ошибка не уничтожает текущие показания */ }
    }
  } catch (error) {
    failures++;
    setConnection(error instanceof ApiError && error.status === 503 ? 'source' : failures >= 3 ? 'offline' : 'checking');
  } finally {
    running = false;
    if (rerun) { rerun = false; timer = setTimeout(refresh, 0); }
    else {
      const delay = failures === 0 ? 2000 : failures < 3 ? 2000 : failures === 3 ? 5000 : failures === 4 ? 10000 : 30000;
      timer = setTimeout(refresh, delay + (failures >= 3 ? Math.random() * 500 : 0));
    }
  }
}
function toggleEditing(value = !editing) {
  editing = value; grid.enableMove(value); grid.enableResize(value);
  document.body.classList.toggle('editing', value); $('#edit-hint').hidden = !value;
  $('#edit span').textContent = value ? 'Готово' : 'Редактировать';
  $('#edit').setAttribute('aria-label', value ? 'Готово' : 'Редактировать');
  $('.period-label').hidden = !value;
  $('#edit').classList.toggle('active', value); if (!value) savePositions();
  scheduleFit();
}
function openSettings(widget?: Widget, kind: Kind = 'number') {
  editingWidget = widget?.id || null;
  $('#settings-title').textContent = widget ? 'Настройка виджета' : 'Новый виджет';
  $<HTMLInputElement>('#widget-title').value = widget?.title || '';
  $<HTMLSelectElement>('#widget-type').value = widget?.type || kind;
  $<HTMLInputElement>('#widget-threshold').value = String(widget?.threshold || 85);
  for (const input of document.querySelectorAll<HTMLInputElement>('input[name="color"]')) input.checked = input.value === (widget?.color || colors[0]);
  const groups = [...new Set(catalog.map(m => m.group))];
  $<HTMLSelectElement>('#metric-group').innerHTML = groups.map(g => `<option>${esc(g)}</option>`).join('');
  const current = widget && meta(widget.metrics[0]);
  if (current) $<HTMLSelectElement>('#metric-group').value = current.group;
  fillMetrics(widget?.metrics[0]);
  fillSecondary(widget?.metrics[1]);
  $('#form-error').textContent = catalog.length ? '' : 'Нет доступного каталога. Дождитесь связи с источником метрик.';
  $('#delete-widget').hidden = !widget;
  const library = $<HTMLDialogElement>('#library'); if (library.open) library.close();
  $<HTMLDialogElement>('#settings').showModal();
}
function fillMetrics(selected?: string) {
  const group = $<HTMLSelectElement>('#metric-group').value;
  $<HTMLSelectElement>('#metric-select').innerHTML = catalog.filter(m => m.group === group).map(m => `<option value="${esc(m.id)}">${esc(m.title)} · ${esc(m.device)}</option>`).join('');
  if (selected && meta(selected)?.group === group) $<HTMLSelectElement>('#metric-select').value = selected;
  fillSecondary();
}
function fillSecondary(selected?: string) {
  const first = meta($<HTMLSelectElement>('#metric-select').value);
  const type = $<HTMLSelectElement>('#widget-type').value;
  $('#secondary-label').hidden = type !== 'chart';
  $('#threshold-label').hidden = first?.unit !== '%';
  $<HTMLSelectElement>('#secondary-select').innerHTML = '<option value="">Без второго ряда</option>' + catalog.filter(m => m.id !== first?.id && m.unit === first?.unit && m.group === first?.group && m.device === first?.device).map(m => `<option value="${esc(m.id)}">${esc(m.title)} · ${esc(m.device)}</option>`).join('');
  if (selected) $<HTMLSelectElement>('#secondary-select').value = selected;
}
$('#widget-form').addEventListener('submit', event => {
  event.preventDefault();
  const metric = meta($<HTMLSelectElement>('#metric-select').value);
  if (!metric) { $('#form-error').textContent = 'Выберите доступный показатель.'; return; }
  const type = $<HTMLSelectElement>('#widget-type').value as Kind;
  if (type === 'gauge' && metric.unit !== '%') { $('#form-error').textContent = 'Шкала подходит для показателей в процентах. Выберите число или график.'; return; }
  if (!editingWidget && board.widgets.length >= 24) { $('#form-error').textContent = 'Достигнут предел: 24 виджета.'; return; }
  const second = $<HTMLSelectElement>('#secondary-select').value;
  const widget: Widget = { id: editingWidget || uid(), type,
    title: $<HTMLInputElement>('#widget-title').value.trim() || metric.title,
    metrics: [metric.id, ...(type === 'chart' && second && meta(second) ? [second] : [])],
    color: $<HTMLInputElement>('input[name="color"]:checked').value,
    threshold: Number($<HTMLInputElement>('#widget-threshold').value) || 85 };
  if (editingWidget) board.widgets = board.widgets.map(w => w.id === editingWidget ? widget : w);
  else {
    if (!grid.willItFit({ w: Math.min(4, board.columns), h: 2, autoPosition: true })) {
      $('#form-error').textContent = 'В поле нет свободного места. Увеличьте число клеток на верхней панели или уменьшите карточки.';
      return;
    }
    board.widgets.push(widget);
  }
  initialized = true; savePositions(); persist(); renderBoard(); historyAt = 0;
  $<HTMLDialogElement>('#settings').close(); refresh();
});
$('#delete-widget').addEventListener('click', () => {
  board.widgets = board.widgets.filter(w => w.id !== editingWidget);
  delete board.layout[editingWidget!];
  persist(); renderBoard(); $<HTMLDialogElement>('#settings').close();
});
$('#metric-group').addEventListener('change', () => fillMetrics());
$('#metric-select').addEventListener('change', () => fillSecondary());
$('#widget-type').addEventListener('change', () => fillSecondary());
const templateKinds: [Kind, string, string, keyof typeof icons][] = [
  ['number', 'Числовой показатель', 'Одно значение. Крупно и по делу.', 'number'],
  ['gauge', 'Шкала заполнения', 'Проценты, цвет и порог предупреждения.', 'gauge'],
  ['chart', 'График во времени', 'История одного или двух показателей.', 'chart'],
];
for (const [type, title, description, glyph] of templateKinds) {
  const item = document.createElement('button'); item.className = 'template'; item.type = 'button'; item.dataset.kind = type;
  item.innerHTML = `<span class="template-icon">${icon(glyph)}</span><span><strong>${title}</strong><small>${description}</small></span>${icon('plus')}`;
  item.addEventListener('click', () => openSettings(undefined, type)); $('#templates').append(item);
}
function openLibrary() {
  if (!editing) toggleEditing(true);
  $<HTMLDialogElement>('#library').showModal();
}
// HTML drag-and-drop используется только как дополнение: на touch есть кнопки добавления
for (const template of document.querySelectorAll<HTMLElement>('.template')) {
  template.draggable = true;
  template.addEventListener('dragstart', e => {
    e.dataTransfer?.setData('application/x-pc-monitor-widget', template.dataset.kind!);
    setTimeout(() => $<HTMLDialogElement>('#library').close(), 0);
  });
}
$('#dashboard').addEventListener('dragover', e => { if (e.dataTransfer?.types.includes('application/x-pc-monitor-widget')) e.preventDefault(); });
$('#dashboard').addEventListener('drop', e => {
  const kind = e.dataTransfer?.getData('application/x-pc-monitor-widget');
  if (kind && ['number', 'gauge', 'chart'].includes(kind)) { e.preventDefault(); openSettings(undefined, kind as Kind); }
});
for (const button of document.querySelectorAll<HTMLElement>('[data-close]')) button.addEventListener('click', () => $<HTMLDialogElement>(`#${button.dataset.close}`).close());
for (const dialog of document.querySelectorAll<HTMLDialogElement>('dialog')) dialog.addEventListener('click', e => { if (e.target === dialog) { const r = dialog.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dialog.close(); } });
$('#add').addEventListener('click', openLibrary); $('#empty-add').addEventListener('click', openLibrary);
$('#edit').addEventListener('click', () => toggleEditing()); $('#retry').addEventListener('click', () => refresh());
$('#period').addEventListener('change', () => { period = Number($<HTMLSelectElement>('#period').value); historyAt = 0; refresh(); });
$('#fullscreen').addEventListener('click', async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else if (document.documentElement.requestFullscreen) await document.documentElement.requestFullscreen();
    else toast('Этот браузер не поддерживает полноэкранный режим.');
  } catch { toast('Браузер не разрешил полноэкранный режим.'); }
});
const toolbarDock = $('.toolbar-dock');
$('.toolbar-reveal').addEventListener('click', () => {
  toolbarDock.classList.toggle('toolbar-open');
  if (!toolbarDock.classList.contains('toolbar-open')) $('.toolbar-reveal').blur();
});
toolbarDock.addEventListener('pointerleave', event => {
  if (event.pointerType === 'mouse') toolbarDock.classList.remove('toolbar-open');
});
document.addEventListener('pointerdown', event => {
  if (presentation && !toolbarDock.contains(event.target as Node)) {
    toolbarDock.classList.remove('toolbar-open');
    if (toolbarDock.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
  }
});
document.addEventListener('fullscreenchange', () => {
  presentation = Boolean(document.fullscreenElement);
  document.documentElement.classList.toggle('presentation', presentation);
  toolbarDock.classList.remove('toolbar-open');
  if (toolbarDock.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
  scheduleFit();
  $('#fullscreen').setAttribute('aria-label', presentation ? 'Выйти из полного экрана' : 'Полный экран');
  $('#fullscreen').title = presentation ? 'Выйти из полного экрана' : 'Полный экран';
});
function applyTheme(theme: 'light' | 'dark', save = true) {
  document.documentElement.dataset.theme = theme;
  const title = theme === 'light' ? 'Включить тёмную тему' : 'Включить светлую тему';
  $('#theme').innerHTML = icon(theme === 'light' ? 'moon' : 'sun');
  $('#theme').setAttribute('aria-label', title); $('#theme').title = title;
  if (save) {
    try { localStorage.setItem('pc-monitor-theme', theme); }
    catch { toast('Не удалось сохранить тему в браузере.'); }
    savePositions(); renderBoard();
  }
}
$('#theme').addEventListener('click', () => applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));
window.addEventListener('online', () => refresh());
window.addEventListener('offline', () => { failures = Math.max(3, failures); setConnection('offline'); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) { historyAt = 0; refresh(); } else clearTimeout(timer); });
window.addEventListener('resize', () => scheduleFit());
function changeCanvasSize(final = false) {
  const columns = Number($<HTMLInputElement>('#canvas-columns').value);
  const rows = Number($<HTMLInputElement>('#canvas-rows').value);
  const valid = Number.isInteger(columns) && columns >= 2 && columns <= 48
    && Number.isInteger(rows) && rows >= 2 && rows <= 96;
  if (!valid) { if (final) syncCanvasControls(); return; }
  savePositions();
  const fits = !Object.values(board.layout).some(p => p.x + p.w > columns || p.y + p.h > rows);
  for (const id of ['#canvas-columns', '#canvas-rows']) $(id).setAttribute('aria-invalid', String(!fits));
  if (!fits) {
    if (final) {
      toast('Карточки выходят за границы нового поля. Сначала сдвиньте или уменьшите их.');
      syncCanvasControls();
    }
    return;
  }
  if (board.columns === columns && board.rows === rows) return;
  board.columns = columns; board.rows = rows; persist(); renderBoard();
}
for (const id of ['#canvas-columns', '#canvas-rows']) {
  $(id).addEventListener('input', () => changeCanvasSize());
  $(id).addEventListener('change', () => changeCanvasSize(true));
}
$('#canvas-size').addEventListener('submit', event => { event.preventDefault(); changeCanvasSize(true); });
new ResizeObserver(() => scheduleFit()).observe($('#dashboard-stage'));
try { applyTheme(localStorage.getItem('pc-monitor-theme') === 'light' ? 'light' : 'dark', false); }
catch { applyTheme('dark', false); }
initialized = readBoard(); renderBoard(); refresh();
