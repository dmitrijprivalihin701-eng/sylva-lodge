/**
 * Sylva Lodge — приём заявок с сайта в Google-таблицу + уведомление в Telegram.
 *
 * Как подключить — см. «инструкция.md» рядом с этим файлом. Коротко:
 *  1) Вставить этот код в Расширения → Apps Script у Google-таблицы.
 *  2) В «Настройках проекта» → «Свойства скрипта» добавить BOT_TOKEN и CHAT_ID.
 *  3) Запустить функцию setup() один раз, затем «Начать развёртывание» → «Веб-приложение»
 *     (Запуск от имени: я, Доступ: все). Полученный адрес вставить на сайт в LEADS_URL.
 *
 * Ключ бота хранится в свойствах скрипта, а не в коде и не на сайте.
 */

const SHEET_NAME = 'Заявки';
const HEADERS = ['Получено', 'Статус', 'Тип', 'Домик', 'Заезд', 'Выезд', 'Ночей', 'Гостей', 'Сумма, ₽', 'Предоплата, ₽',
                 'Имя', 'Телефон', 'Пожелания / даты', 'Сертификат / повод', 'Страница'];
const STATUSES = ['новая', 'в работе', 'подтверждена', 'отказ'];

/** Приём заявки с сайта (POST). */
function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.tryLock(10000);
  try {
    const d = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (d.website) return out_({ ok: true });                       // ловушка для спам-ботов
    if (!clean_(d.name) && !clean_(d.phone)) return out_({ ok: false, error: 'empty' });

    const sheet = sheet_();
    sheet.appendRow([
      new Date(), 'новая', clean_(d.type), clean_(d.house), clean_(d.checkin), clean_(d.checkout),
      num_(d.nights), clean_(d.guests), num_(d.total), num_(d.prepay),
      clean_(d.name), clean_(d.phone), clean_(d.comment || d.dates), clean_(d.certificate || d.occasion), clean_(d.source)
    ]);
    notify_(d);
    return out_({ ok: true });
  } catch (err) {
    console.error(err);
    return out_({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

/** Проверка, что веб-приложение отвечает (открыть адрес в браузере). */
function doGet() {
  return out_({ ok: true, service: 'Sylva Lodge leads' });
}

/** Один раз: создаёт лист «Заявки» с заголовками и выпадающим списком статусов. */
function setup() {
  const sheet = sheet_();
  sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]).setFontWeight('bold').setBackground('#f3e6d8');
  sheet.setFrozenRows(1);
  const rule = SpreadsheetApp.newDataValidation().requireValueInList(STATUSES, true).setAllowInvalid(false).build();
  sheet.getRange(2, 2, 1000, 1).setDataValidation(rule);
  sheet.getRange('A:A').setNumberFormat('dd.mm.yyyy hh:mm');
  sheet.autoResizeColumns(1, HEADERS.length);
  Logger.log('Лист «%s» готов.', SHEET_NAME);
}

/** Тест: отправляет пробное сообщение в Telegram (в личку владелице или в группу — смотря какой CHAT_ID). */
function testTelegram() {
  notify_({ type: 'Тест', house: 'Grand', checkin: '2026-12-20', checkout: '2026-12-22', nights: 2, guests: 2,
            total: 19000, name: 'Проверка', phone: '+7 900 000-00-00', comment: 'Если вы это видите — всё работает 🙂' });
  Logger.log('Отправлено. Проверьте группу в Telegram.');
}

/** Помощник: показывает id чатов, где бот получал сообщения (чтобы узнать CHAT_ID группы). */
function findChatId() {
  const token = prop_('BOT_TOKEN');
  const res = JSON.parse(UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/getUpdates').getContentText());
  const chats = {};
  (res.result || []).forEach(u => {
    const m = u.message || u.my_chat_member || u.channel_post;
    if (m && m.chat) chats[m.chat.id] = (m.chat.title || m.chat.first_name || '') + ' (' + m.chat.type + ')';
  });
  if (!Object.keys(chats).length) Logger.log('Пусто. Нажмите «Запустить» у бота (или напишите в группе с ботом) и запустите снова.');
  Object.keys(chats).forEach(id => Logger.log('CHAT_ID = %s  →  %s', id, chats[id]));
}

// ----- служебное -----

function notify_(d) {
  const token = prop_('BOT_TOKEN'), chatId = prop_('CHAT_ID');
  if (!token || !chatId) { console.warn('BOT_TOKEN или CHAT_ID не заданы — уведомление не отправлено'); return; }
  const rub = n => n ? Number(n).toLocaleString('ru-RU') + ' ₽' : '';
  const date = s => { if (!s) return ''; const p = String(s).split('-'); return p.length === 3 ? p[2] + '.' + p[1] : s; };
  const icon = { 'Бронь': '🏡', 'Сертификат': '🎁', 'Праздник': '🎉' }[d.type] || '📩';
  const lines = [
    icon + ' <b>' + esc_(d.type || 'Заявка') + (d.house ? ': ' + esc_(d.house) : '') + '</b>',
    d.checkin ? '📅 ' + date(d.checkin) + ' — ' + date(d.checkout) + (d.nights ? ' (' + d.nights + ' ноч.)' : '') : '',
    d.guests ? '👥 Гостей: ' + esc_(d.guests) : '',
    d.total ? '💰 ' + rub(d.total) + (d.prepay ? ', предоплата ' + rub(d.prepay) : '') : '',
    d.certificate ? '🎁 Номинал: ' + esc_(d.certificate) : '',
    d.occasion ? '🎉 Повод: ' + esc_(d.occasion) : '',
    d.dates ? '📅 Даты: ' + esc_(d.dates) : '',
    '',
    '👤 ' + esc_(d.name || '—'),
    '📞 ' + esc_(d.phone || '—'),
    d.comment ? '💬 ' + esc_(d.comment) : '',
  ].filter((l, i, a) => l !== '' || (i > 0 && a[i - 1] !== ''));
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    payload: JSON.stringify({
      chat_id: chatId, text: lines.join('\n'), parse_mode: 'HTML', disable_web_page_preview: true,
      reply_markup: { inline_keyboard: [[{ text: '📋 Открыть таблицу заявок', url: ss.getUrl() }]] }
    })
  });
}

function sheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  return ss.getSheetByName(SHEET_NAME) || ss.insertSheet(SHEET_NAME);
}
function prop_(k) { return PropertiesService.getScriptProperties().getProperty(k) || ''; }
function clean_(v) { return v === undefined || v === null ? '' : String(v).slice(0, 500).replace(/^[=+\-@]/, "'$&"); }
function num_(v) { const n = Number(v); return isFinite(n) && v !== '' && v !== undefined && v !== null ? n : ''; }
function esc_(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function out_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
