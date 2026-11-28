import { useState } from 'react';
import { Clock, Mail, Phone, Printer, Ruler, Truck } from 'lucide-react';
import { SUPPORT } from '../../components/Feedback';
import { CARD_ENVELOPES, CARD_PRICES, CERTIFICATES, CERT_ENVELOPES, FINISHES, SETUP_FEE, STOCK_CARDS, usd, type Finish, type Thickness } from './printPrices';

/** Landing section: order printed PVC gift cards, certificates and envelopes. */
const T = {
  vi: {
    title: 'In thẻ gift card cho tiệm',
    sub: 'Thẻ nhựa PVC in logo và màu của tiệm. Dùng chung với app: quét mã vạch là bán được ngay.',
    facts: ['In xong trong 2–3 ngày làm việc', 'Cộng thêm thời gian ship', 'Cỡ thẻ tín dụng 3.375″ × 2.125″'],
    thickness: 'Độ dày',
    thicknessHint: 'Càng dày càng cứng, cầm chắc tay hơn.',
    finish: 'Kiểu thẻ',
    finishes: {
      plain: 'Nhựa trắng',
      foil: 'Ép kim',
      shimmer: 'Nhũ',
      shimmerFoil: 'Nhũ + ép kim',
      holo: 'Nhũ chuyển sắc',
      holoFoil: 'Chuyển sắc + ép kim',
    } as Record<Finish, string>,
    only30: 'Loại 30 mil chỉ có nhựa trắng.',
    qty: 'Số lượng',
    price: 'Giá',
    each: 'Mỗi thẻ',
    cards: 'thẻ',
    setup: `Phí setup ${usd(SETUP_FEE, 0)} cho mỗi mẫu thiết kế, tính một lần. Giá chưa gồm phí ship.`,
    order: 'Đặt in qua email',
    call: 'Gọi đặt in',
    priceTable: (th: string, f: string) => `Bảng giá thẻ ${th} mil, ${f}`,
    certTitle: 'Phiếu quà tặng (giấy)',
    certSub: 'Giấy mờ 8.5″ × 3.75″.',
    noStub: 'Không cùi',
    stub: 'Có cùi xé',
    stubNote: 'Cùi xé (3.5″ × 2.26″) tiệm giữ lại để ghi sổ. Loại có cùi từ 500 phiếu.',
    envTitle: 'Bao thư',
    envCard: 'Bao thư nhỏ cho thẻ (4″ × 3″)',
    envCert: 'Bao thư lớn cho phiếu (8.5″ × 3.75″), giá mỗi cái',
    envNames: {
      plainWhite: 'Trắng trơn',
      bow: 'In hình nơ',
      plainColor: 'Màu trơn',
      logoOne: 'In logo 1 mặt',
      logoBoth: 'In logo 2 mặt',
    },
    envNote: 'Tối thiểu 100 cái, đặt chung với thẻ hoặc phiếu.',
    stockTitle: 'Thẻ in sẵn mẫu',
    stockSub: 'Mẫu có sẵn, không in logo tiệm. Nhựa 30 mil. Không cần phí setup.',
    also: 'Chúng tôi cũng in danh thiếp, menu, tờ rơi, banner, decal dán kính và áo thun. Liên hệ để xem giá.',
    mailSubject: 'Đặt in gift card',
    mailBody: (th: string, f: string) =>
      `Xin chào,\n\nTiệm muốn đặt in gift card:\n- Độ dày: ${th} mil\n- Kiểu thẻ: ${f}\n- Số lượng: \n\nTên tiệm:\nĐịa chỉ giao hàng:\nSố điện thoại:\n`,
  },
  en: {
    title: 'Printed gift cards for your salon',
    sub: 'PVC plastic cards with your salon’s logo and colors. They work with the app: scan the barcode and sell.',
    facts: ['Printed in 2–3 business days', 'Plus shipping time', 'Credit card size 3.375″ × 2.125″'],
    thickness: 'Thickness',
    thicknessHint: 'Thicker cards feel stiffer and more solid.',
    finish: 'Finish',
    finishes: {
      plain: 'Plain white',
      foil: 'Raised foil',
      shimmer: 'Shimmer',
      shimmerFoil: 'Shimmer + foil',
      holo: 'Holographic',
      holoFoil: 'Holographic + foil',
    } as Record<Finish, string>,
    only30: '30 mil comes in plain white only.',
    qty: 'Quantity',
    price: 'Price',
    each: 'Per card',
    cards: 'cards',
    setup: `One-time ${usd(SETUP_FEE, 0)} setup fee per design. Prices do not include shipping.`,
    order: 'Order by email',
    call: 'Call to order',
    priceTable: (th: string, f: string) => `Prices for ${th} mil cards, ${f}`,
    certTitle: 'Gift certificates (paper)',
    certSub: 'Matte paper, 8.5″ × 3.75″.',
    noStub: 'No stub',
    stub: 'Tear-off stub',
    stubNote: 'The stub (3.5″ × 2.26″) stays with the salon for records. Stub version starts at 500.',
    envTitle: 'Envelopes',
    envCard: 'Small card envelope (4″ × 3″)',
    envCert: 'Large certificate envelope (8.5″ × 3.75″), each',
    envNames: {
      plainWhite: 'Plain white',
      bow: 'Printed bow',
      plainColor: 'Plain color',
      logoOne: 'Logo, one side',
      logoBoth: 'Logo, both sides',
    },
    envNote: 'Minimum 100, ordered together with cards or certificates.',
    stockTitle: 'Ready-design cards',
    stockSub: 'Stock design, no salon logo. 30 mil PVC. No setup fee.',
    also: 'We also print business cards, menus, flyers, banners, window decals and T-shirts. Contact us for prices.',
    mailSubject: 'Gift card printing order',
    mailBody: (th: string, f: string) =>
      `Hello,\n\nWe would like to order printed gift cards:\n- Thickness: ${th} mil\n- Finish: ${f}\n- Quantity: \n\nSalon name:\nShipping address:\nPhone:\n`,
  },
};

