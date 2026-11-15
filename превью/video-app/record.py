"""Запись ролика о приложении онлайн-брони: приложение на «телефоне» → чат с ботом → таблица.

Запуск: python record.py <папка_для_кадров>
Открывает опубликованное приложение (GitHub Pages). Запросы к серверу (Google) подменяются:
показываем пример занятых дат, удержание и оплату — в настоящую таблицу ничего не уходит.
Пишет кадры 780×1688, list.txt для ffmpeg и markers.json (время каждого шага).
"""
import sys, os, json, base64, asyncio, pathlib, time, datetime, urllib.parse
from playwright.async_api import async_playwright

OUT = sys.argv[1] if len(sys.argv) > 1 else 'frames'
URL = 'https://dmitrijprivalihin701-eng.github.io/sylva-lodge/app/?v=video'
HERE = pathlib.Path(__file__).resolve().parent
today = datetime.date.today()
D = lambda n: (today + datetime.timedelta(days=n)).isoformat()
CHECKIN, CHECKOUT = 19, 21                 # выбираемые даты (через 19 и 21 день)
BUSY = [{'house': 'Grand', 'checkin': D(15), 'checkout': D(18), 'status': 'booked'},
        {'house': 'Grand', 'checkin': D(23), 'checkout': D(24), 'status': 'hold'},
        {'house': 'Grand', 'checkin': D(27), 'checkout': D(29), 'status': 'booked'}]

INIT = r"""
window.__tap=(x,y)=>{const d=document.createElement('div');d.className='__tap';d.style.left=x+'px';d.style.top=y+'px';document.documentElement.appendChild(d);setTimeout(()=>d.remove(),750)};
window.__scrollTo=(y,ms)=>new Promise(res=>{const s=scrollY,dist=y-s,t0=performance.now();const e=t=>t<.5?2*t*t:1-Math.pow(-2*t+2,2)/2;function f(n){const p=Math.min(1,(n-t0)/ms);scrollTo(0,s+dist*e(p));if(p<1)requestAnimationFrame(f);else res()}requestAnimationFrame(f)});
document.addEventListener('DOMContentLoaded',()=>{const s=document.createElement('style');s.textContent='html{scroll-behavior:auto!important}.__tap{position:fixed;z-index:2147483647;width:46px;height:46px;margin:-23px 0 0 -23px;border-radius:50%;background:rgba(255,255,255,.32);border:2px solid rgba(255,255,255,.85);box-shadow:0 0 18px rgba(255,255,255,.35);pointer-events:none;animation:__t .7s ease-out forwards}@keyframes __t{0%{transform:scale(.45);opacity:1}100%{transform:scale(1.35);opacity:0}}';document.head.appendChild(s)});
"""


