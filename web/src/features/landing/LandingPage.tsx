import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowRight,
  Check,
  CreditCard,
  History,
  Import,
  LayoutDashboard,
  Mail,
  Minus,
  Phone,
  ScanLine,
  ShieldCheck,
  Smartphone,
  Users,
  Wallet,
} from 'lucide-react';
import { Logo } from '../../components/Logo';
import { SUPPORT } from '../../components/Feedback';
import { PrintSection } from './PrintSection';

/**
 * Public home (marketing route: Home / landing).
 * Nav → hero → fit check → features → how it works → plans → printed cards → FAQ → CTA → footer.
 * Bilingual: Vietnamese / English, following the visitor's phone language.
 */
type Lang = 'vi' | 'en';

const T = {
  vi: {
    signIn: 'Đăng nhập',
    printNav: 'In thẻ',
    signUp: 'Đăng ký miễn phí',
    heroTitle: 'Quản lý gift card cho tiệm nail và tiệm làm đẹp',
    heroSub: 'Bán thẻ, trừ tiền và xem số dư ngay trên điện thoại hoặc iPad. Không cần cài app, không cần mua máy POS mới.',
    heroNote: 'Miễn phí đến 50 gift card. Đăng ký trong vài phút.',
    fitTitle: 'Có phù hợp với tiệm của bạn?',
    fitYes: 'Phù hợp nếu tiệm bạn',
    fitYesList: [
      'Bán gift card cho khách (tiệm nail, tóc, spa, massage…)',
      'Đang ghi gift card bằng sổ tay, giấy hoặc Excel',
      'Có nhiều thợ dùng chung máy ở quầy',
      'Muốn khách tự xem số dư mà không cần hỏi thợ',
    ],
    fitNo: 'Có thể chưa phù hợp nếu bạn cần',
    fitNoList: [
      'Bán gift card online và nhận thanh toán thẻ trên web',
      'Gửi gift card qua email hoặc tin nhắn ngay bây giờ',
      'Giao diện app bằng tiếng Việt (app hiện dùng tiếng Anh, chữ to, dễ bấm)',
    ],
    featuresTitle: 'Mọi thứ tiệm cần để quản lý gift card',
    features: [
      ['Bán thẻ trong vài giây', 'Chọn $25, $50, $100 hoặc tự bấm số. Quét thẻ có sẵn hoặc để máy tạo số. In biên nhận có mã vạch.'],
      ['Trừ tiền và nạp thêm', 'Quét hoặc gõ số thẻ, trừ đúng số tiền. Số dư cập nhật ngay trên mọi máy.'],
      ['Khách tự xem số dư', 'Mỗi tiệm có trang kiểm tra số dư riêng. Khách nhập số thẻ để xem còn bao nhiêu.'],
      ['Mã PIN cho từng thợ', 'Chủ tiệm, quản lý, nhân viên, mỗi người một quyền. Hoàn tiền và huỷ thẻ cần quản lý duyệt.'],
      ['Lịch sử không sửa được', 'Mỗi giao dịch ghi lại ai làm, lúc nào, số dư trước và sau.'],
      ['Con số chủ tiệm cần', 'Tổng số dư khách còn giữ, thẻ bán hôm nay, thẻ sắp hết hạn.'],
      ['Chạy trên mọi máy', 'Điện thoại, iPad, máy tính. Dùng được máy quét mã vạch và máy in biên nhận nếu tiệm có.'],
      ['Nhập thẻ cũ', 'Chuyển danh sách gift card cũ vào từ file CSV, có bước xem trước.'],
    ],
    stepsTitle: 'Bắt đầu trong 3 bước',
    steps: [
      ['Đăng ký', 'Điền tên tiệm, tên đăng nhập và mật khẩu. Tiệm nhận mã CID riêng.'],
      ['Thêm thợ', 'Vào Settings → Security để tạo mã PIN cho từng người.'],
      ['Bán thẻ', 'Mở trên điện thoại hoặc iPad ở quầy và bắt đầu bán.'],
    ],
    plansTitle: 'Gói sử dụng',
    plansSub: 'Bắt đầu miễn phí. Khi tiệm cần nhiều thẻ hơn, liên hệ để nâng gói.',
    plans: [
      ['Free', 'Miễn phí', '50 gift card'],
      ['Extra', 'Liên hệ', '1.000 gift card'],
      ['Premier', 'Liên hệ', '10.000 gift card'],
    ],
    plansAll: 'Tất cả gói đều có đầy đủ tính năng.',
    contactUs: 'Liên hệ',
    faqTitle: 'Câu hỏi thường gặp',
    faq: [
      ['Có thật sự miễn phí không?', 'Có. Gói Free dùng đầy đủ tính năng, tối đa 50 gift card. Cần nhiều hơn thì liên hệ để nâng lên gói Extra hoặc Premier.'],
      ['Có cần cài app không?', 'Không. Mở giftcards.unijv.com trên trình duyệt của điện thoại, iPad hoặc máy tính là dùng được.'],
      ['Dữ liệu tiệm tôi có riêng tư không?', 'Có. Dữ liệu mỗi tiệm được tách riêng. Chỉ chủ tiệm và thợ của tiệm đó mới xem được.'],
      ['Khách làm mất thẻ thì sao?', 'Tìm thẻ theo tên hoặc số điện thoại khách, bấm Replace. Số dư chuyển sang thẻ mới, thẻ cũ bị khoá.'],
      ['In thẻ nhựa mất bao lâu?', 'In xong trong 2–3 ngày làm việc, cộng thêm thời gian ship. Gửi logo hoặc mẫu thiết kế qua email để bắt đầu.'],
      ['Đến giới hạn 50 thẻ thì sao?', 'Thẻ đã bán vẫn dùng bình thường. Chỉ cần liên hệ để nâng gói khi muốn bán thêm thẻ mới.'],
    ],
    ctaTitle: 'Thử ngay cho tiệm của bạn',
    ctaSub: 'Miễn phí đến 50 gift card. Không cần thẻ tín dụng.',
    questions: 'Có câu hỏi? Gọi hoặc email cho chúng tôi:',
    hotline: 'Hotline',
    shotAlt: 'Màn hình danh sách gift card của Gift Card POS',
    phoneAlt: 'Gift Card POS trên điện thoại',
  },
  en: {
    signIn: 'Sign in',
    printNav: 'Printed cards',
    signUp: 'Sign up free',
    heroTitle: 'Gift card management for nail and beauty salons',
    heroSub: 'Sell cards, redeem and check balances on a phone or iPad. No app to install, no new POS machine to buy.',
    heroNote: 'Free for up to 50 gift cards. Sign up in a few minutes.',
    fitTitle: 'Is it right for your salon?',
    fitYes: 'A good fit if your salon',
    fitYesList: [
      'Sells gift cards (nails, hair, spa, massage…)',
      'Tracks gift cards in a notebook, on paper or in Excel',
      'Has several staff sharing the front-desk device',
      'Wants customers to check their own balance',
    ],
    fitNo: 'Maybe not yet if you need',
    fitNoList: ['To sell gift cards online and take card payments on the web', 'To deliver gift cards by email or text right now'],
    featuresTitle: 'Everything a salon needs to run gift cards',
    features: [
      ['Sell a card in seconds', 'Pick $25, $50, $100 or type an amount. Scan a card or get a number made for you. Print a receipt with a barcode.'],
      ['Redeem and reload', 'Scan or type the card number and take the exact amount. The balance updates on every device.'],
      ['Customers check their balance', 'Each salon gets its own balance page. Customers enter their card number to see what is left.'],
      ['A PIN for every staff member', 'Owner, manager and staff each get their own access. Refunds and voids need a manager.'],
      ['History nobody can edit', 'Every transaction records who did it, when, and the balance before and after.'],
      ['The numbers owners need', 'Total balance customers still hold, cards sold today, cards about to expire.'],
      ['Works on any device', 'Phone, iPad or computer. Uses your barcode scanner and receipt printer if you have them.'],
      ['Bring your old cards', 'Import your existing gift cards from a CSV file, with a preview first.'],
    ],
    stepsTitle: 'Start in 3 steps',
    steps: [
      ['Sign up', 'Enter your salon name, a username and a password. Your salon gets its own CID.'],
      ['Add staff', 'Go to Settings → Security and create a PIN for each person.'],
      ['Sell cards', 'Open it on the front-desk phone or iPad and start selling.'],
    ],
    plansTitle: 'Plans',
    plansSub: 'Start free. When your salon needs more cards, contact us to upgrade.',
    plans: [
      ['Free', '$0', '50 gift cards'],
      ['Extra', 'Contact us', '1,000 gift cards'],
      ['Premier', 'Contact us', '10,000 gift cards'],
    ],
    plansAll: 'Every plan includes every feature.',
    contactUs: 'Contact us',
    faqTitle: 'Questions',
    faq: [
      ['Is it really free?', 'Yes. The Free plan has every feature, for up to 50 gift cards. Need more? Contact us about Extra or Premier.'],
      ['Do I need to install an app?', 'No. Open giftcards.unijv.com in the browser on a phone, iPad or computer.'],
      ['Is my salon’s data private?', 'Yes. Each salon’s data is kept separate. Only that salon’s owner and staff can see it.'],
      [
        'What if a customer loses their card?',
        'Find the card by the customer’s name or phone and tap Replace. The balance moves to a new card and the old one is blocked.',
      ],
      ['How long does card printing take?', 'Cards are printed in 2–3 business days, plus shipping. Email us your logo or design to start.'],
      ['What happens at 50 cards?', 'Cards you already sold keep working. Contact us to upgrade when you want to sell more.'],
    ],
    ctaTitle: 'Try it in your salon',
    ctaSub: 'Free for up to 50 gift cards. No credit card needed.',
    questions: 'Questions? Call or email us:',
    hotline: 'Hotline',
    shotAlt: 'The Gift Card POS gift card list',
    phoneAlt: 'Gift Card POS on a phone',
  },
} as const;