const THICKNESSES: Thickness[] = ['30', '35', '40'];

const pill = (on: boolean) =>
  `flex min-h-[44px] cursor-pointer items-center justify-center rounded-lg px-3 text-sm font-semibold ring-1 ring-inset has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-brand-600 ${
    on
      ? 'bg-zinc-900 text-white ring-zinc-900 dark:bg-white dark:text-zinc-900 dark:ring-white'
      : 'bg-white text-zinc-700 ring-zinc-300 hover:bg-zinc-50 dark:bg-zinc-900 dark:text-zinc-200 dark:ring-zinc-700 dark:hover:bg-zinc-800'
  }`;

const th = 'py-2 pr-3 text-left text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400';
const td = 'py-2 pr-3 tabular-nums';

export function PrintSection({ lang, btnPrimary, btnSecondary }: { lang: 'vi' | 'en'; btnPrimary: string; btnSecondary: string }) {
  const t = T[lang];
  const [thick, setThick] = useState<Thickness>('35');
  const [finish, setFinish] = useState<Finish>('plain');
  const available = FINISHES.filter((f) => CARD_PRICES[thick][f]);
  const current: Finish = available.includes(finish) ? finish : 'plain';
  const rows = CARD_PRICES[thick][current]!;
  const finishName = t.finishes[current];
  const mailto = `mailto:${SUPPORT.email}?subject=${encodeURIComponent(t.mailSubject)}&body=${encodeURIComponent(t.mailBody(thick, finishName))}`;
  const factIcons = [Clock, Truck, Ruler];

  return (
    <section id="print" aria-labelledby="print-title" className="scroll-mt-20">
      <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
        <div className="flex items-center gap-2 text-sm font-semibold text-brand-700 dark:text-brand-300">
          <Printer className="h-4 w-4" aria-hidden />
          {lang === 'vi' ? 'Dịch vụ in' : 'Printing'}
        </div>
        <h2 id="print-title" className="mt-2 max-w-2xl text-2xl font-semibold tracking-tight text-balance">
          {t.title}
        </h2>
        <p className="mt-2 max-w-2xl text-zinc-600 dark:text-zinc-300">{t.sub}</p>
        <ul className="mt-5 flex flex-wrap gap-x-6 gap-y-2 text-sm">
          {t.facts.map((f, i) => {
            const Icon = factIcons[i]!;
            return (
              <li key={f} className="inline-flex items-center gap-2 font-medium">
                <Icon className="h-4 w-4 text-zinc-500 dark:text-zinc-400" aria-hidden />
                {f}
              </li>
            );
          })}
        </ul>

        {/* Custom PVC cards: pick options, see the price list */}
        <div className="mt-8 grid gap-6 rounded-xl border border-zinc-200 p-5 sm:p-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] lg:gap-10 dark:border-zinc-800">
          <div className="min-w-0 space-y-6">
            <fieldset>
              <legend className="font-semibold">{t.thickness}</legend>
              <p className="mt-0.5 text-sm text-zinc-500 dark:text-zinc-400">{t.thicknessHint}</p>
              <div className="mt-3 grid grid-cols-3 gap-2">
                {THICKNESSES.map((x) => (
                  <label key={x} className={pill(thick === x)}>
                    <input type="radio" name="print-thickness" value={x} checked={thick === x} onChange={() => setThick(x)} className="sr-only" />
                    {x} mil
                  </label>
                ))}
              </div>
            </fieldset>
            <fieldset>
              <legend className="font-semibold">{t.finish}</legend>
              <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
                {available.map((f) => (
                  <label key={f} className={pill(current === f)}>
                    <input type="radio" name="print-finish" value={f} checked={current === f} onChange={() => setFinish(f)} className="sr-only" />
                    <span className="text-center">{t.finishes[f]}</span>
                  </label>
                ))}
              </div>
              {thick === '30' && <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">{t.only30}</p>}
            </fieldset>
            <p className="text-sm text-zinc-600 dark:text-zinc-300">{t.setup}</p>
            <div className="flex flex-wrap gap-3">
              <a href={mailto} className={btnPrimary}>
                <Mail className="h-4 w-4" aria-hidden /> {t.order}
              </a>
              <a href={`tel:+1${SUPPORT.phone}`} className={btnSecondary}>
                <Phone className="h-4 w-4" aria-hidden /> {t.call}
              </a>
            </div>
            <p className="text-sm text-zinc-500 dark:text-zinc-400">
              {SUPPORT.email} · <span className="tabular-nums">{SUPPORT.phoneDisplay}</span>
            </p>
          </div>

          <div className="min-w-0">
            <table className="w-full text-sm">
              <caption className="pb-2 text-left font-semibold">{t.priceTable(thick, finishName)}</caption>
              <thead className="border-b border-zinc-200 dark:border-zinc-800">
                <tr>
                  <th scope="col" className={th}>
                    {t.qty}
                  </th>
                  <th scope="col" className={`${th} text-right`}>
                    {t.price}
                  </th>
                  <th scope="col" className={`${th} pr-0 text-right`}>
                    {t.each}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800/70">
                {rows.map(([qty, price]) => (
                  <tr key={qty}>
                    <td className={td}>
                      {qty.toLocaleString('en-US')} <span className="text-zinc-500 dark:text-zinc-400">{t.cards}</span>
                    </td>
                    <td className={`${td} text-right font-semibold`}>{usd(price)}</td>
                    <td className={`${td} pr-0 text-right text-zinc-600 dark:text-zinc-300`}>{usd(price / qty)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Certificates, envelopes, stock cards */}
        <div className="mt-6 grid gap-6 lg:grid-cols-3">
          <div className="min-w-0 rounded-xl border border-zinc-200 p-5 dark:border-zinc-800">
            <h3 className="font-semibold">{t.certTitle}</h3>
            <p className="mt-0.5 text-sm text-zinc-500 dark:text-zinc-400">{t.certSub}</p>
            <table className="mt-3 w-full text-sm">
              <thead className="border-b border-zinc-200 dark:border-zinc-800">
                <tr>
                  <th scope="col" className={th}>
                    {t.qty}
                  </th>
                  <th scope="col" className={`${th} text-right`}>
                    {t.noStub}
                  </th>
                  <th scope="col" className={`${th} pr-0 text-right`}>
                    {t.stub}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800/70">
                {CERTIFICATES.map(([qty, a, b]) => (
                  <tr key={qty}>
                    <td className={td}>{qty.toLocaleString('en-US')}</td>
                    <td className={`${td} text-right`}>{usd(a)}</td>
                    <td className={`${td} pr-0 text-right`}>
                      {b === null ? (
                        <span className="text-zinc-400" aria-label="—">
                          —
                        </span>
                      ) : (
                        usd(b)
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">{t.stubNote}</p>
          </div>

          <div className="min-w-0 rounded-xl border border-zinc-200 p-5 dark:border-zinc-800">
            <h3 className="font-semibold">{t.envTitle}</h3>
            <p className="mt-0.5 text-sm text-zinc-500 dark:text-zinc-400">{t.envNote}</p>
            <table className="mt-3 w-full text-sm">
              <caption className="pb-1 text-left font-medium">{t.envCard}</caption>
              <thead className="sr-only">
                <tr>
                  <th scope="col">{t.qty}</th>
                  <th scope="col">{t.price}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800/70">
                {CARD_ENVELOPES.filter(([q]) => [100, 250, 500, 1000, 2500, 5000].includes(q)).map(([qty, price]) => (
                  <tr key={qty}>
                    <td className={td}>{qty.toLocaleString('en-US')}</td>
                    <td className={`${td} pr-0 text-right`}>{usd(price)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <table className="mt-4 w-full text-sm">
              <caption className="pb-1 text-left font-medium">{t.envCert}</caption>
              <thead className="sr-only">
                <tr>
                  <th scope="col">{t.envTitle}</th>
                  <th scope="col">{t.price}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800/70">
                {CERT_ENVELOPES.map(([k, each]) => (
                  <tr key={k}>
                    <td className={td}>{t.envNames[k]}</td>
                    <td className={`${td} pr-0 text-right`}>{usd(each)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="min-w-0 rounded-xl border border-zinc-200 p-5 dark:border-zinc-800">
            <h3 className="font-semibold">{t.stockTitle}</h3>
            <p className="mt-0.5 text-sm text-zinc-500 dark:text-zinc-400">{t.stockSub}</p>
            <table className="mt-3 w-full text-sm">
              <thead className="border-b border-zinc-200 dark:border-zinc-800">
                <tr>
                  <th scope="col" className={th}>
                    {t.qty}
                  </th>
                  <th scope="col" className={`${th} text-right`}>
                    {t.price}
                  </th>
                  <th scope="col" className={`${th} pr-0 text-right`}>
                    {t.each}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800/70">
                {STOCK_CARDS.map(([qty, price]) => (
                  <tr key={qty}>
                    <td className={td}>{qty}</td>
                    <td className={`${td} text-right`}>{usd(price)}</td>
                    <td className={`${td} pr-0 text-right text-zinc-600 dark:text-zinc-300`}>{usd(price / qty)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <p className="mt-6 max-w-3xl text-sm text-zinc-600 dark:text-zinc-300">{t.also}</p>
      </div>
    </section>
  );
}