async def main():
    os.makedirs(OUT, exist_ok=True)
    frames, markers, lead = [], [], {}
    async with async_playwright() as p:
        browser = await p.chromium.launch(channel='msedge', headless=True)
        ctx = await browser.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2,
                                        is_mobile=True, has_touch=True, locale='ru-RU', service_workers='block')
        await ctx.add_init_script(INIT)
        page = await ctx.new_page()

        async def fake_server(route):
            req = route.request
            if req.method == 'GET':
                return await route.fulfill(status=200, content_type='application/json', body=json.dumps({'ok': True, 'busy': BUSY}))
            body = json.loads(req.post_data or '{}')
            if body.get('action') == 'hold':
                lead.update(body)
                lead['id'] = 'SL-' + today.strftime('%y%m%d') + '-417'
                lead['holdUntil'] = (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(days=3)).isoformat()
                return await route.fulfill(status=200, content_type='application/json', body=json.dumps({'ok': True, 'id': lead['id'], 'holdUntil': lead['holdUntil']}))
            return await route.fulfill(status=200, content_type='application/json', body='{"ok":true}')
        await page.route('**/script.google.com/**', fake_server)

        cdp = await ctx.new_cdp_session(page)
        async def on_frame(params):
            name = f'f{len(frames):05d}.jpg'
            with open(os.path.join(OUT, name), 'wb') as fh:
                fh.write(base64.b64decode(params['data']))
            frames.append((name, params['metadata']['timestamp']))
            try:
                await cdp.send('Page.screencastFrameAck', {'sessionId': params['sessionId']})
            except Exception:
                pass
        cdp.on('Page.screencastFrame', lambda prm: asyncio.ensure_future(on_frame(prm)))
        await cdp.send('Page.startScreencast', {'format': 'jpeg', 'quality': 92, 'maxWidth': 780, 'maxHeight': 1688, 'everyNthFrame': 1})

        w = page.wait_for_timeout
        def mark(key): markers.append((key, time.time()))
        async def center(loc):
            b = await loc.bounding_box(); return b['x'] + b['width'] / 2, b['y'] + b['height'] / 2
        async def tap_loc(loc, pause=160):
            x, y = await center(loc)
            await page.evaluate('([x,y])=>__tap(x,y)', [x, y]); await w(pause); await page.touchscreen.tap(x, y)
        async def tap(sel): await tap_loc(page.locator(sel).first)
        async def scroll_to(sel, offset=110, ms=1200):
            y = await page.evaluate('([s,o])=>{const e=document.querySelector(s);return e.getBoundingClientRect().top+scrollY-o}', [sel, offset])
            await page.evaluate('([y,ms])=>__scrollTo(y,ms)', [y, ms])
        async def scroll_by(dy, ms=1000): await page.evaluate('([dy,ms])=>__scrollTo(scrollY+dy,ms)', [dy, ms])
        async def pick(day):
            for _ in range(3):
                loc = page.locator(f'button[data-d="{day}"]')
                if await loc.count(): return await tap_loc(loc)
                await tap('#calNext'); await w(500)

        await page.goto(URL); await w(1600)

        # 1. Домик
        mark('c1'); await w(900)
        await scroll_by(300, 1100); await w(500)
        await tap('.house >> nth=1'); await w(1200)              # приложение само прокрутит к датам

        # 2. Даты и гости
        mark('c2'); await w(900)
        await pick(D(CHECKIN)); await w(700); await pick(D(CHECKOUT)); await w(900)
        await scroll_to('.guests', 300, 700); await w(400)
        await tap('#gPlus'); await w(450); await tap('#gPlus'); await w(900)

        # 3. Допы
        await scroll_to('#s3', 100, 1000); mark('c3'); await w(700)
        for x in ('banya', 'chan', 'breakfast'):
            await tap(f'.extra[data-x="{x}"]'); await w(650)
        await w(500)

        # 4. Данные, итог, предоплата
        await scroll_to('#s4', 100, 1100); mark('c4'); await w(500)
        await tap('#fName'); await page.locator('#fName').type('Анна', delay=120); await w(200)
        await tap('#fPhone'); await page.locator('#fPhone').type('+7 900 123-45-67', delay=50); await w(300)
        await page.evaluate('document.activeElement && document.activeElement.blur()')
        await scroll_to('#bill', 120, 1000); await w(1500)
        await scroll_to('.prepay', 150, 900); await w(1800)
        await tap('#fAgree'); await w(800)

        # 5. Оплата
        await tap('#barBtn'); mark('c5'); await w(1500)
        await tap('.method[data-method="sbp"]'); await w(700)
        await tap('.method[data-method="card"]'); await w(600)
        await tap('#payBtn'); await w(2200)

        # 6. Бронь подтверждена
        mark('c6'); await w(2800)

        # 7. Уведомления владелице (макет с данными этой брони)
        data = urllib.parse.quote(json.dumps(lead, ensure_ascii=False))
        await page.goto((HERE / 'chat.html').as_uri() + '#' + data); mark('c7'); await w(7000)

        # 8. Таблица
        await page.goto((HERE / 'sheet.html').as_uri() + '#' + data); mark('c8'); await w(4000)

        await cdp.send('Page.stopScreencast'); await w(300)
        await ctx.close(); await browser.close()

    frames.sort(key=lambda f: f[1]); t0 = frames[0][1]
    end = max(frames[-1][1], markers[-1][1] + 3.8) - t0          # последний кадр держим до конца сцены с таблицей
    with open(os.path.join(OUT, 'list.txt'), 'w', encoding='utf-8') as fh:
        for i, (name, ts) in enumerate(frames):
            dur = (frames[i + 1][1] - ts) if i + 1 < len(frames) else max(1.0, end - (ts - t0))
            fh.write(f"file '{name}'\nduration {max(dur, 0.001):.4f}\n")
        fh.write(f"file '{frames[-1][0]}'\n")
    with open(os.path.join(OUT, 'markers.json'), 'w', encoding='utf-8') as fh:
        json.dump({'t0': t0, 'end': end, 'markers': {k: ts - t0 for k, ts in markers}, 'lead': lead}, fh, ensure_ascii=False, indent=1)
    print(len(frames), 'frames', round(end, 1), 's', json.dumps({k: round(ts - t0, 1) for k, ts in markers}), lead.get('house'), lead.get('total'), lead.get('prepay'))


if __name__ == '__main__':
    asyncio.run(main())
