/**
 * Sylva Lodge — сервер заявок и бронирования (Google Apps Script + Google-таблица + Telegram).  Версия 2.
 *
 * Что умеет:
 *  • Заявки с сайта (как раньше): строка в листе «Заявки» + сообщение в Telegram.
 *  • Приложение бронирования:
 *      GET  ?action=busy           → занятые даты по домикам (оплаченные брони, удержания, ручные отметки «Занято»)
 *      POST {action:'hold', …}     → проверяет даты под блокировкой и закрепляет их за гостем на 3 дня
 *      POST {action:'pay', id, …}  → отмечает предоплату (сейчас — тестовый режим, без списания денег)
 *  • Каждый час снимает просроченные удержания (функция expireHolds) и сообщает об этом в Telegram.
 *
 * Подключение и обновление — «инструкция.md». Ключ бота хранится в свойствах скрипта (BOT_TOKEN, CHAT_ID).
 */

const SHEET_NAME = 'Заявки';
const BUSY_SHEET = 'Занято';            // сюда владелица вручную вносит даты, занятые не через приложение (Авито и т. п.)
const HOLD_DAYS = 3;                    // сколько дней даты держатся за гостем до предоплаты
const HEADERS = ['Получено', 'Статус', 'Тип', 'Домик', 'Заезд', 'Выезд', 'Ночей', 'Гостей', 'Сумма, ₽', 'Предоплата, ₽',
                 'Имя', 'Телефон', 'Пожелания / даты', 'Сертификат / повод', 'Страница',
                 'Номер брони', 'Удержание до', 'Оплата', 'Доп. услуги'];
const STATUSES = ['новая', 'удержание', 'оплачена', 'подтверждена', 'в работе', 'отказ', 'истекла'];
const COL = {}; HEADERS.forEach((h, i) => COL[h] = i);                       // номер столбца по названию (с нуля)
const FREE_STATUSES = ['отказ', 'истекла'];                                 // такие строки даты не занимают

// ======================= веб-приложение =======================

