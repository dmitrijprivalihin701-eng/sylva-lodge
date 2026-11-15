"""Запись видео-демо сайта на «телефоне» (Playwright + установленный Microsoft Edge).

Запуск: сайт должен работать на http://localhost:8765 (python -m http.server 8765 --directory site)
    python record.py <папка_для_кадров>
Пишет кадры экрана 780×1688 (телефон 390×844 при плотности 2) через CDP screencast
и файл list.txt для ffmpeg (concat с реальной длительностью каждого кадра).
"""
import sys, os, base64, asyncio
from playwright.async_api import async_playwright

OUT = sys.argv[1] if len(sys.argv) > 1 else 'frames'
URL = 'http://localhost:8765/?v=video'

# Кружок «нажатия пальцем», плавная прокрутка и скрытие плашки cookies — для красивого ролика
INIT = r"""
try{localStorage.setItem('sylvaCookie','1')}catch(e){}
window.__tap=(x,y)=>{const d=document.createElement('div');d.className='__tap';d.style.left=x+'px';d.style.top=y+'px';document.documentElement.appendChild(d);setTimeout(()=>d.remove(),750)};
window.__scrollTo=(y,ms)=>new Promise(res=>{const s=scrollY,dist=y-s,t0=performance.now();const e=t=>t<.5?2*t*t:1-Math.pow(-2*t+2,2)/2;function f(n){const p=Math.min(1,(n-t0)/ms);scrollTo(0,s+dist*e(p));if(p<1)requestAnimationFrame(f);else res()}requestAnimationFrame(f)});
document.addEventListener('DOMContentLoaded',()=>{const s=document.createElement('style');s.textContent='.__tap{position:fixed;z-index:2147483647;width:46px;height:46px;margin:-23px 0 0 -23px;border-radius:50%;background:rgba(255,255,255,.32);border:2px solid rgba(255,255,255,.85);box-shadow:0 0 18px rgba(255,255,255,.35);pointer-events:none;animation:__t .7s ease-out forwards}@keyframes __t{0%{transform:scale(.45);opacity:1}100%{transform:scale(1.35);opacity:0}}';document.head.appendChild(s)});
"""


async def main():
    os.makedirs(OUT, exist_ok=True)
    frames = []  # (имя файла, время)
    async with async_playwright() as p:
        browser = await p.chromium.launch(channel='msedge', headless=True)
        ctx = await browser.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2,
                                        is_mobile=True, has_touch=True, locale='ru-RU')
        await ctx.add_init_script(INIT)
        page = await ctx.new_page()
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

        async def center(loc):
            b = await loc.bounding_box()
            return b['x'] + b['width'] / 2, b['y'] + b['height'] / 2

        async def tap_xy(x, y, pause=150):
            await page.evaluate('([x,y])=>__tap(x,y)', [x, y])
            await w(pause)
            await page.touchscreen.tap(x, y)

        async def tap(selector, nth=0, pause=150):
            x, y = await center(page.locator(selector).nth(nth))
            await tap_xy(x, y, pause)

        async def scroll_to(selector, offset=90, ms=1400):
            y = await page.evaluate('([s,o])=>{const e=document.querySelector(s);return e.getBoundingClientRect().top+scrollY-o}', [selector, offset])
            await page.evaluate('([y,ms])=>__scrollTo(y,ms)', [y, ms])

        async def scroll_by(dy, ms=1200):
            await page.evaluate('([dy,ms])=>__scrollTo(scrollY+dy,ms)', [dy, ms])

        await page.goto(URL)
        await w(4300)            # прелоадер «Загружаем ваш уют»
        await w(2200)            # анимация первого экрана

        # 1. Трапеция: Лес / Баня / Чан и просмотр фото
        await scroll_to('#intro', 70, 1800); await w(700)
        for topic in ('forest', 'sauna', 'tub'):
            await tap(f'.toc a[data-topic="{topic}"]'); await w(1300)
        await scroll_to('#tris', 160, 700); await w(400)
        await tap('#trap'); await w(1500)
        await tap('.lb-next'); await w(1300)
        await tap('.lb-close'); await w(700)

        # 2. Поиск свободных дат → домики с ценой → бронь
        await scroll_to('#booking', 90, 1300); await w(800)
        await tap('#bk button[type="submit"]'); await w(2200)
        await scroll_by(260, 900); await w(600)
        x, y = await center(page.locator('button[data-book]:not([disabled])').first)
        if y > 760:
            await scroll_by(y - 560, 800); await w(500)
        await tap('button[data-book]:not([disabled])'); await w(1100)
        await page.locator('#mForm input[name="name"]').type('Анна', delay=130); await w(250)
        await page.locator('#mForm input[name="phone"]').type('+7 900 123-45-67', delay=55); await w(500)
        await tap('#mForm button[type="submit"]'); await w(1800)
        await tap('#mClose'); await w(700)

        # 3. Прайс доп. услуг и карусель «Для кого»
        await scroll_to('.extras', 80, 1500); await w(1200)
        await scroll_to('#car', 150, 1500); await w(1600)
        await tap('#carNext'); await w(1400)
        side = await page.evaluate('()=>{const e=[...document.querySelectorAll(".car-item")].find(e=>e._off===1);const r=e.getBoundingClientRect();return [r.left+Math.min(r.width/2,40),r.top+r.height/2]}')
        await tap_xy(side[0], side[1]); await w(1500)
        await tap('.car-tab[data-i="4"]'); await w(1800)

        # 4. Отзывы, сертификаты, вопросы
        await scroll_to('#reviews', 80, 1500); await w(1300)
        await scroll_to('.cert', 120, 1500); await w(600)
        await tap('#certChips .chip[data-sum="15 000 ₽"]'); await w(1000)
        await scroll_to('#faq', 70, 1600); await w(500)
        await tap('#faq details:nth-of-type(2) summary'); await w(1500)

        # 5. Мессенджеры и контакты с картой
        await tap('#chatBtn'); await w(1600)
        await tap('#chatBtn'); await w(600)
        await scroll_to('#contacts', 60, 1800); await w(1300)
        await scroll_to('#map', 90, 1400); await w(2200)

        await cdp.send('Page.stopScreencast')
        await w(300)
        await ctx.close(); await browser.close()

    # список для ffmpeg: каждый кадр держится до следующего
    frames.sort(key=lambda f: f[1])
    with open(os.path.join(OUT, 'list.txt'), 'w', encoding='utf-8') as fh:
        for i, (name, ts) in enumerate(frames):
            dur = (frames[i + 1][1] - ts) if i + 1 < len(frames) else 1.0
            fh.write(f"file '{name}'\nduration {max(dur, 0.001):.4f}\n")
        fh.write(f"file '{frames[-1][0]}'\n")
    print(len(frames), 'frames,', round(frames[-1][1] - frames[0][1], 1), 's')


if __name__ == '__main__':
    asyncio.run(main())