const FEATURE_ICONS = [CreditCard, Wallet, ScanLine, Users, History, LayoutDashboard, Smartphone, Import];

function initialLang(): Lang {
  try {
    const saved = localStorage.getItem('gc.lang');
    if (saved === 'vi' || saved === 'en') return saved;
  } catch {
    /* private mode */
  }
  const langs = navigator.languages?.length ? navigator.languages : [navigator.language];
  return langs.some((l) => l?.toLowerCase().startsWith('vi')) ? 'vi' : 'en';
}

const btnPrimary =
  'inline-flex min-h-[48px] items-center justify-center gap-2 rounded-lg bg-zinc-900 px-5 font-semibold text-white hover:bg-zinc-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200';
const btnSecondary =
  'inline-flex min-h-[48px] items-center justify-center gap-2 rounded-lg bg-white px-5 font-semibold text-zinc-900 ring-1 ring-inset ring-zinc-300 hover:bg-zinc-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 dark:bg-zinc-900 dark:text-white dark:ring-zinc-700 dark:hover:bg-zinc-800';

export function LandingPage() {
  const [lang, setLang] = useState<Lang>(initialLang);
  const t = T[lang];
  useEffect(() => {
    document.documentElement.lang = lang;
    try {
      localStorage.setItem('gc.lang', lang);
    } catch {
      /* private mode */
    }
    return () => {
      document.documentElement.lang = 'en';
    };
  }, [lang]);

  return (
    <div className="min-h-screen bg-white text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
      {/* Nav */}
      <header className="sticky top-0 z-20 border-b border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
        <nav aria-label="Main" className="mx-auto flex max-w-6xl items-center gap-2 px-4 py-3 sm:gap-3 sm:px-6">
          <Link to="/welcome" aria-label="Gift Card POS" className="flex min-h-[44px] items-center gap-2 font-semibold">
            <Logo size="sm" />
            <span className="hidden sm:inline">Gift Card POS</span>
          </Link>
          <div className="ml-auto flex items-center gap-1 sm:gap-2">
            <div role="group" aria-label="Language / Ngôn ngữ" className="flex rounded-lg ring-1 ring-inset ring-zinc-300 dark:ring-zinc-700">
              {(['vi', 'en'] as const).map((l) => (
                <button
                  key={l}
                  type="button"
                  aria-pressed={lang === l}
                  onClick={() => setLang(l)}
                  className={`min-h-[44px] min-w-[44px] rounded-lg px-2 text-sm font-semibold ${lang === l ? 'bg-zinc-900 text-white dark:bg-white dark:text-zinc-900' : 'text-zinc-600 hover:text-zinc-900 dark:text-zinc-300 dark:hover:text-white'}`}
                >
                  {l === 'vi' ? 'VI' : 'EN'}
                </button>
              ))}
            </div>
            <a
              href="#print"
              className="hidden min-h-[44px] items-center rounded-lg px-3 text-sm font-semibold text-zinc-700 hover:bg-zinc-100 md:inline-flex dark:text-zinc-200 dark:hover:bg-zinc-800"
            >
              {t.printNav}
            </a>
            <Link
              to="/login"
              className="inline-flex min-h-[44px] items-center rounded-lg px-3 text-sm font-semibold text-zinc-700 hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-800"
            >
              {t.signIn}
            </Link>
            <Link to="/signup" className={`${btnPrimary} hidden min-h-[44px] px-4 text-sm sm:inline-flex`}>
              {t.signUp}
            </Link>
          </div>
        </nav>
      </header>

      <main>
        {/* Hero */}
        <section className="border-b border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900/40">
          <div className="mx-auto grid max-w-6xl items-center gap-10 px-4 py-12 sm:px-6 md:py-16 lg:grid-cols-[1.05fr_1fr]">
            <div className="min-w-0">
              <h1 className="text-3xl font-semibold leading-tight tracking-tight text-balance sm:text-4xl lg:text-5xl">{t.heroTitle}</h1>
              <p className="mt-4 max-w-xl text-lg text-zinc-600 dark:text-zinc-300">{t.heroSub}</p>
              <div className="mt-7 flex flex-wrap gap-3">
                <Link to="/signup" className={btnPrimary}>
                  {t.signUp} <ArrowRight className="h-4 w-4" aria-hidden />
                </Link>
                <Link to="/login" className={btnSecondary}>
                  {t.signIn}
                </Link>
              </div>
              <p className="mt-4 text-sm text-zinc-500 dark:text-zinc-400">{t.heroNote}</p>
            </div>
            <div className="relative min-w-0">
              <img
                src="/landing/app-cards.webp"
                alt={t.shotAlt}
                width={1280}
                height={600}
                className="w-full rounded-xl border border-zinc-200 shadow-sm dark:border-zinc-800"
              />
              <img
                src="/landing/app-phone.webp"
                alt={t.phoneAlt}
                width={390}
                height={780}
                loading="lazy"
                className="absolute -bottom-6 right-3 hidden w-[28%] rounded-xl border border-zinc-200 shadow-md dark:border-zinc-800 sm:block"
              />
            </div>
          </div>
        </section>

        {/* Fit check */}
        <section aria-labelledby="fit" className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
          <h2 id="fit" className="text-2xl font-semibold tracking-tight">
            {t.fitTitle}
          </h2>
          <div className="mt-6 grid gap-4 md:grid-cols-2">
            <div className="rounded-xl border border-zinc-200 p-5 dark:border-zinc-800">
              <h3 className="font-semibold">{t.fitYes}</h3>
              <ul className="mt-3 space-y-2">
                {t.fitYesList.map((x) => (
                  <li key={x} className="flex gap-2">
                    <Check className="mt-1 h-4 w-4 shrink-0 text-emerald-600" aria-hidden />
                    <span>{x}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div className="rounded-xl border border-zinc-200 p-5 dark:border-zinc-800">
              <h3 className="font-semibold">{t.fitNo}</h3>
              <ul className="mt-3 space-y-2 text-zinc-600 dark:text-zinc-300">
                {t.fitNoList.map((x) => (
                  <li key={x} className="flex gap-2">
                    <Minus className="mt-1 h-4 w-4 shrink-0 text-zinc-400" aria-hidden />
                    <span>{x}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>

        {/* Features */}
        <section aria-labelledby="features" className="border-y border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900/40">
          <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
            <h2 id="features" className="max-w-2xl text-2xl font-semibold tracking-tight text-balance">
              {t.featuresTitle}
            </h2>
            <div className="mt-8 grid gap-x-8 gap-y-8 sm:grid-cols-2 lg:grid-cols-4">
              {t.features.map(([title, body], i) => {
                const Icon = FEATURE_ICONS[i]!;
                return (
                  <div key={title} className="min-w-0">
                    <span
                      className="flex h-10 w-10 items-center justify-center rounded-lg bg-white text-zinc-800 ring-1 ring-zinc-200 dark:bg-zinc-900 dark:text-zinc-100 dark:ring-zinc-800"
                      aria-hidden
                    >
                      <Icon className="h-5 w-5" />
                    </span>
                    <h3 className="mt-3 font-semibold">{title}</h3>
                    <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-300">{body}</p>
                  </div>
                );
              })}
            </div>
            <div className="mt-10 grid items-start gap-6 md:grid-cols-[minmax(0,420px)_1fr]">
              <img
                src="/landing/app-card.webp"
                alt=""
                width={576}
                height={380}
                loading="lazy"
                className="w-full rounded-xl border border-zinc-200 dark:border-zinc-800"
              />
              <div className="flex gap-3 self-center rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
                <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-brand-700 dark:text-brand-300" aria-hidden />
                <p className="text-zinc-700 dark:text-zinc-200">{t.faq[2]![1]}</p>
              </div>
            </div>
          </div>
        </section>

        {/* How it works */}
        <section aria-labelledby="steps" className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
          <h2 id="steps" className="text-2xl font-semibold tracking-tight">
            {t.stepsTitle}
          </h2>
          <ol className="mt-6 grid gap-4 md:grid-cols-3">
            {t.steps.map(([title, body], i) => (
              <li key={title} className="rounded-xl border border-zinc-200 p-5 dark:border-zinc-800">
                <span
                  className="flex h-8 w-8 items-center justify-center rounded-full bg-zinc-900 text-sm font-semibold text-white dark:bg-white dark:text-zinc-900"
                  aria-hidden
                >
                  {i + 1}
                </span>
                <h3 className="mt-3 font-semibold">{title}</h3>
                <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-300">{body}</p>
              </li>
            ))}
          </ol>
        </section>

        {/* Plans */}
        <section aria-labelledby="plans" className="border-y border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900/40">
          <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
            <h2 id="plans" className="text-2xl font-semibold tracking-tight">
              {t.plansTitle}
            </h2>
            <p className="mt-2 text-zinc-600 dark:text-zinc-300">{t.plansSub}</p>
            <div className="mt-6 grid gap-4 md:grid-cols-3">
              {t.plans.map(([name, price, cards], i) => (
                <div
                  key={name}
                  className={`flex flex-col rounded-xl border bg-white p-6 dark:bg-zinc-900 ${i === 0 ? 'border-zinc-900 dark:border-white' : 'border-zinc-200 dark:border-zinc-800'}`}
                >
                  <h3 className="font-semibold">{name}</h3>
                  <p className="mt-2 text-2xl font-semibold">{price}</p>
                  <p className="mt-1 text-zinc-600 dark:text-zinc-300">{cards}</p>
                  <div className="mt-6">
                    {i === 0 ? (
                      <Link to="/signup" className={`${btnPrimary} w-full`}>
                        {t.signUp}
                      </Link>
                    ) : (
                      <a href={`mailto:${SUPPORT.email}?subject=${encodeURIComponent(`Gift Card POS: ${name}`)}`} className={`${btnSecondary} w-full`}>
                        {t.contactUs}
                      </a>
                    )}
                  </div>
                </div>
              ))}
            </div>
            <p className="mt-4 text-sm text-zinc-500 dark:text-zinc-400">{t.plansAll}</p>
          </div>
        </section>

        <PrintSection lang={lang} btnPrimary={btnPrimary} btnSecondary={btnSecondary} />

        {/* FAQ */}
        <section aria-labelledby="faq" className="border-t border-zinc-200 dark:border-zinc-800">
          <div className="mx-auto max-w-3xl px-4 py-14 sm:px-6">
            <h2 id="faq" className="text-2xl font-semibold tracking-tight">
              {t.faqTitle}
            </h2>
            <div className="mt-6 divide-y divide-zinc-200 rounded-xl border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
              {t.faq.map(([q, a]) => (
                <details key={q} className="group px-5">
                  <summary className="flex min-h-[56px] cursor-pointer list-none items-center justify-between gap-4 font-semibold">
                    {q}
                    <span className="text-zinc-400 transition-transform group-open:rotate-45" aria-hidden>
                      +
                    </span>
                  </summary>
                  <p className="pb-5 text-zinc-600 dark:text-zinc-300">{a}</p>
                </details>
              ))}
            </div>
          </div>
        </section>

        {/* CTA */}
        <section className="border-t border-zinc-200 dark:border-zinc-800">
          <div className="mx-auto flex max-w-6xl flex-col items-start gap-5 px-4 py-14 sm:px-6 md:flex-row md:items-center md:justify-between">
            <div>
              <h2 className="text-2xl font-semibold tracking-tight">{t.ctaTitle}</h2>
              <p className="mt-1 text-zinc-600 dark:text-zinc-300">{t.ctaSub}</p>
            </div>
            <Link to="/signup" className={btnPrimary}>
              {t.signUp} <ArrowRight className="h-4 w-4" aria-hidden />
            </Link>
          </div>
        </section>
      </main>

      <footer className="border-t border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900/40">
        <div className="mx-auto grid max-w-6xl gap-4 px-4 py-8 text-sm text-zinc-600 sm:px-6 md:grid-cols-2 dark:text-zinc-300">
          <div>
            <p className="font-semibold text-zinc-900 dark:text-white">{t.questions}</p>
            <p className="mt-2 flex flex-wrap gap-x-5 gap-y-1">
              <span className="inline-flex items-center gap-1.5">
                <Mail className="h-4 w-4" aria-hidden />
                <a href={`mailto:${SUPPORT.email}`} className="underline-offset-2 hover:underline">
                  {SUPPORT.email}
                </a>
              </span>
              <span className="inline-flex items-center gap-1.5">
                <Phone className="h-4 w-4" aria-hidden />
                {t.hotline}:{' '}
                <a href={`tel:+1${SUPPORT.phone}`} className="tabular-nums underline-offset-2 hover:underline">
                  {SUPPORT.phoneDisplay}
                </a>
              </span>
            </p>
          </div>
          <div className="flex items-end gap-4 md:justify-end">
            <Link to="/login" className="underline-offset-2 hover:underline">
              {t.signIn}
            </Link>
            <Link to="/signup" className="underline-offset-2 hover:underline">
              {t.signUp}
            </Link>
            <span>© {new Date().getFullYear()} UniJV</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