function doGet(e) {
  const action = e && e.parameter && e.parameter.action;
  if (action === 'busy') return out_({ ok: true, busy: busyList_(), holdDays: HOLD_DAYS });
  return out_({ ok: true, service: 'Sylva Lodge leads', version: 2 });
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return out_({ ok: false, error: 'busy_server' });
  try {
    const d = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (d.website) return out_({ ok: true });                                // ловушка для спам-ботов
    if (d.action === 'hold') return out_(hold_(d));
    if (d.action === 'pay') return out_(pay_(d));
    return out_(lead_(d));                                                   // обычная заявка с сайта
  } catch (err) {
    console.error(err);
    return out_({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

// ======================= логика =======================

/** Заявка с сайта (без удержания дат). */
function lead_(d) {
  if (!clean_(d.name) && !clean_(d.phone)) return { ok: false, error: 'empty' };
  appendRow_(d, { status: 'новая' });
  notify_(d, '📩');
  return { ok: true };
}

/** Удержание дат на HOLD_DAYS дней. Проверка пересечений идёт под блокировкой — двойной брони не будет. */
function hold_(d) {
  if (!clean_(d.name) || !clean_(d.phone)) return { ok: false, error: 'contacts' };
  if (!d.house || !isDate_(d.checkin) || !isDate_(d.checkout) || d.checkin >= d.checkout) return { ok: false, error: 'dates' };
  const clash = busyList_().some(b => b.house === d.house && d.checkin < b.checkout && b.checkin < d.checkout);
  if (clash) return { ok: false, error: 'taken' };
  const id = 'SL-' + Utilities.formatDate(new Date(), 'Asia/Yekaterinburg', 'yyMMdd') + '-' + Math.floor(100 + Math.random() * 900);
  const until = new Date(Date.now() + HOLD_DAYS * 864e5);
  appendRow_(Object.assign({}, d, { type: 'Бронь' }), { status: 'удержание', id: id, until: until, payment: 'ожидается' });
  notify_(Object.assign({}, d, { type: 'Бронь', id: id, until: until }), '⏳');
  return { ok: true, id: id, holdUntil: until.toISOString() };
}

/** Предоплата по номеру брони. Сейчас тестовый режим: отмечаем «оплачено (тест)». */
function pay_(d) {
  const sh = sheet_(), rows = sh.getDataRange().getValues();
  for (let r = rows.length - 1; r >= 1; r--) {
    if (String(rows[r][COL['Номер брони']]) !== String(d.id)) continue;
    const status = String(rows[r][COL['Статус']]);
    if (FREE_STATUSES.indexOf(status) >= 0) return { ok: false, error: 'expired' };
    const label = d.test ? 'оплачено (тест)' : 'оплачено';
    sh.getRange(r + 1, COL['Статус'] + 1).setValue('оплачена');
    sh.getRange(r + 1, COL['Оплата'] + 1).setValue(label + (d.method ? ', ' + (d.method === 'sbp' ? 'СБП' : 'карта') : ''));
    send_('✅ <b>Предоплата получена' + (d.test ? ' (тест)' : '') + '</b>\nБронь ' + esc_(d.id) + ' · ' + esc_(rows[r][COL['Домик']]) +
          '\n📅 ' + short_(rows[r][COL['Заезд']]) + ' — ' + short_(rows[r][COL['Выезд']]) +
          '\n💰 ' + rub_(rows[r][COL['Предоплата, ₽']]) + ' из ' + rub_(rows[r][COL['Сумма, ₽']]) +
          '\n👤 ' + esc_(rows[r][COL['Имя']]) + ', ' + esc_(rows[r][COL['Телефон']]));
    return { ok: true, id: d.id };
  }
  return { ok: false, error: 'not_found' };
}

/** Занятые даты: брони из «Заявок» (кроме отказа/истечения и просроченных удержаний) + ручной лист «Занято». */
function busyList_() {
  const list = [], now = Date.now();
  const rows = sheet_().getDataRange().getValues();
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r], house = String(row[COL['Домик']] || ''), ci = ymd_(row[COL['Заезд']]), co = ymd_(row[COL['Выезд']]);
    if (!house || !ci || !co) continue;
    const status = String(row[COL['Статус']] || '');
    if (FREE_STATUSES.indexOf(status) >= 0) continue;
    if (status === 'удержание' || status === 'новая') {
      const until = row[COL['Удержание до']] ? new Date(row[COL['Удержание до']]).getTime()
                                            : new Date(row[COL['Получено']]).getTime() + HOLD_DAYS * 864e5;
      if (until < now) continue;                                             // удержание просрочено — даты свободны
    }
    list.push({ house: house, checkin: ci, checkout: co, status: status === 'удержание' || status === 'новая' ? 'hold' : 'booked' });
  }
  const manual = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(BUSY_SHEET);
  if (manual) manual.getDataRange().getValues().slice(1).forEach(row => {
    const ci = ymd_(row[1]), co = ymd_(row[2]);
    if (row[0] && ci && co) list.push({ house: String(row[0]), checkin: ci, checkout: co, status: 'booked' });
  });
  return list;
}

/** Каждый час (триггер из setup): просроченные удержания → «истекла» + сообщение. */
function expireHolds() {
  const sh = sheet_(), rows = sh.getDataRange().getValues(), now = Date.now();
  for (let r = 1; r < rows.length; r++) {
    if (String(rows[r][COL['Статус']]) !== 'удержание' || !rows[r][COL['Удержание до']]) continue;
    if (new Date(rows[r][COL['Удержание до']]).getTime() > now) continue;
    sh.getRange(r + 1, COL['Статус'] + 1).setValue('истекла');
    send_('⌛ <b>Бронь ' + esc_(rows[r][COL['Номер брони']]) + ' истекла</b> — предоплата не поступила, даты освобождены.\n' +
          esc_(rows[r][COL['Домик']]) + ' · ' + short_(rows[r][COL['Заезд']]) + ' — ' + short_(rows[r][COL['Выезд']]) +
          '\n👤 ' + esc_(rows[r][COL['Имя']]) + ', ' + esc_(rows[r][COL['Телефон']]));
  }
}

// ======================= настройка и проверки =======================

/** Один раз (и после обновления кода): заголовки, статусы, лист «Занято», ежечасная проверка удержаний. */
function setup() {
  const sh = sheet_();
  sh.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]).setFontWeight('bold').setBackground('#f3e6d8');
  sh.setFrozenRows(1);
  const rule = SpreadsheetApp.newDataValidation().requireValueInList(STATUSES, true).setAllowInvalid(false).build();
  sh.getRange(2, COL['Статус'] + 1, 1000, 1).setDataValidation(rule);
  sh.getRange('A:A').setNumberFormat('dd.mm.yyyy hh:mm');
  sh.getRange(1, COL['Удержание до'] + 1, 1000, 1).setNumberFormat('dd.mm.yyyy hh:mm');
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const busy = ss.getSheetByName(BUSY_SHEET) || ss.insertSheet(BUSY_SHEET);
  if (!busy.getRange(1, 1).getValue()) {
    busy.getRange(1, 1, 1, 4).setValues([['Домик', 'Заезд', 'Выезд', 'Комментарий (Авито, свои и т. п.)']]).setFontWeight('bold').setBackground('#f3e6d8');
    busy.setFrozenRows(1);
    busy.getRange('B:C').setNumberFormat('dd.mm.yyyy');
    const houses = SpreadsheetApp.newDataValidation().requireValueInList(['Pine', 'Grand', 'Family House'], true).build();
    busy.getRange(2, 1, 500, 1).setDataValidation(houses);
  }
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'expireHolds').forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('expireHolds').timeBased().everyHours(1).create();
  sh.autoResizeColumns(1, HEADERS.length);
  Logger.log('Готово: листы «%s» и «%s», ежечасная проверка удержаний включена.', SHEET_NAME, BUSY_SHEET);
}

function testTelegram() {
  notify_({ type: 'Тест', house: 'Grand', checkin: '2026-12-20', checkout: '2026-12-22', nights: 2, guests: 2,
            total: 19000, name: 'Проверка', phone: '+7 900 000-00-00', comment: 'Если вы это видите — всё работает 🙂' }, '🧪');
  Logger.log('Отправлено. Проверьте Telegram.');
}

function findChatId() {
  const res = JSON.parse(UrlFetchApp.fetch('https://api.telegram.org/bot' + prop_('BOT_TOKEN') + '/getUpdates').getContentText());
  const chats = {};
  (res.result || []).forEach(u => { const m = u.message || u.my_chat_member || u.channel_post; if (m && m.chat) chats[m.chat.id] = (m.chat.title || m.chat.first_name || '') + ' (' + m.chat.type + ')'; });
  if (!Object.keys(chats).length) Logger.log('Пусто. Нажмите «Запустить» у бота (или напишите в группе с ботом) и запустите снова.');
  Object.keys(chats).forEach(id => Logger.log('CHAT_ID = %s  →  %s', id, chats[id]));
}

// ======================= служебное =======================

function appendRow_(d, x) {
  const row = new Array(HEADERS.length).fill('');
  const set = (h, v) => row[COL[h]] = v;
  set('Получено', new Date()); set('Статус', x.status); set('Тип', clean_(d.type)); set('Домик', clean_(d.house));
  set('Заезд', clean_(d.checkin)); set('Выезд', clean_(d.checkout)); set('Ночей', num_(d.nights)); set('Гостей', clean_(d.guests));
  set('Сумма, ₽', num_(d.total)); set('Предоплата, ₽', num_(d.prepay)); set('Имя', clean_(d.name)); set('Телефон', clean_(d.phone));
  set('Пожелания / даты', clean_(d.comment || d.dates)); set('Сертификат / повод', clean_(d.certificate || d.occasion)); set('Страница', clean_(d.source));
  set('Номер брони', x.id || ''); set('Удержание до', x.until || ''); set('Оплата', x.payment || ''); set('Доп. услуги', clean_(d.extras));
  sheet_().appendRow(row);
}

function notify_(d, icon) {
  const lines = [
    icon + ' <b>' + esc_(d.type || 'Заявка') + (d.house ? ': ' + esc_(d.house) : '') + '</b>' + (d.id ? ' · ' + esc_(d.id) : ''),
    d.checkin ? '📅 ' + short_(d.checkin) + ' — ' + short_(d.checkout) + (d.nights ? ' (' + d.nights + ' ноч.)' : '') : '',
    d.guests ? '👥 Гостей: ' + esc_(d.guests) : '',
    d.extras ? '➕ ' + esc_(d.extras) : '',
    d.total ? '💰 ' + rub_(d.total) + (d.prepay ? ', предоплата ' + rub_(d.prepay) : '') : '',
    d.until ? '⏳ Даты закреплены до ' + Utilities.formatDate(d.until, 'Asia/Yekaterinburg', 'dd.MM HH:mm') + ' — ждём предоплату' : '',
    d.certificate ? '🎁 Номинал: ' + esc_(d.certificate) : '',
    d.occasion ? '🎉 Повод: ' + esc_(d.occasion) : '',
    d.dates ? '📅 Даты: ' + esc_(d.dates) : '',
    '',
    '👤 ' + esc_(d.name || '—'),
    '📞 ' + esc_(d.phone || '—'),
    d.comment ? '💬 ' + esc_(d.comment) : '',
  ].filter((l, i, a) => l !== '' || (i > 0 && a[i - 1] !== ''));
  send_(lines.join('\n'));
}

function send_(text) {
  const token = prop_('BOT_TOKEN'), chatId = prop_('CHAT_ID');
  if (!token || !chatId) { console.warn('BOT_TOKEN или CHAT_ID не заданы'); return; }
  UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    payload: JSON.stringify({ chat_id: chatId, text: text, parse_mode: 'HTML', disable_web_page_preview: true,
      reply_markup: { inline_keyboard: [[{ text: '📋 Открыть таблицу заявок', url: SpreadsheetApp.getActiveSpreadsheet().getUrl() }]] } })
  });
}

function sheet_() { const ss = SpreadsheetApp.getActiveSpreadsheet(); return ss.getSheetByName(SHEET_NAME) || ss.insertSheet(SHEET_NAME); }
function prop_(k) { return PropertiesService.getScriptProperties().getProperty(k) || ''; }
function clean_(v) { return v === undefined || v === null ? '' : String(v).slice(0, 500).replace(/^[=+\-@]/, "'$&"); }
function num_(v) { const n = Number(v); return isFinite(n) && v !== '' && v !== undefined && v !== null ? n : ''; }
function esc_(s) { return String(s === undefined || s === null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function rub_(n) { return n ? Number(n).toLocaleString('ru-RU') + ' ₽' : ''; }
function isDate_(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')); }
function ymd_(v) {                                                            // ячейка (Date или «2026-12-20» / «'2026-12-20») → «2026-12-20»
  if (!v) return '';
  if (v instanceof Date) return Utilities.formatDate(v, SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone(), 'yyyy-MM-dd'); // часовой пояс таблицы, чтобы дата не «съехала»
  const s = String(v).replace(/^'/, '');
  if (isDate_(s)) return s;
  const m = s.match(/^(\d{2})\.(\d{2})\.(\d{4})$/); return m ? m[3] + '-' + m[2] + '-' + m[1] : '';
}
function short_(v) { const s = ymd_(v); return s ? s.slice(8, 10) + '.' + s.slice(5, 7) : esc_(v); }
function out_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
